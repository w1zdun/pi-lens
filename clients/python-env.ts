/**
 * Python interpreter resolution for pi-lens's Python runners.
 *
 * The gap this module owns: a Python entry point never lives where the
 * Node-shaped resolvers look. `node_modules/.bin` and every package manager's
 * global bin dir (`findGlobalBinary`) are structurally incapable of holding
 * `pytest`, so `test-runner-client.ts` always fell through to its declarative
 * default — a bare `python -m pytest` against the SYSTEM interpreter, which on
 * a `.venv`/uv project has no pytest installed at all, and on a machine whose
 * `python` is still Python 2.7 runs the wrong interpreter outright.
 *
 * Resolution order under `auto` (the default):
 *   1. `python.testCommand` from `.pi-lens.json` — verbatim, no PATH probe
 *   2. `uv run --no-sync pytest`, for a uv-managed project whose environment
 *      already exists — uv, not a path guess, is the authority on which
 *      environment and which interpreter that project uses
 *   3. the active/declared venv's own `pytest` entry point
 *   4. that venv's `python -m pytest`
 *   5. `python3 -m pytest`
 *   6. `python -m pytest` — the old behavior, now last instead of only
 *
 * Two uv facts behind that ordering, both verified against a real uv 0.12.5
 * rather than from its docs (shape 16):
 *
 *   - Bare `uv run` SYNCS first, so it can install packages and reach the
 *     network. `--no-sync` suppresses that, and leaves `uv.lock` untouched
 *     (same hash and mtime across a run).
 *   - `--no-sync` is NOT inert, though: on a project with no environment it
 *     still CREATES the venv (it skips installing dependencies, not creating
 *     the environment), and then — finding no pytest in that empty env —
 *     silently runs whatever `pytest` is on PATH, exit code 0. On a machine
 *     whose `python` is still 2.7 that means pytest 4.6.11 under Python 2.7:
 *     the exact defect this module exists to fix, reintroduced through uv.
 *
 * Hence the gate in `uvWanted`: `auto` prefers uv for a uv-managed project,
 * but only once an environment exists for uv to use. An explicit
 * `interpreter: "uv"` is the user's own instruction and is honored without
 * that gate.
 *
 * Nothing here is memoized. Every answer is a live read of the environment,
 * PATH, and the filesystem, so a venv created — or a config edited — mid-session
 * is picked up on the next run instead of being latched for the process's
 * lifetime (shape 17), and the cost is a handful of `stat`s rather than a
 * `which` spawn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadPiLensProjectConfig,
	type PiLensProjectPythonConfig,
	type PythonInterpreterMode,
} from "./project-lens-config.js";

/** Which step of the chain produced the command — logged, and asserted in tests. */
export type PythonExecSource =
	| "config-command"
	| "venv-bin"
	| "venv-python"
	| "uv"
	| "python3"
	| "python";

export interface PythonExec {
	command: string;
	args: string[];
	source: PythonExecSource;
}

export interface PytestExecRequest {
	/** Project root the run happens in. */
	cwd: string;
	/** Absolute path of the test file — also the anchor of the venv search. */
	testFile: string;
	/** argv after the interpreter prefix: the test file plus pytest's own flags. */
	tailArgs: string[];
}

/** The two directory names every Python tool in this repo already looks for. */
const VENV_DIR_NAMES = [".venv", "venv"];

/**
 * How far above the test file's own directory a venv search may walk, so a
 * monorepo package's `services/api/.venv` is still found from
 * `services/api/tests/deep/test_thing.py`. The walk also stops at the project
 * root, so a stray venv in an ancestor of the project is never adopted.
 */
const MAX_VENV_WALK_UP = 6;

/**
 * Directories to look for a venv in, nearest the test file first, ending at the
 * project root. The root is always included: an anchor outside `cwd` (or deeper
 * than the bound) must not cost the project its own venv.
 */
function venvSearchDirs(cwd: string, anchorDir: string): string[] {
	const root = path.resolve(cwd);
	const dirs: string[] = [];
	let dir = path.resolve(anchorDir);
	for (let level = 0; level <= MAX_VENV_WALK_UP; level++) {
		dirs.push(dir);
		if (dir === root) return dirs;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	dirs.push(root);
	return dirs;
}

/** Names the OS would accept for `binary`, in preference order. */
function executableNames(binary: string): string[] {
	return process.platform === "win32"
		? [`${binary}.exe`, `${binary}.cmd`, `${binary}.bat`, binary]
		: [binary];
}

/** An existing regular file the OS would actually agree to execute. */
function isExecutableFile(candidate: string): boolean {
	try {
		if (!fs.statSync(candidate).isFile()) return false;
	} catch {
		return false;
	}
	// Windows has no exec bit — `X_OK` there only re-checks existence, and it is
	// the PATHEXT-suffixed name that makes a file runnable. On POSIX the bit is
	// the whole question: a non-executable `.venv/bin/pytest` fails at spawn
	// with EACCES, which reads as "pytest is broken" rather than "pytest is not
	// here" (shape 10).
	if (process.platform === "win32") return true;
	try {
		fs.accessSync(candidate, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** `binary` inside one explicit venv root, or null. */
function venvBinary(venvRoot: string, binary: string): string | null {
	const binDir = path.join(
		venvRoot,
		process.platform === "win32" ? "Scripts" : "bin",
	);
	for (const name of executableNames(binary)) {
		const candidate = path.join(binDir, name);
		if (isExecutableFile(candidate)) return candidate;
	}
	return null;
}

/**
 * Candidate venv roots, most authoritative first: the environment pi-lens was
 * launched in (`VIRTUAL_ENV`, then `CONDA_PREFIX` — the same two variables in
 * the same order the Python LSP resolves with, `clients/lsp/server.ts`), then
 * `.venv`/`venv` on disk from the test file's directory up to the project root.
 */
export function venvRootCandidates(cwd: string, anchorDir: string): string[] {
	const roots: string[] = [];
	for (const key of ["VIRTUAL_ENV", "CONDA_PREFIX"]) {
		const declared = process.env[key];
		if (declared) roots.push(declared);
	}
	// uv's own override for where the project environment lives. Resolved
	// against the project root when relative, which is how uv reads it. Without
	// this, a project that moves its environment off `.venv` looks environment-
	// less, and `auto` would decline to use uv for the very project that
	// configured uv most deliberately.
	const uvEnv = process.env.UV_PROJECT_ENVIRONMENT;
	if (uvEnv) roots.push(path.resolve(cwd, uvEnv));
	for (const dir of venvSearchDirs(cwd, anchorDir)) {
		for (const name of VENV_DIR_NAMES) roots.push(path.join(dir, name));
	}
	return roots;
}

/** The first `binary` found in any venv this project could be using, or null. */
export function findVenvBinary(
	binary: string,
	cwd: string,
	anchorDir: string = cwd,
): string | null {
	for (const root of venvRootCandidates(cwd, anchorDir)) {
		const found = venvBinary(root, binary);
		if (found) return found;
	}
	return null;
}

/**
 * `binary` on PATH, or null — a synchronous, cache-free scan.
 *
 * Deliberately not `findCommandAsync`/`isCommandAvailableAsync`
 * (`safe-spawn.ts`): those spawn `which`/`where`, and this runs on every test
 * run and inside the SYNCHRONOUS `detectRunner`. A dozen `stat`s beat a
 * process, and reading PATH live on each call keeps the answer honest with no
 * latch to reset at `session_start` (shape 17). The Windows candidate list is
 * the PATHEXT subset that can hold an interpreter shim, not all of PATHEXT.
 */
export function findOnPath(binary: string): string | null {
	for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!entry) continue;
		for (const name of executableNames(binary)) {
			const candidate = path.join(entry, name);
			if (isExecutableFile(candidate)) return candidate;
		}
	}
	return null;
}

/** `uv.lock` or a `[tool.uv]` table — the markers a uv-managed project carries. */
export function isUvManagedProject(dir: string): boolean {
	if (fs.existsSync(path.join(dir, "uv.lock"))) return true;
	try {
		return fs
			.readFileSync(path.join(dir, "pyproject.toml"), "utf-8")
			.includes("[tool.uv]");
	} catch {
		return false;
	}
}

/**
 * A dependency entry that IS pytest (or a `pytest-*` plugin, which implies it),
 * in the spellings the ecosystem actually uses: PEP 735 `[dependency-groups]`,
 * PEP 621 `[project.optional-dependencies]`, a plain `dependencies` array
 * (multi-line or inline), poetry's `pytest = "^8"`, and pdm's dev groups.
 *
 * Anchored on an entry BOUNDARY — start of line, or an opening `[`/`{`/`,` —
 * so a name that merely contains the word is not evidence: `"pytest_stub"` in a
 * ruff exclude list, `"some-pytest-helper"`, or a `"pytest/**"` glob key all
 * fail to match.
 */
const PYTEST_DEPENDENCY_ENTRY =
	/(?:^|[[{,]\s*)["']?pytest(?:[-[\]<>=~!,"'\s]|$)/m;

/** Whether a `pyproject.toml`'s text is evidence that this project uses pytest. */
export function pyprojectDeclaresPytest(text: string): boolean {
	return (
		text.includes("[tool.pytest.ini_options]") ||
		PYTEST_DEPENDENCY_ENTRY.test(text)
	);
}

/**
 * The path of the nearest `pyproject.toml` that says this project uses pytest,
 * or null. Searched over the same bounded, project-root-capped directory list
 * as the venv probe, so a monorepo package's own `pyproject.toml` is found from
 * a source file nested under it.
 */
export function findPyprojectDeclaringPytest(
	cwd: string,
	anchorDir: string = cwd,
): string | null {
	for (const dir of venvSearchDirs(cwd, anchorDir)) {
		const candidate = path.join(dir, "pyproject.toml");
		try {
			if (pyprojectDeclaresPytest(fs.readFileSync(candidate, "utf-8"))) {
				return candidate;
			}
		} catch {
			// No pyproject.toml in this directory, or it is unreadable — keep walking.
		}
	}
	return null;
}

/**
 * Whether this run should go through `uv run`.
 *
 * An explicit `interpreter: "uv"` is an instruction and needs no evidence. For
 * `auto` the project must both DECLARE uv and already HAVE an environment: see
 * the module comment for why an environment-less `uv run --no-sync` is worse
 * than not using uv at all (it creates an empty venv, then silently falls back
 * to a PATH pytest that can be the wrong interpreter entirely).
 */
function uvWanted(
	mode: PythonInterpreterMode,
	cwd: string,
	anchorDir: string,
): boolean {
	if (mode === "uv") return true;
	if (!venvSearchDirs(cwd, anchorDir).some((dir) => isUvManagedProject(dir))) {
		return false;
	}
	return findVenvBinary("python", cwd, anchorDir) !== null;
}

function projectPythonConfig(cwd: string): PiLensProjectPythonConfig {
	return loadPiLensProjectConfig(cwd).python ?? {};
}

/**
 * The command and argv that should run pytest for `testFile`.
 *
 * Synchronous on purpose: `detectRunner` shares these helpers from a sync path,
 * and every step is a filesystem or environment read.
 */
export function resolvePytestExec(request: PytestExecRequest): PythonExec {
	const { cwd, testFile, tailArgs } = request;
	const config = projectPythonConfig(cwd);

	// An explicit command is the user's own instruction: used verbatim, with no
	// venv probe and no PATH resolution behind their back.
	if (config.testCommand && config.testCommand.length > 0) {
		const [command, ...prefix] = config.testCommand;
		return {
			command,
			args: [...prefix, ...tailArgs],
			source: "config-command",
		};
	}

	const mode = config.interpreter ?? "auto";
	const anchorDir = path.dirname(path.resolve(testFile));

	// uv goes FIRST for a uv-managed project. Running `.venv/bin/pytest`
	// directly is a guess at a path; `uv run` asks the tool that owns the
	// project which environment and interpreter to use — workspace members, a
	// relocated `UV_PROJECT_ENVIRONMENT`, and `requires-python` all resolve the
	// way the project declares rather than the way a directory name suggests.
	if (mode === "auto" || mode === "uv") {
		const uv = uvWanted(mode, cwd, anchorDir) ? findOnPath("uv") : null;
		if (uv) {
			return {
				command: uv,
				args: ["run", "--no-sync", "pytest", ...tailArgs],
				source: "uv",
			};
		}
	}

	if (mode === "auto" || mode === "venv") {
		const venvPytest = findVenvBinary("pytest", cwd, anchorDir);
		if (venvPytest) {
			return { command: venvPytest, args: tailArgs, source: "venv-bin" };
		}
		// A venv without a `pytest` console script can still import it, and its
		// interpreter is in any case a better guess than the system one.
		const venvPython = findVenvBinary("python", cwd, anchorDir);
		if (venvPython) {
			return {
				command: venvPython,
				args: ["-m", "pytest", ...tailArgs],
				source: "venv-python",
			};
		}
	}

	const python3 = findOnPath("python3");
	if (python3) {
		return {
			command: python3,
			args: ["-m", "pytest", ...tailArgs],
			source: "python3",
		};
	}
	// Last resort. Left unresolved when PATH has no `python` either, so the
	// spawn's ENOENT names the binary the user is missing rather than a path
	// pi-lens invented.
	return {
		command: findOnPath("python") ?? "python",
		args: ["-m", "pytest", ...tailArgs],
		source: "python",
	};
}

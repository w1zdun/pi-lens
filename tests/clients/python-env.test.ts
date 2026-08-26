import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findOnPath,
	findVenvBinary,
	isUvManagedProject,
	pyprojectDeclaresPytest,
} from "../../clients/python-env.js";
import { setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

function tempProject(): string {
	const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-python-env-");
	cleanups.push(cleanup);
	return tmpDir;
}

/**
 * The dependency-entry probe decides whether a Python project is a pytest
 * project at all, so both directions matter: a missed declaration means the
 * runner never fires, and a spurious one means pi-lens runs pytest against a
 * project that never asked for it.
 */
describe("pyprojectDeclaresPytest", () => {
	const positives: Array<[string, string]> = [
		[
			"PEP 735 dependency-groups (uv's default)",
			'[dependency-groups]\ndev = [\n    "pytest>=8.0.0",\n]\n',
		],
		[
			"PEP 621 optional-dependencies",
			'[project.optional-dependencies]\ntest = ["pytest", "coverage"]\n',
		],
		[
			"inline runtime dependencies array",
			'dependencies = ["httpx", "pytest"]\n',
		],
		[
			"poetry dev group",
			'[tool.poetry.group.dev.dependencies]\npytest = "^8.0"\n',
		],
		[
			"pdm inline dev table",
			'[tool.pdm.dev-dependencies]\ntest = {pytest = "*"}\n',
		],
		[
			"a pytest plugin implies pytest",
			'[dependency-groups]\ndev = ["pytest-cov>=5"]\n',
		],
		[
			"ini_options with no dependency list",
			"[tool.pytest.ini_options]\naddopts = '-q'\n",
		],
	];

	for (const [label, text] of positives) {
		it(`accepts ${label}`, () => {
			expect(pyprojectDeclaresPytest(text)).toBe(true);
		});
	}

	const negatives: Array<[string, string]> = [
		[
			"a project that never mentions pytest",
			"[project]\nname = 'demo'\ndependencies = ['httpx']\n",
		],
		[
			"a file path that merely contains the word",
			'[tool.ruff]\nexclude = ["pytest_stub.py"]\n',
		],
		[
			"a differently-named package containing the word",
			'dependencies = ["some-pytest-helper"]\n',
		],
		[
			"a per-file-ignores glob key",
			'[tool.ruff.lint.per-file-ignores]\n"pytest/**" = ["S101"]\n',
		],
	];

	for (const [label, text] of negatives) {
		it(`rejects ${label}`, () => {
			expect(pyprojectDeclaresPytest(text)).toBe(false);
		});
	}
});

describe("isUvManagedProject", () => {
	it("accepts a uv.lock", () => {
		const root = tempProject();
		fs.writeFileSync(path.join(root, "uv.lock"), "version = 1\n");
		expect(isUvManagedProject(root)).toBe(true);
	});

	it("accepts a [tool.uv] table with no lockfile", () => {
		const root = tempProject();
		fs.writeFileSync(
			path.join(root, "pyproject.toml"),
			"[project]\nname = 'demo'\n\n[tool.uv]\npackage = false\n",
		);
		expect(isUvManagedProject(root)).toBe(true);
	});

	it("rejects a plain Python project", () => {
		const root = tempProject();
		fs.writeFileSync(
			path.join(root, "pyproject.toml"),
			"[project]\nname = 'demo'\n",
		);
		expect(isUvManagedProject(root)).toBe(false);
	});
});

describe("venv and PATH probes", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of ["PATH", "Path", "VIRTUAL_ENV", "CONDA_PREFIX"]) {
			savedEnv[key] = process.env[key];
		}
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	function venvBinDir(root: string, dirName: string): string {
		const binDir = path.join(
			root,
			dirName,
			process.platform === "win32" ? "Scripts" : "bin",
		);
		fs.mkdirSync(binDir, { recursive: true });
		return binDir;
	}

	function binaryName(name: string): string {
		return process.platform === "win32" ? `${name}.exe` : name;
	}

	it("does not accept a venv entry point that is not executable", () => {
		const root = tempProject();
		delete process.env.VIRTUAL_ENV;
		delete process.env.CONDA_PREFIX;
		const binDir = venvBinDir(root, ".venv");
		fs.writeFileSync(path.join(binDir, binaryName("pytest")), "", {
			mode: 0o644,
		});

		// Windows has no exec bit, so there the file IS runnable and the probe
		// must accept it — the assertion tracks the platform's own rule rather
		// than pinning one platform's answer on both.
		const expected =
			process.platform === "win32"
				? path.join(binDir, binaryName("pytest"))
				: null;
		expect(findVenvBinary("pytest", root)).toBe(expected);
	});

	it("does not mistake a directory for a binary", () => {
		const root = tempProject();
		delete process.env.VIRTUAL_ENV;
		delete process.env.CONDA_PREFIX;
		const binDir = venvBinDir(root, ".venv");
		fs.mkdirSync(path.join(binDir, binaryName("pytest")));

		expect(findVenvBinary("pytest", root)).toBeNull();
	});

	it("reads PATH live rather than latching the first answer", () => {
		const root = tempProject();
		const binDir = path.join(root, "late-bin");
		fs.mkdirSync(binDir, { recursive: true });
		process.env.PATH = binDir;

		expect(findOnPath("pi-lens-fake-tool")).toBeNull();

		const created = path.join(binDir, binaryName("pi-lens-fake-tool"));
		fs.writeFileSync(created, "", { mode: 0o755 });

		// A tool installed mid-session must be visible on the next call — the
		// reason this probe has no memo to reset at session_start.
		expect(findOnPath("pi-lens-fake-tool")).toBe(created);
	});
});

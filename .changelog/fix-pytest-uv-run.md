---
section: Changed
audience: user
area: runners
---

- **pytest in a uv project runs through `uv run --no-sync`.** When the project has a `uv.lock` and the environment uv would pick already exists, pi-lens runs `uv run --no-sync --project <root> python -m pytest` instead of calling the interpreter path directly. If that environment has no pytest, the run fails rather than borrowing a `pytest` from PATH. Without `uv` on PATH, or for a project with no `uv.lock`, nothing changes.

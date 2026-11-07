## Agent skills

### Mandatory repository startup gate

- At the start of every fresh repository task/session, resolve the Git root and read this root `AGENTS.md` before repository exploration or edits. Then run `node scripts/agent-instructions-preflight.mjs --target <deepest-target-directory> --format=json` and use the returned `content` as the effective instruction bundle for that target. For tasks spanning multiple directory scopes, run preflight for each relevant target directory. See `docs/agents/agent-instructions-preflight.md` for runner integration.
- Read applicable `AGENTS.override.md` and nested `AGENTS.md` files from the Git root to the target file's directory. Where a same-directory override exists, apply it instead of that directory's regular `AGENTS.md`.
- If the agent host does not automatically discover `AGENTS.md`, use its file-read tool explicitly. Never assume a linked document was loaded merely because this file points to it.
- For multi-part engineering work, also read `docs/agents/complex-engineering-loop.md`; read other linked skills/domain docs when their scope applies.
- Record the exact instruction paths and SHA-256 values from the preflight output in the task's internal handoff. If preflight fails, an instruction file cannot be read, the repository root is ambiguous, or instructions conflict, stop repository work and report the blocker.
- Re-read instructions when starting a new task/session or when an instruction file changes during the task.

### Mandatory CodeGraph source-query gate

- Before every repository source query or source retrieval, run `codegraph sync` from the Git root and require a successful completion with the index up to date. Do not query a stale index.
- Use CodeGraph for source discovery and impact queries: `query`, `explore`, `context`, `node`, `callers`, `callees`, `impact`, `affected`, and `files`. This applies to symbol, call-path, import/dependency, behavior, and test-discovery questions.
- After changing source files, run `codegraph sync` again before the next source query. A previous sync does not cover later edits.
- CodeGraph indexes source code, not every Markdown/configuration file. Read an exact, already-identified documentation or configuration path directly when it is outside the index; do not use direct text search as a substitute for source discovery. If CodeGraph is unavailable or sync fails, stop source-query work and report the blocker instead of silently falling back to grep/rg/find.

### Complex engineering loop

For multi-part repository issues, follow `docs/agents/complex-engineering-loop.md`. Use hierarchical lead ownership, bounded task contracts, least-privilege specialist agents, test-first execution, and independent verification. This is an engineering operating procedure, not a new Runalith runtime coordinator.

### Issue tracker

GitHub Issues in `nplongx/runalith`, operated through the `gh` CLI. Pull requests are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout using root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

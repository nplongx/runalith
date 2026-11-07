# Agent instruction preflight

`scripts/agent-instructions-preflight.mjs` resolves the effective instruction chain for one repository target and emits both the full instruction content and provenance. It is a bootstrap component for agent runners; it does not itself call a model.

## Run

From the repository root:

```bash
node scripts/agent-instructions-preflight.mjs --target src/runtime --format=json
```

Use the deepest directory containing files the task may inspect or modify. If a task spans multiple directories with different nested instructions, run preflight for each target directory and merge the returned instruction chains in root-to-target order, without duplicating shared sources.

## Source discovery with CodeGraph

Before each source-code query or source retrieval, run `codegraph sync` from the Git root and wait for a successful result showing the index is up to date. Use CodeGraph (`query`, `explore`, `context`, `node`, `callers`, `callees`, `impact`, `affected`, and `files`) for symbol, call-path, dependency, implementation, and test-discovery questions. After source edits, sync again before querying the source. CodeGraph does not index every Markdown or configuration file; read an exact, already-identified unindexed documentation/configuration path directly. If sync or CodeGraph is unavailable, stop source-query work and report the blocker rather than silently falling back to text search.

## Automatic-send check integration

When the Chat On Steroids automatic-send hook is configured to call `http://127.0.0.1:18746/check`, the local `scripts/cos-automatic-send-check.mjs` service applies an additional fail-closed gate on every `POST /check`:

1. Resolve the effective instruction bundle for the selected repository and target.
2. Require instructions that explicitly say to run `codegraph sync` before every source query/retrieval, sync again after source edits before the next query, and stop when CodeGraph is unavailable or sync fails.
3. Run `codegraph sync` with the selected repository Git root as the working directory. The command has a 30-second timeout and bounded output.
4. Return `allow: true` only when both instruction validation and CodeGraph sync succeed. A missing/incomplete rule, missing CLI, timeout, spawn error, signal, or non-zero exit returns `allow: false`.

The endpoint runs a fresh sync for each automatic-send check. That initial sync does not replace the instruction to sync again after later source edits and immediately before each subsequent source query. The server binds to loopback only. Keep the CoS hook configured to use the exact `POST /check` endpoint; `GET /health` is liveness only and never authorizes a send. A passing endpoint check is not workflow approval, tool authorization, or production readiness evidence.

The check service's unit test injects a deterministic CodeGraph command result so CI does not need the developer's local CodeGraph installation. The real default path still executes the fixed `codegraph sync` command directly, without a shell, in the selected Git root.

The command emits JSON with:

- `gitRoot` and `targetDirectory` — resolved scope;
- `instructions[]` — ordered global/project sources, path, scope, byte length, SHA-256 and exact content;
- `content` — concatenated effective instructions for model-context injection;
- `combinedBytes` and `combinedSha256` — provenance of the combined content.

The loader follows the primary Codex `AGENTS.md` discovery model: optional `$CODEX_HOME` (default `~/.codex`) global instruction, then one non-empty project instruction per directory from Git root to target. `AGENTS.override.md` wins over `AGENTS.md` within the same directory; an empty override is skipped. This repository loader intentionally handles the two standard filenames only; it does not parse custom `project_doc_fallback_filenames` from `config.toml`.

The default combined-content limit is 32 KiB. Unlike silent truncation, this loader fails when the selected bundle exceeds its limit. It also fails closed for a missing root instruction, unreadable instruction file, a target outside the Git root, or an instruction symlink escaping its global/project scope.

## Runner integration contract

The runner must execute the preflight **before the model request**, parse the JSON, and insert `content` into the model's system/developer instruction context. It must abort the run when the command exits non-zero or JSON parsing fails. Recording the hash without injecting `content` is not sufficient.

Generic adapter pseudocode:

```js
const result = spawnSync(process.execPath, [
  path.join(repositoryRoot, 'scripts/agent-instructions-preflight.mjs'),
  '--target', targetDirectory,
  '--format=json'
], { cwd: repositoryRoot, encoding: 'utf8' });

if (result.status !== 0) throw new Error(`agent preflight failed: ${result.stderr}`);
const bundle = JSON.parse(result.stdout);
if (!bundle.content || !bundle.instructions?.length) {
  throw new Error('agent preflight returned an empty instruction bundle');
}

// Add bundle.content to the runner's system/developer instructions before
// creating the model request. Preserve bundle.instructions hashes in logs.
```

This repository exposes the loader, regression tests, and a loopback automatic-send check service. The active ChatGPT connector used for this session does not expose a model-start hook that this repository can configure. The service enforces its contract only when the host's automatic-send hook actually calls it; its existence or a healthy `/health` response is not proof that every external host path is wired to it. A host-level adapter is still required for unconditional pre-model enforcement.

## Check

```bash
node --test tests/test-agent-instructions-preflight.mjs
node --test tests/test-cos-automatic-send-check.mjs
node scripts/agent-instructions-preflight.mjs --target src/runtime --format=json
```

The regression test covers global/project precedence, nested overrides, empty-file fallback, target containment, symlink escape rejection, size bounds, missing root instructions and CLI JSON output.

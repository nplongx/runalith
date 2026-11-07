# Contributing

Thanks for helping improve Runalith.

## Development setup

- Node.js **22.13 or newer** and npm. CI validates Node.js 22 and 24.
- npm from the selected Node.js installation.
- `tmux` only for tests or workflows that exercise deterministic local execution.

```bash
git clone https://github.com/nplongx/runalith.git
cd runalith
npm ci
npm test
```

## Before opening a pull request

Run the checks relevant to your change. For a workflow-plan, artifact, MCP surface, or subsystem-boundary change, start with:

```bash
npm run test:protocol
npm run test:workflow-m4
npm run test:workflow-state-port
npm run test:public-subsystem-alignment
npm test
git diff --check
```

For execution, lease, filesystem, recovery, or package changes, also run the corresponding focused tests under `tests/`. Do not claim a check passed unless you ran it and observed a successful exit status. Mention tests that could not be run and the reason.

## Source discovery

Use CodeGraph for repository source queries and retrieval. Before **every** source query, run `codegraph sync` from the Git root and require success with the index up to date. Then use `codegraph query`, `explore`, `context`, `node`, `callers`, `callees`, `impact`, `affected`, or `files` as appropriate. After changing source files, sync again before the next source query. CodeGraph does not index every Markdown/configuration file; read an exact, already-identified unindexed path directly. If CodeGraph or sync is unavailable, stop source-query work and report the blocker; do not silently replace it with grep/rg/find. See [agent instruction preflight](docs/agents/agent-instructions-preflight.md) for the repository's agent bootstrap contract.

For user-visible or architectural changes, update the canonical documentation page and the [documentation index](docs/README.md). Follow the [documentation rewrite workflow](docs/DOCUMENTATION_WORKFLOW.md) and [terminology guide](docs/TERMINOLOGY.md) to choose the page type, verify claims against code and tests, preserve compatibility identifiers, and check links. If an MCP tool/schema changes, regenerate the [MCP tool reference](docs/MCP_REFERENCE.md) with `npm run docs:generate-reference` and review the diff. Diagrams are optional supporting material; GitHub-renderable Markdown or static PNGs are preferred over standalone HTML.

Before opening a documentation-only pull request, run:

```bash
npm run docs:check
npm run site:check
git diff --check
```

`docs:check` validates Markdown links, anchors, generated MCP-reference parity, and documentation constraints. `site:check` verifies generated Pages output against its template and current package/reference inputs. Neither check substitutes for a focused product test when documentation describes changed runtime behavior.

## Safety and evidence

- Keep changes scoped to the intended feature. Avoid unrelated reformatting and generated snapshots.
- Never commit credentials, `.env` files, personal/customer data, live SQLite databases, runtime logs, `dist/` bundles, or execution/benchmark evidence containing local paths or identifiers.
- Use disposable temporary directories and synthetic fixtures for tests. Do not use the live runtime database or a real workspace as a test fixture.
- Do not run live provider dispatch or a benchmark scenario as part of a unit test. External side effects require explicit authorization and should be tested separately.
- Preserve existing approval, lease, result, artifact-lineage, and recovery safeguards. Missing or ambiguous evidence must remain blocked/unverified rather than being upgraded to success.
- Candidate packages are not releases. Do not overwrite frozen artifacts or alter official authorization/audit records to make a check pass.

## Pull request expectations

Describe the behavior changed and why, summarize compatibility/security implications, list exact tests run, and document known limitations. Include a test for each bug fix where practical. Keep changes reviewable and do not bundle unrelated example applications with the orchestrator runtime.

By submitting a contribution, you agree that it will be distributed under the repository's MIT license.

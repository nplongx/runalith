# Call MCP tools directly from a `.mcpb` bundle

`scripts/mcpb-tools.mjs` launches the bundled MCP server without installing the bundle into Chat On Steroids. It reads the archive, extracts it to a private temporary directory, starts the exact packaged `server/index.js`, performs MCP `initialize` and `tools/list`, then either lists tools or calls one. The server process and temporary directory are removed at the end of each invocation.

## List tools

```sh
npm run mcpb:tools -- /absolute/path/to/candidate.mcpb list
npm run mcpb:tools -- /absolute/path/to/candidate.mcpb list --json
```

The normal output shows tool names, required arguments, available argument fields and a short description. `--json` prints full tool metadata and input schemas.

## Call a tool

```sh
npm run mcpb:tools -- /absolute/path/to/candidate.mcpb call orchestrator_health
npm run mcpb:tools -- /absolute/path/to/candidate.mcpb call workflow_catalog '{"query":"engineering"}'
npm run mcpb:tools -- /absolute/path/to/candidate.mcpb call adaptive_goal_graph_search @./request.json
```

Omitting arguments sends `{}`. Arguments must parse as a JSON object; use `@file.json` for larger inputs. The CLI prints the raw MCP tool result as JSON. If the tool returns `isError: true`, one-shot `call` exits with status 2. `--timeout-ms N` configures the timeout for each MCP request (500–120000 ms). A timeout kills the MCP server process rather than allowing an unobserved late result to mutate session state.

Use `shell` for multi-step probes that must share state within one process and temporary database. Commands: `:list`, `:list --json`, `:describe <tool>`, `call <tool> [JSON arguments | @file.json]`, and `:quit`. Example input: `call orchestrator_health` then `:quit`. Calls in one shell share the same MCP process and its SQLite/workspace state; state is discarded when the shell exits. Separate CLI invocations get fresh isolated state. Shell enforces a 200-call limit.

## Isolation and limits

Each command starts a fresh process with a minimal environment and private temporary `HOME`, `TMPDIR`, data directory, SQLite database, workspace and execution temp directory. It does not inherit API keys, provider credentials or arbitrary shell environment variables, and does not write to the active plugin's installation. The temporary workspace/database are removed on exit, so state is not shared between separate CLI invocations. On POSIX systems the server starts in its own process group; shutdown attempts graceful exit, then signals the process group with `SIGTERM` and `SIGKILL` as needed, including when the group leader exits before a child process. If shutdown does not settle within the bounded wait, the CLI emits a cleanup warning. On Windows the current implementation terminates the server process directly and does not guarantee descendant-process cleanup.

This is **not an OS sandbox**. The bundle's JavaScript runs as the current user. A tool may have effects beyond the temporary database/workspace if its implementation or arguments explicitly target external resources, call external services, or execute system commands. Only run bundles from trusted sources. Inspect the tool schema/description before calling state-changing tools. The CLI starts with a minimal environment (does not inherit API keys or provider credentials), validates JSON arguments against the advertised JSON Schema subset (types, required/properties, additionalProperties, enum, string/number bounds, arrays, allOf/anyOf/oneOf), caps argument payloads at 1 MiB, individual responses at 8 MiB, archive at 512 MiB/256 MiB unpacked/2000 entries, and rejects path traversal, duplicate entries, file/directory prefix conflicts, links and special files. It parses raw ZIP central-directory filename bytes before using `unzip`'s display listing, so escaped control characters cannot evade validation; multi-disk and ZIP64 archives are rejected. It also rejects control characters, paths over 4096 UTF-8 bytes, trailing-dot/space components, and path collisions after Unicode compatibility normalization and case-fold-like expansion (including multi-character folds and final Greek sigma). This portable key is a conservative guard, not a promise of identical filesystem semantics on every OS. MCP stdout must be newline-delimited JSON-RPC; non-JSON output is treated as protocol failure. Tool names/descriptions with side-effect-like terms are blocked by default. `--allow-tool NAME` explicitly permits a named tool; `--allow-side-effects` disables the heuristic. These are operator guardrails, **not containment**: explicit flags do not make an untrusted bundle safe. The CLI does not install, restart, deploy or publish the bundle; it also does not bypass the tool's own authorization gates. Timeouts stop the local MCP process/group but cannot roll back already-committed SQLite rows or external side effects that happened before termination.

The implementation is intended for this repository's Node-based MCPB contract (`server/index.js`, Node launch configuration and ES module package). The isolated test bundle covers shared state across shell calls, JSON schema errors, tool/RPC errors, timeout, process crash, POSIX descendant-process cleanup, secret/environment isolation, path traversal, NFC/case-fold aliases, file/directory prefix conflicts, control characters, overlong and trailing-dot/space paths, duplicate entries, symlinked bundle files, archive links and invalid manifest entry points. It rejects unsafe ZIP paths and links, duplicate ZIP entries, oversized archives, invalid manifests and unsupported entry points before launch. It is a direct local caller, not a general-purpose remote MCP client or persistent session manager. Tool calls are not transactional: if a timed-out tool already performed external side effects, killing the process cannot roll them back.

## Reproducing failures safely

1. Use a trusted local candidate path and record its SHA-256: `sha256sum candidate.mcpb`.
2. Start with `list --json` and inspect the exact tool schema.
3. Reproduce one request with `call ... --timeout-ms 5000`; save stdout/stderr and exit status. Do not include credentials in argument files or bug reports.
4. For state-dependent failures, use `shell` and run the minimal sequence in one process; note that this session uses a temporary database/workspace and is removed on exit.
5. For a policy-blocked tool, inspect it first and pass `--allow-tool NAME` only for the exact tool being tested. Avoid `--allow-side-effects` unless required and authorized.
6. Verify cleanup by checking that no `mcpb-direct-tools-*` temporary directory from the completed invocation remains. Do not inspect, mutate, or clean the active plugin's directory or shared workflow database as part of this test.

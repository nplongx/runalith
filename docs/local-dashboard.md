# Local monitoring dashboard

The Runalith dashboard is an optional, local-only, read-only web interface for inspecting the runtime's existing SQLite records. It runs as a separate process from the MCP stdio server, does not create a second workflow database, and does not expose workflow approval, dispatch, retry, or mutation operations.

The dashboard is a separate process and opens the workflow database read-only. See the [architecture explanation](architecture.md#dashboard) for its trust boundary and the [static architecture illustrations](diagrams/README.md) for a supplementary overview.

## Start and configure

From the repository root, run:

```bash
npm run dashboard
```

The server prints its URL and database path. The default URL is `http://127.0.0.1:8318`. Stop it with `Ctrl+C`.

| Environment variable | Purpose | Default / accepted values |
|---|---|---|
| `RUNALITH_DATA_DIR` | Internal workflow data directory and default database location | `~/.runalith/agent-orchestrator` on new installs; an existing data directory is preserved automatically |
| `RUNALITH_DASHBOARD_FILES_ROOT` | Root browsed by Local files Explorer | Current working directory when launched from the workspace root; set an absolute path to browse elsewhere |
| `CHAT_ON_STEROIDS_DASHBOARD_FILES_ROOT` | Compatibility alias for the Explorer root | Used when `RUNALITH_DASHBOARD_FILES_ROOT` is unset |
| `RUNALITH_WORKFLOW_DB` | SQLite database path | `workflow.db` under the resolved data directory; omit to use the default |
| `RUNALITH_DASHBOARD_PORT` | HTTP port | `8318` |
| `RUNALITH_DASHBOARD_HOST` | Listener address | `127.0.0.1` or `::1` only |

The host is deliberately restricted to loopback. A non-loopback host value is rejected instead of exposing the dashboard on a LAN or public interface. If another process uses the default port, select an unused port using `RUNALITH_DASHBOARD_PORT`.

## What it shows

- **Overview:** workflow/task counts, recent activity, runtime/database health, and a *Needs attention* queue.
- **AGG Graph and planner runs:** inspect persisted Adaptive Goal Graph nodes, typed relations, goal memberships, revision hashes, evidence references, provenance and recent ledger activity. Inspect durable search invocation history, observed step timeline, metrics returned by the algorithm, failures, candidate summaries and the graph/evidence snapshot linked to each run. Cross-goal membership is a reuse signal, not proof of savings or trust.
- **Workflows:** filter and inspect workflow status, phase, progress, tasks, approvals, transitions, results, artifacts, and reports.
- **Roles & skills:** inspect custom-role versions, attached Agent Skills snapshots and hashes, exact role-version pins in custom workflows, and opt-in custom profile overlays proposed for built-in `standard-engineering` specialist tasks. Built-in runtime roles remain fixed contracts.
- **Batch execution:** inspect durable `execution_batches` and `execution_batch_items` separately from individual task-level `ExecutionManager` records. An individual execution does not become a batch merely because it completed successfully.
- **Event stream and artifacts:** search recorded events and inspect bounded artifact metadata/content previews.
- **File explorer:** list and preview approved text/log files under the configured workspace root. The browse root is separate from the internal workflow database directory; by default, `npm run dashboard` browses the current working directory. Set `RUNALITH_DASHBOARD_FILES_ROOT` (or the `CHAT_ON_STEROIDS_DASHBOARD_FILES_ROOT` compatibility alias) to pin a different root.

The global search is for workflows; events, artifacts, the knowledge graph and planner-run history have dedicated filters. The page refreshes automatically every 20 seconds while visible. The selected run inspector refreshes live while a run remains non-terminal. Refresh controls briefly indicate an in-flight snapshot and expose last-sync/error state without discarding the last successful snapshot. Main navigation uses a stable dashboard-first sidebar and content canvas; editor tabs, activity rail and persistent bottom panel are hidden from the primary workflow. Explorer and Git inspection remain contextual, read-only utilities. On narrow viewports, navigation becomes a compact horizontal row. Keyboard users can press `/` to focus global workflow search; `Ctrl/Cmd+Shift+P` opens the local command palette and `Escape` closes it. Dashboard remains read-only. Workflow pins and filters are stored in `sessionStorage` for the current tab session only, not written to the workflow database. Copy controls report clipboard failures instead of silently treating them as success.

The attention queue evaluates the latest 100 jobs plus session-pinned jobs; it is not a scan of the entire job registry. Failed jobs are prioritized. *Quiet >15m* is shown only when a valid `updated_at` timestamp is older than 15 minutes. It is a staleness heuristic, not proof of failure.

## HTTP API

The browser uses these read-only endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Connection, local mode and read-only health details |
| `GET /api/overview` | Aggregate status/count summaries |
| `GET /api/agg/graph` | Bounded read-only AGG graph snapshot; optional filters: `goalId`, `type`, `q`, `recovery=1` |
| `GET /api/agg/nodes/:node_id?revision=N` | Current or selected historical node revision, content hash, memberships, evidence references, provenance, revision index and related edges |
| `GET /api/agg/runs` | Filtered/paginated durable planner invocations, 14-day UTC start-date trend and aggregate lifecycle/duration counts. Filters: `q`, `status`, `tool`, `goalId`, `nodeId`, `since`, `until`, `limit` (max 100), `offset` |
| `GET /api/agg/runs/:run_id` | Bounded invocation detail: lifecycle, observed algorithm counters/outcome, errors, provenance, graph/node/revision links, goal scope, declared/resolved evidence observations, candidate summary and first 80 timeline events |
| `GET /api/agg/runs/:run_id/events?afterSequence=N&limit=N&type=...` | Ordered, cursor-paginated timeline events (`limit` max 250) |
| `GET /api/jobs` | Filtered and paginated workflow registry |
| `GET /api/jobs/:job_id` | One workflow and its bounded related records |
| `GET /api/roles` | Custom role versions, Skill snapshots, custom-workflow version pins, and `builtin_role_profile_pins` for exact built-in role/profile/version/hash references |
| `GET /api/batches` | Durable batch and individual-execution ledgers |
| `GET /api/events` | Filtered event stream |
| `GET /api/artifacts` and `GET /api/artifacts/:artifact_id` | Artifact index and one artifact's bounded detail |
| `GET /api/files?path=...` | Directory listing under the configured Explorer files root |
| `GET /api/files/preview?path=...` | Bounded preview of an allowed text/log file |
| `GET /api/git/status?path=...` | Best-effort Git status for supported text files under the configured workspace root |
| `GET /api/git/diff?path=...&mode=working-tree\|staged\|unstaged` | Bounded read-only Git patch for an allowed file; mode defaults to `working-tree` |

Unknown routes return `404`. API requests using a method other than `GET` are rejected with `405`. The root HTML and local CSS/JavaScript assets are served from the bundled `dashboard/public/` directory; assets are not fetched from a CDN.

### Built-in role profile overlays

The **Built-in role profile overlays** table reads the latest proposal binding per workflow from the event ledger. It shows built-in role, custom profile identity/version, profile SHA-256, Skill names and workflow status. A row records proposal intent; it does **not** prove the workflow was approved, dispatched, or completed. The API exposes bounded metadata only, not raw system prompts, Skill contents, or local source paths. Overlay bindings are currently accepted only for `standard-engineering`; built-in contracts and runtime permissions remain authoritative.

## Security and data boundaries

- SQLite opens with `readOnly: true`, `PRAGMA query_only=ON`, and `PRAGMA trusted_schema=OFF`. The dashboard is an observer; use the MCP workflow tools to make authorized changes.
- Requests are checked against the expected `Host`; supplied `Origin` headers must also be same-origin and loopback. Response headers disable caching and include a restrictive Content Security Policy and `X-Content-Type-Options: nosniff`.
- Responses and text previews are bounded. The file explorer resolves entries beneath one configured browse root, independent from the database directory. Precedence is `options.filesRoot`, `RUNALITH_DASHBOARD_FILES_ROOT`, `CHAT_ON_STEROIDS_DASHBOARD_FILES_ROOT`, explicitly supplied `options.dataDir` for compatibility, then `process.cwd()`. Health responses expose only the basenames `data_root` and `files_root`, never absolute paths. The Explorer rejects traversal and symbolic links, excludes hidden paths, database/WAL files and binary content, and only previews approved text/log extensions. Large files are not returned in full.
- Common credential patterns are redacted on a best-effort basis. Redaction is heuristic and cannot guarantee detection of every secret. Keep the local data directory's filesystem permissions restrictive.
- Browser assets are local; the dashboard does not call external APIs or send telemetry.

Loopback binding reduces network exposure but is not user authentication. This dashboard is for a trusted local operator, not a shared or remotely deployable admin console. Do not expose it through a reverse proxy, port forward, or shared host without a separately designed authentication and security boundary.

## Test

Run the dashboard's integration/security regression test with:

```bash
npm run test:dashboard
```

The dashboard test builds a temporary SQLite fixture and verifies read-only access, bounded responses, workflow/role/batch views, file-browser restrictions, AGG graph/history links, lifecycle semantics, filtered run retrieval, event pagination, redaction, Host/Origin checks, and rejection of write methods. Run `npm run test:agg-telemetry` for telemetry-store and real source-MCP integration tests. These tests do not certify broader production readiness or guarantee that heuristic secret redaction catches every sensitive value.


## Dashboard navigation and Git inspection

Dashboard uses a persistent navigation sidebar, searchable central content, summary metrics, and contextual inspectors. All existing domains remain available: Overview, AGG Graph, Workflows, Roles & Skills, Policies, Batches/individual executions, Event Stream, Artifacts, and Explorer. Explorer retains a contextual file tree and read-only source-control tools. The editor-style activity rail, view tabs, breadcrumb strip, bottom panel and status bar are hidden from the main information hierarchy. No workflow mutation controls are added.

Views can be bookmarked directly with `?view=agg` (or another supported primary view name); the route initializes the page and sidebar to the same selected view. Planner history supports `?view=agg&run_id=<uuid>` and `?view=agg&run_id=<uuid>&node_id=<node-id>` to reopen an exact run and its linked persisted node revision.

Explorer shows a visible **Configured root** and a lazy-loaded directory tree. The root is the dashboard's configured files root, not an automatically detected active folder in an IDE. Set \`RUNALITH_DASHBOARD_FILES_ROOT\` (or its compatibility alias) to switch roots; restarting the dashboard applies configuration changes. The workspace search walks supported directory listings recursively with caps of 40 folders, 1,000 entries, and 100 matches. When a cap is reached, the UI marks the results as limited. File previews remain bounded and read-only.

When the configured root is within a Git repository, Source Control reads status through \`git status --porcelain=v2 -z\`. File decorations distinguish supported modified, added, deleted, renamed, copied, untracked, type-changed, and conflict records when Git reports them. Directory decorations summarize descendant changes. Index and working-tree status are exposed separately by the API. Git status is best-effort: timeout, output bounds, unsupported paths, and non-Git roots can make status unavailable. The dashboard never stages, unstages, commits, checks out, resets, or reverts files.

Explorer includes an Open Editors list with multiple read-only tabs. Supported text previews use line numbers; Source Control exposes explicit working-tree, staged, and unstaged diff modes. The diff is a bounded unified patch rendered locally. This lightweight viewer avoids downloading Monaco or other remote assets and is not a full language-aware editor: syntax highlighting and advanced side-by-side diff navigation are not provided. Browser smoke tests check desktop/mobile layout, deep links, and graph/run-inspector interactions; they do not replace a full accessibility audit or guarantee conformance with a particular standard.

### AGG interpretation limits

The knowledge graph visualizes persisted nodes, current/historical revisions, memberships and typed relations. Durable planner telemetry is stored separately in `adaptive_goal_planner_runs`, `adaptive_goal_planner_run_events`, `adaptive_goal_planner_run_nodes`, `adaptive_goal_planner_run_edges`, `adaptive_goal_planner_run_goals`, and `adaptive_goal_planner_run_evidence`. The writable runtime creates these tables and their indexes/triggers at startup, inside a schema migration transaction, and stores `schema_version=2` in `adaptive_goal_planner_telemetry_meta`. The v1-to-v2 migration rebuilds the run parent table transactionally to add `tool_result_observed_duration_ms` and support new `schema_version=2` rows, preserves prior rows and linked IDs, and restores SQLite foreign-key enforcement. Re-running startup migration is idempotent and does not rewrite legacy workflow or knowledge records. The read-only Dashboard does not initialize or migrate this schema; before first runtime initialization it reports telemetry as unavailable with instructions.

Each invocation records `run_started`, the actual composed/input graph snapshot (`search_input_observed`), each audit event emitted by the search implementation (source `search_observer`), an observed algorithm summary when the algorithm returns (`algorithm_result_observed`), and the terminal `run_completed` or `run_failed` event. The run row records start/end ISO timestamps, request/input graph digests, actual algorithm result hash when returned, tool lifecycle status, algorithm status, returned search counters, bounded candidate summary, exception code/name/message and runtime provenance. Each event has a monotonically assigned per-run sequence number and its own observed wall-clock timestamp. Initial input nodes/edges and declared evidence refs are committed before search starts; composed knowledge nodes retain exact persisted node IDs, goal scope, selected revision, content hash, provenance hash and associated persisted edge IDs when the runtime provides those references. Runtime resolver observations are kept distinct from graph-declared evidence references; lineage metadata, when present, is shown separately from claim verification. `duration_ms` measures end-to-end monotonic elapsed time up to terminal telemetry persistence; `tool_result_observed_duration_ms` records the earlier observation at which the MCP wrapper received the result/error. Their difference may include telemetry finalization overhead; neither is labelled as algorithm CPU time.

Lifecycle and metric semantics are deliberately narrow:

- `status=completed` means the MCP tool returned a result; it is not workflow completion, candidate acceptance, verified search success, human approval, dispatch, or execution. `algorithm_status` is a separate verbatim runtime result.
- `status=failed` means the MCP tool invocation threw. The error is recorded and the last input/event snapshot is retained. A missing algorithm result stays `null`.
- `status=running` means no terminal telemetry write has been observed. An old running record may be labelled `possibly_interrupted` in the UI based on age only; the runtime does not invent an end time or final duration. `elapsed_ms` is provisional.
- Metrics contain only explicit finite/integer values returned by the implementation (for example expansions, generated/pruned states, MCTS simulations/work units, candidate counts, or the returned termination reason). Missing metrics remain absent/unknown; elapsed MCP duration is not attributed to any single search step.
- If a search observer cannot persist an event, the search is not aborted and its outcome is not rewritten into a fabricated algorithm error. Capture errors are recorded at terminalization when possible, while `search_event_count_recorded`, `search_event_count_omitted`, and `search_events_truncated` distinguish the event count reported by the algorithm from the actually durable trace. If the terminal write itself fails, the run remains non-terminal and the actual MCP result includes `telemetry.persisted=false`.
- The graph input digest, algorithm graph hash, knowledge snapshot hash, per-node content/provenance hashes and model hash (where a Phase 2/3 result provides one) have distinct documented sources. A digest supports identity/integrity, not source authenticity or claim truth. `verified`/`usable_for_planning` are never promoted by telemetry.
- The run snapshot limits graph nodes to 500 and edges to 2,000, distinct evidence references to 5,000, initial detail events to 80 (cursor endpoint pages up to 250), and evidence detail observations to 500. Count-vs-snapshot fields and response truncation flags report bounded data gaps. An absent reference does not prove the planner never saw it.

The Dashboard `GET /api/agg/runs`, `GET /api/agg/runs/:run_id`, and `GET /api/agg/runs/:run_id/events` endpoints are read-only. All writes come from the MCP runtime's injected writable workflow SQLite handle; there is no HTTP ingest/write endpoint. Run detail links connect back to the existing graph/node revision inspector; a selected graph node also lists recorded planner runs that link to it. This history reflects only runtime instances running the instrumented source version; it does not backfill historical runs, and installed `.mcpb` packages remain unchanged until separately rebuilt/installed through their existing authorization process.

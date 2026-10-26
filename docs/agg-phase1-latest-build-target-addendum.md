# AGG Phase 1 — latest-build target addendum

**Status:** `USER_DIRECTED_ENGINEERING_TARGET; FORMAL_OPERATIONAL_REFREEZE_PENDING`

**Purpose:** record the explicit project-owner direction to stop recovering MCPB 1.0.8 and continue technical AGG integration work against the newest existing AGG-enabled candidate. This addendum does not alter either original frozen protocol document, does not silently rewrite the frozen operational target, and does not open a scenario-execution gate.

## Target selected for engineering verification

- Bundle: `artifacts/runalith-1.0.9-rc.5-candidate-agg-phase1-semantics-index-20261022T1033Z.mcpb`
- Package version: `1.0.9-rc.5`
- Size: `560904` bytes
- SHA-256: `212785eb3eb0d254caec777ce9ad00491a7533d6661c3fbf85f29b65e7506432`
- Manifest/runtime MCP tools: `67/67`
- AGG tools include `adaptive_goal_graph_search`, Plan Graph proposal creation/readback, readiness check, Execution Graph proposal creation/readback and execution-plan candidate review.
- Package archive integrity and isolated MCP initialize/tools/list/health smoke passed.
- A new direct packaged-runtime integration test calls `adaptive_goal_graph_search` with a small synthetic graph and checks `proposals_found`, a stable-format graph hash, at least one candidate, and at least one Plan Graph draft. The call runs inside a disposable temporary database/workspace and does not create or approve a workflow, dispatch, execute a graph action, or grant production authority.
- Static compatibility check compared all ten frozen per-case plugin-tool allowlists against the 67-tool manifest: no allowed plugin tool name is missing, the original ten-prompt-set SHA-256 remains `ce2d0d6627d31e13e3e6f23b7df8febea5f850191b3ac8254ea0ced1cd848e57`, and CASE-06's hard-denied action list remains intact. This is a static check, not a scenario execution.
- The old scenario spec still describes the original 1.0.8 target and remains blocked. Tool-name compatibility does not update the target binding or authorize a run.
- A machine-readable target-successor proposal is prepared at `benchmarks/plugin-workflow-benchmark/phase1-latest-build-target-successor-proposal-20261022.json` (SHA-256 `34886fbcc01ae1a1bd824ba22c353b784b85061047e0ed6d6fcab2754ba61b02`). It pins the candidate and includes all ten unchanged prompts and original criteria, but its status is `DRAFT_REVIEW_REQUIRED_NOT_AUTHORIZED`; it has no signature and does not authorize execution.

## Formal owner approval of the successor proposal

On 2026-10-22, the user explicitly stated **“tôi phê duyệt chính thức”** (“I formally approve”) after the versioned target-successor proposal was presented. Record the proposal as approved by the project owner at the project-decision level. The exact proposal hash at approval time is `34886fbcc01ae1a1bd824ba22c353b784b85061047e0ed6d6fcab2754ba61b02`; the target bundle remains pinned to SHA-256 `212785eb3eb0d254caec777ce9ad00491a7533d6661c3fbf85f29b65e7506432`. See `artifacts/agg-phase1-target-successor-formal-owner-approval-20261022.md` and `artifacts/agg-phase1-target-successor-user-decision-20261022.md`.

Owner approval is now recorded. Independent review, the established trusted cryptographic signature, and fresh exact-scope operational authorization/gate transition remain pending. Therefore the execution gate stays closed; this is not permission to claim that the ten-scenario operational A/B has started or passed.

## Original acceptance criteria remain unchanged

- Original ten operational scenarios and paired `plugin_enabled` versus `basic_tools` comparison.
- Original 100-point rubric and category weights.
- `potential` threshold of 85; supervision band 70–84.
- All five original hard-fail conditions.
- No discriminator, MCTS, or Phase 2–4 expansion.

The hashes of the original plan and freeze files remain unchanged. The target bundle identity is the only intended difference for a future protocol successor; prompt bytes, scenario definitions, baseline policy, scoring rules and hard-fail semantics must remain byte-for-byte/semantically unchanged unless separately approved.

## Evidence from direct latest-build integration test

- Test: `tests/test-mcpb-agg-search-integration.mjs`
- Outcome: `MCPB_AGG_SEARCH_INTEGRATION=PASS`
- Search status: `proposals_found`
- Candidate bundle hash: the exact hash pinned above
- The resulting candidate/draft stays review-only; workflow creation, approval, dispatch and production authority remain false.

This is integration evidence for the packaged AGG search tool, not an operational A/B run and not Phase 1 acceptance by itself.

## Required before the original operational A/B can use this new target

1. Review the prepared versioned successor draft and, through the established process, approve/sign the operational target/spec binding the exact bundle SHA-256 above. It preserves the ten frozen prompts, paired-condition rules, per-case tool-deny policies, rubric and hard-fails. The original freeze snapshot and its historical identity must stay immutable.
2. Static compatibility against the 67-tool bundle now passes for the existing per-case allowlists, and CASE-06 hard-deny policy is intact. The versioned successor must preserve that isolation and be independently reviewed; extra tools in the manifest must not become implicitly available to any scenario.
3. Obtain an independent review of the exact candidate/source lineage and updated spec, plus a fresh exact-scope authorization and corresponding official gate decision. Do not reuse any consumed one-shot authorization or infer authorization from this chat addendum.
4. Prepare/approve the operational corpus and evaluator process, then run both paired conditions in separate disposable environments with all raw traces, attempts, errors, interventions, resource/cost data, hashes and independent adjudication preserved.
5. Keep the final acceptance `PARTIAL_NOT_ACCEPTED` until the operational evidence, rubric and five hard-fail checks are independently reconciled.

## Explicit non-claims

- This addendum is not a signed independent review or cryptographic authorization.
- It does not state that the current candidate is an approved release; it remains a candidate build.
- It does not establish that AGG has statistically significant advantage over CoT/ToT.
- It does not claim that the ten-scenario operational A/B has been run.
- It does not change production trust roots, install/release the plugin, modify `dist/`, dispatch a live workflow, or write to production databases.

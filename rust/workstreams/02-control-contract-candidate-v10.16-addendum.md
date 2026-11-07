# WS2 Control Contract Candidate V10.16 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.15 SHA-256 `31d5a6f656bc9edfffe98038fb33d983ab94c6b82d387fc31dc44b1fa3a5a15b`  
**Purpose:** record WS1's later three-copy reconciliation and preserve export-integrity blocker.

## 1. WS8 mapping document identity reconciled

After V10.14/V10.15, WS1 rechecked every copy of `08-control-domain-diagnostic-v1.0.1-envelope-mapping.md` and reported all three as SHA-256 `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653` (A2A seq1073, message `7209daae-9957-4b08-a9df-0834e1933b85`). WS2 independently recomputed all three:

1. WS8 isolated worktree: `/home/long/work/chatgpt-adapter-ws8-20261103/rust/workstreams/08-control-domain-diagnostic-v1.0.1-envelope-mapping.md`.
2. Canonical R5.4.2 export: `/home/long/work/WS8-R5.4.2-EXPORT-20261103/WS8/workstreams/08-control-domain-diagnostic-v1.0.1-envelope-mapping.md`.
3. WS7 review snapshot: `/home/long/work/ws7-evidence/ws8-mapping-v1.0.1-review-20261103/08-control-domain-diagnostic-v1.0.1-envelope-mapping.md`.

All three recomputed to `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`. This supersedes V10.14's earlier observation of a transient `99cc73c...` live-worktree hash. The mapping doc now agrees across all three exact copies.

V3 mapping review remains independently PASS by WS2 and WS1, with disposition `ACCEPTED_WITH_BLOCKERS_FOR_STRUCTURAL_ENVELOPE_MAPPING; DRAFT_NOT_RATIFIED`, restricted to exact mapping bytes and structural semantics. Example hash `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`; validator hash `dbd8f166f151d171a06e3ba5a9e91ec63519b0c207231d18805a807e0b324130`. WS3/WS7 V3 consumer reviews remain pending.

## 2. R5.4.2 outer export integrity is still not verified

WS2 ran `python3 -B verify-export.py` in `/home/long/work/WS8-R5.4.2-EXPORT-20261103`. Exact result: `MANIFEST.sha256 missing or not a regular file`. Direct file check also confirms the outer manifest is absent. The export includes `build-manifest.py` and `verify-export.py`, but no generated outer manifest.

WS2 sent WS8 the failure and asked it to run its deterministic manifest builder, rerun verification to `EXPORT_INTEGRITY_PASS`, and report manifest/archive hashes (A2A `b958770c-7d26-4428-98ff-8f1a63975524`). WS2 did not mutate the export or run its build script.

Therefore mapping-file identity is reconciled; **R5.4.2 package integrity remains NOT VERIFIED**. Do not treat the candidate export as a verified archive until `verify-export.py` passes against a generated manifest and exact file set.

## 3. Review and authority status

- WS1 V3 review: PASS; accepted with structural blockers for canonical R5.4.2 snapshot only (A2A seq1039). WS1's three-copy identity correction is acknowledged (seq1073).
- WS3 V3 mapping review request: `d148c50c-3cec-4511-b537-8b33e867cf43`; pending.
- WS7 V3 mapping review request: `9a13f058-8493-4d24-8edc-076819b8f309`; pending.
- WS8 R5.4.2 manifest/integrity request: `b958770c-7d26-4428-98ff-8f1a63975524`; pending.
- WS3 Store renewal DTO names/TTL compatibility only; Control HTTP producer remains NOT WIRED and no durable WorkerStore renewal receipt/journal or supervisor path is proven.
- Project Owner/Host Security authority remains `PENDING / NOT_ASSIGNED`; no migration, production attempt policy or dispatch is approved.

Latest WS2 inbox read through sequence **1073**. WS1 correction was received and ACKed.

**Overall:** WS8 mapping V3 structurally accepted with blockers; exact mapping document copies reconciled; outer R5.4.2 export integrity not verified; WS3/WS7 reviews pending; HTTP renewal integration NOT WIRED; Project Owner/Host Security NOT_ASSIGNED; contracts NOT_RATIFIED; production dispatch/cutover NOT_AUTHORIZED; release readiness NOT_PROVEN.

# WS2 Control Contract Candidate V10.22 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.21 SHA-256 `8b82fcd558b19eb8b9a3f4c97e0365c77ac9b8f38fc3a18d10e5d602a2335fe9`  
**Purpose:** supersede one stale V3 review-note sentence and record final WS1 forwarding.

## 1. Current mapping identity note V4

V3 mapping review note is kept unchanged as historical record; it contains a transient statement that the WS8 live worktree still had the pre-correction hash. WS1 seq1073 and WS8 seq1077 subsequently confirmed reconciliation, and WS2 independently rehashed three mapping document copies; all three equal `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`.

The current identity note is `02-control-domain-diagnostic-ws8-mapping-review-v4.md`, SHA-256 `b065a05e1fbe16ffac821275ba46bb033712ed2a5aaa82d195d86d7c0c7cad75`. It preserves the canonical doc/example/validator hashes, WS1/WS3/WS7 structural-only dispositions, WS7 archive evidence, reproduction commands, and the separate outer-export integrity limitation.

## 2. WS1 requested WS3 disposition and W1 boundary — forwarded

WS1 asked for WS3 seq1099 review text/hash and an explicit W1 plan-subject provenance boundary (WS1 seq1114, message `68d12552-b909-4f2a-89e5-417973db61f8`). WS2 replied atomically as A2A `51372dcd-2d32-4a59-9542-d520877f7a65`.

Forwarded WS3 disposition: `ACCEPTED_WITH_BLOCKERS_FOR_STRUCTURAL_ENVELOPE_MAPPING; DRAFT_NOT_RATIFIED` for WS8 V1.0.1 canonical mapping V3 exact bytes only. WS3 independently ran V3 oracle PASS. It accepts exact 29/29 mapping, required mutation tests, unknown future null/non-null policy, direct envelope payload and closed MCP Error V1. It does not approve digest profile, auth/audience, route/runtime, HTTP/retry, terminality, authority or production behavior.

Separate W1 plan-subject provenance remains narrow: WS1 accepted unchanged schema/fixture serialization bytes only. No signed TaskClaim preimage, verified claim authority, compiled-plan mapping or execution authority is thereby approved. Do not conflate this with mapping V3 acceptance.

## 3. Current review and blocker summary

- Mapping V3: WS1, WS3 and WS7 independently accepted with blockers for structural envelope mapping only; DRAFT_NOT_RATIFIED.
- WS8 live/export/WS7 mapping document bytes reconciled at `e8c60aaf...`; canonical example and validator hashes unchanged.
- WS7 11-entry source-manifest and WS2 V3/producer validators independently PASS. Corrected WS2 snapshot-test successor v2 also PASS.
- R5.4.2 outer package integrity remains NOT VERIFIED. `python3 -B verify-export.py` still returns `MANIFEST.sha256 missing or not a regular file`; WS8 must generate the outer manifest, pass full exact-file-set verification and return manifest/archive hashes. WS2 did not modify WS8 export.
- WS3 renewal client journal/parser remains consumer-side only and not supervisor-integrated. Control HTTP backend not wired; standalone worker route 503; no Store-backed adapter; no claim_id/receipt_id; no end-to-end producer/retry receipt proof.
- Project Owner/Host Security remains NOT_ASSIGNED; production dispatch/cutover not authorized.
- WS1 also mentioned a separate WS7 v0.5.1 archive review/producer-confirmation process. It is independent from WS8 mapping V3 and remains pending; this addendum does not claim that artifact accepted.

WS2 inbox last read through sequence **1114**. The WS1 request was answered and atomically ACKed by A2A reply `51372dcd-2d32-4a59-9542-d520877f7a65`.

**Overall:** WS8 mapping V3 reviews closed across WS1/WS3/WS7 for structural mapping only; V4 supersedes stale live-tree wording in V3 note; copied-validator path defect corrected; R5.4.2 outer package integrity NOT VERIFIED; renewal producer/supervisor integration NOT WIRED; authority NOT_ASSIGNED; contracts NOT_RATIFIED; production dispatch/cutover NOT_AUTHORIZED; release readiness NOT_PROVEN.

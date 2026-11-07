# WS2 Control Contract Candidate V10.17 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.16 SHA-256 `a7fcc67d08c1f7646c5f29bda9b7669ef5983ec982b1b055190da00e01b91752`  
**Scope:** preserve source-note history and latest export verification status.

## 1. WS2 Diagnostics V2.3.1 source-note history

WS8 reported its package retains the historical pinned `lib.rs` and current `lib.current.rs` separately. WS2 also preserves both revisions of its own source-drift clarification:

- Pre-WS6 clarification note, byte-reconstructed from the first six lines of the current note: `02-control-domain-error-diagnostics-v2.3.1-source-drift-note-pre-ws6.md`, SHA-256 `ff2898343279e75c22a07677f4c1dc670c405deb875c7ce4dc1f485bd09e966b`.
- Current WS6-confirmed clarification: `02-control-domain-error-diagnostics-v2.3.1-source-drift-note.md`, SHA-256 `7d8ac8a9a2be38417e2b3ca28c56eb7af75e08278dee9185e540e0dc6835a02a`.

WS2 recomputed both hashes. The older bytes exactly match the earlier recorded `ff289...` hash; no source-note history was lost. Both notes keep V2.3.1 immutable and the helper outside the 29-code inventory.

## 2. Mapping canonical identity

WS1's seq1073 message said all three mapping document copies—WS8 live worktree, canonical R5.4.2 export, WS7 review snapshot—now hash to `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`. WS2 independently recomputed those three exact paths and confirmed all equal. The earlier transient `99cc73c...` mismatch is superseded. Corrected producer DTO label is `1.0.1-draft`.

Mapping V3 remains `ACCEPTED_WITH_BLOCKERS_FOR_STRUCTURAL_ENVELOPE_MAPPING; DRAFT_NOT_RATIFIED` for the frozen canonical mapping snapshot. WS1 independently ran V3 PASS. WS3 and WS7 reviews remain pending.

## 3. R5.4.2 export-integrity blocker

WS2 reran `python3 -B verify-export.py` in `/home/long/work/WS8-R5.4.2-EXPORT-20261103` after WS8's mapping reconciliation response. It still returns exactly `MANIFEST.sha256 missing or not a regular file`. No `MANIFEST.sha256` is present. The export's `build-manifest.py` exists, but WS2 has not run it or modified the WS8-owned export.

WS2 requested manifest generation, full `verify-export.py` success (`EXPORT_INTEGRITY_PASS`), and manifest/archive hashes from WS8 (A2A `b958770c-7d26-4428-98ff-8f1a63975524`, follow-up `e0697118-c4be-42cf-9e79-2a8852e1db38`). Package integrity remains `NOT_VERIFIED`, independent of the corrected mapping-document identity.

## 4. Current coordination

- WS1 V3: independent PASS; accepted with structural blockers; no runtime/production approval.
- WS3 V3 review request `d148c50c-3cec-4511-b537-8b33e867cf43`: pending.
- WS7 V3 review request `9a13f058-8493-4d24-8edc-076819b8f309`: pending.
- WS8 manifest/integrity requests above: pending.
- WS3 renewal producer HTTP integration remains NOT WIRED; Store DTO compatibility only.
- Project Owner/Host Security remain NOT_ASSIGNED; no migration/production authorization.

Latest WS2 inbox read through sequence **1077**. WS8 reconciliation response was ACKed; WS1's three-copy update was ACKed.

**Overall:** mapping-doc identity reconciled across all copies and structural V3 accepted with blockers; source-note history preserved; R5.4.2 outer package remains unverified because its manifest is absent; WS3/WS7 reviews pending; HTTP renewal integration NOT WIRED; authority NOT_ASSIGNED; contracts NOT_RATIFIED; production dispatch/cutover NOT_AUTHORIZED; release readiness NOT_PROVEN.

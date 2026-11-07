# WS2 Control Contract Candidate V10.15 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.14 SHA-256 `84159398770ae58eba9f1b12454b5fc20c26a31e83c98bfc9c5343e46ca49763`  
**Scope:** latest WS2 review and A2A reconciliation only.

## 1. WS8 mapping V3 review status

WS2 and WS1 independently ran `rust/workstreams/02-control-domain-diagnostic-ws8-mapping-review-v3-test.py`: PASS. WS1 disposition is `ACCEPTED_WITH_BLOCKERS_FOR_STRUCTURAL_ENVELOPE_MAPPING; DRAFT_NOT_RATIFIED`, limited to canonical R5.4.2 export snapshot (WS1 A2A seq1039). Exact frozen WS8 hashes: document `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`; example `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`; validator `dbd8f166f151d171a06e3ba5a9e91ec63519b0c207231d18805a807e0b324130`.

WS2 rechecked the WS8 isolated live worktree and R5.4.2 export after WS8's correction. Both live mapping document and export mapping document now hash to `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`. This resolves the previously observed live/export document-hash mismatch. WS1 ACKed V10.14 and explicitly required the scope distinction: V3 is an exact-hash review of the candidate snapshot, not proof of export integrity or runtime/production behavior (A2A seq1070).

## 2. R5.4.2 export integrity remains blocked

WS2 ran the export's own verifier in `/home/long/work/WS8-R5.4.2-EXPORT-20261103`:

```bash
python3 -B verify-export.py
```

Actual result: `MANIFEST.sha256 missing or not a regular file`. A direct `test -f MANIFEST.sha256` also returned exit 1. The export contains `build-manifest.py` and `verify-export.py`, but outer manifest has not been generated. Therefore:

- mapping document bytes are verified and live/export hashes now agree;
- R5.4.2 package integrity is **NOT VERIFIED**;
- no export/archive integrity pass may be claimed.

WS2 sent WS8 the exact verifier failure and requested deterministic manifest generation, rerun to `EXPORT_INTEGRITY_PASS`, plus exact manifest/archive hashes (A2A `b958770c-7d26-4428-98ff-8f1a63975524`). WS2 did not mutate the WS8 export or run its manifest builder.

## 3. Mapping review artifacts

V3 fixture SHA `4ba40924a5952c666f4c9fcc561979a517fbc631186d82081591f028a5337195`; validator SHA `ebe7812df65639e6b6c4e1044834f72b7b1ca39790b9a285399a4c4f1be1cdb9`; review doc SHA `d928717b725b72ee94942ba4d96f5b8bd5fcbb35e4488b638f6e2bd9782cdddb`.

The test verifies actual SHA bytes for WS8 canonical doc/example/validator plus WS2 producer/envelope dependencies; exact unique 29/29 cause/domain pairs; wrong-but-valid known pair; duplicate/missing mapped rows; duplicate/missing source rows; unknown future cause/null domain as `UNKNOWN/UNRESOLVED`; unknown future cause/non-null domain rejected; envelope example; six DTO negatives; MCP Error V1 remains closed `{code,message}`.

## 4. Frozen source attribution boundary

WS2 source-drift note SHA `7d8ac8a9a2be38417e2b3ca28c56eb7af75e08278dee9185e540e0dc6835a02a`. WS8 confirms the historical `runalith-trust/src/lib.rs` at V2.3.1 hash `5fba5f3c...` is retained as `lib.rs`; current live bytes `eab8876e...` are separate `lib.current.rs`. Only difference is module declaration `pub mod domain_prefixed_signature;`. WS1/WS6 confirm the new helper returns distinct `DomainPrefixedSignatureError`, adds no AGG_/GOVERNANCE_ stable cause, makes no `TrustError::code()` change and is not trust authorization/`VERIFIED`. Keep it outside the frozen 29-code diagnostics inventory. V2.3.1 remains immutable and a static frozen-source snapshot.

## 5. Other coordination state

- WS3 canonical mapping V3 review request queued: `d148c50c-3cec-4511-b537-8b33e867cf43`; pending.
- WS7 canonical mapping V3 review request queued: `9a13f058-8493-4d24-8edc-076819b8f309`; pending.
- WS8 export-manifest integrity request queued: `b958770c-7d26-4428-98ff-8f1a63975524`; pending.
- WS3 accepts Store renewal DTO field/TTL shape only; HTTP producer remains NOT WIRED, no Store-backed adapter, no typed HTTP receipt enforcement, no claim_id/receipt_id, no WorkerStore renewal journal or supervisor integration.
- Project Owner/Host Security authority remains `PENDING / NOT_ASSIGNED`; no migration, attempt-policy approval or production mutation.
- Latest WS2 inbox read through sequence **1070**. WS1's V10.14 acknowledgment was received and ACKed.

**Overall:** WS8 structural mapping is independently accepted with blockers for canonical file snapshot only; live/export mapping-doc hash is reconciled; outer R5.4.2 export integrity remains unverified due missing manifest; WS3/WS7 mapping reviews pending; HTTP renewal integration NOT WIRED; Project Owner/Host Security NOT_ASSIGNED; contracts NOT_RATIFIED; production dispatch/cutover NOT_AUTHORIZED; release readiness NOT_PROVEN.

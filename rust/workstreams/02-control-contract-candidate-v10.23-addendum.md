# WS2 Control Contract Candidate V10.23 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.22 SHA-256 `fa2754667dcc68e2c65960634d6013f073eefcfc4cf2c434544b5e25fda6505a`  
**Purpose:** record WS8 document-only erratum identity and final export-integrity recheck.

## 1. WS8 V1.0.2 document-only erratum verified

WS8 published `08-control-domain-diagnostic-v1.0.2-erratum.md`, SHA-256 `da70d5bf954019281f2baf30892ea10a1130c5f0fd4f8b95a38ac5c6369739e2`.

WS2 independently rehashed both WS8 isolated worktree and R5.4.2 export copies:

- V1.0.2 erratum: `da70d5bf954019281f2baf30892ea10a1130c5f0fd4f8b95a38ac5c6369739e2` in both locations.
- Preserved pre-correction R3 mapping document: `99cc73c032c0706be4138847ccfe2f064cda9c025a9149023778e8535180a3eb` in both locations, as `08-control-domain-diagnostic-v1.0.1-envelope-mapping.R3-original.md`.
- Corrected canonical V1.0.1 mapping doc remains `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`.
- Example remains `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`.
- Mapping validator remains `dbd8f166f151d171a06e3ba5a9e91ec63519b0c207231d18805a807e0b324130`.

Erratum is document-only: producer DTO stays `ControlDomainDiagnosticV1.0.1` / `1.0.1-draft`; Common Envelope wire schema stays v1.0.0. No payload DTO, schema, route, runtime, digest, authentication, HTTP/retry or authority semantics changed. V1.0.0 history remains a hash/disposition index only; original V1.0.0 artifact bodies were not recoverable. WS2 acknowledged WS8 erratum identity through A2A reply `e6e0a948-cd1f-4c0c-b32f-8a5272aec2d3`.

## 2. Mapping review state retained

WS1, WS3 and WS7 each accepted canonical V1.0.1 mapping bytes with blockers for structural direct-payload mapping only; `DRAFT_NOT_RATIFIED`. V3 oracle is unchanged and independently passed by all three. V4 note `02-control-domain-diagnostic-ws8-mapping-review-v4.md` SHA `b065a05e1fbe16ffac821275ba46bb033712ed2a5aaa82d195d86d7c0c7cad75` supersedes the stale live-tree wording in V3 note without modifying V3. WS1 ACKed V10.22 and the V4 distinction (A2A seq1129).

WS2 corrected copied-validator successor `02-ws8-control-domain-diagnostic-v1.0.1-envelope-mapping-R5.4.2.snapshot-test-v2.py` SHA `7ed09e6ef8f1b11f2dd733375bd2fc067872e331b3a49ab5cf6dddae091e1974`; it uses the frozen Common Envelope and mapping snapshots and passes all pins/mutation tests. Original defective copied validator remains preserved.

## 3. R5.4.2 outer export integrity remains blocked

After WS8's V1.0.2 erratum publication, WS2 reran in `/home/long/work/WS8-R5.4.2-EXPORT-20261103`:

```bash
test -f MANIFEST.sha256
python3 -B verify-export.py
```

`MANIFEST.sha256` is still absent (`test -f` exit 1); verifier still returns exactly `MANIFEST.sha256 missing or not a regular file`. Package integrity remains `NOT_VERIFIED`. WS8 must generate deterministic outer manifest, rerun full file-set verifier to `EXPORT_INTEGRITY_PASS`, and report manifest/archive hashes. WS2 has not modified WS8 export.

## 4. Remaining non-mapping gates

- WS3 prepared renewal journal/client/parser tests pass, but supervisor has no journal integration; Control HTTP server remains untyped `Value -> Value`, no Store-backed adapter, standalone worker backend unset/503, no claim_id/receipt_id and no end-to-end producer retry receipt. Renewal producer/supervisor integration `NOT WIRED / NOT PROVEN`.
- Project Owner/Host Security authority `NOT_ASSIGNED`; no production migration/dispatch approval.
- WS1 noted separate WS7 v0.5.1 producer-confirmation/cross-review process remains pending; it is distinct from WS8 mapping V3 and is not approved by these reviews.

Latest WS2 inbox read through sequence **1129**. WS8 erratum identity acknowledged; WS1 V10.22/V4 acknowledgment received and ACKed.

**Overall:** WS8 mapping V3 remains accepted by WS1/WS3/WS7 with blockers for structural mapping only; V1.0.2 erratum and R3 byte preservation verified; WS2 copied-validator successor corrected and tested; R5.4.2 outer package integrity still NOT VERIFIED due missing manifest; renewal producer/supervisor integration NOT WIRED; authority NOT_ASSIGNED; contracts NOT_RATIFIED; production dispatch/cutover NOT_AUTHORIZED; release readiness NOT_PROVEN.

# WS2 Control Contract Candidate V10.14 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.13 SHA-256 `0d04d2b1b9f85ace28e90fe774723f4bb19008aeb3fd030be4a2695657a9fb57`  
**Scope:** WS2 cross-workstream coordination and review evidence only. No implementation changes outside WS2-owned review artifacts.

## 1. WS8 ControlDomainDiagnostic mapping — canonical export V3 review

WS8 supplied corrected canonical R5.4.2 export mapping revision. Exact hashes:

- Document: `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`.
- Example: `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`.
- Validator: `dbd8f166f151d171a06e3ba5a9e91ec63519b0c207231d18805a807e0b324130`.

The corrected document states producer DTO `1.0.1-draft`; Common Envelope wire schema remains v1.0.0. WS8 reported these exact bytes and rerun PASS in A2A seq994 (`f74a166a-64bd-42bb-8836-bcf59e863d85`).

WS2 froze the canonical R5.4.2 export document/example/validator snapshots and published mapping-review V3:

- Fixture: `02-control-domain-diagnostic-ws8-mapping-review-v3.fixtures.json`, SHA-256 `4ba40924a5952c666f4c9fcc561979a517fbc631186d82081591f028a5337195`.
- Validator: `02-control-domain-diagnostic-ws8-mapping-review-v3-test.py`, SHA-256 `ebe7812df65639e6b6c4e1044834f72b7b1ca39790b9a285399a4c4f1be1cdb9`.
- Review document: `02-control-domain-diagnostic-ws8-mapping-review-v3.md`, SHA-256 `d928717b725b72ee94942ba4d96f5b8bd5fcbb35e4488b638f6e2bd9782cdddb`.

Exact command from repository root:

```bash
python3 -B rust/workstreams/02-control-domain-diagnostic-ws8-mapping-review-v3-test.py
```

WS2 run: PASS exact byte hashes for canonical WS8 doc/example/validator and pinned producer/envelope dependencies; exact unique 29/29 cause/domain pairs; wrong-but-valid known domain rejected; duplicate/missing mapped rows rejected; duplicate/missing authoritative source rows rejected; unknown future cause with null domain preserved as `UNKNOWN/UNRESOLVED`; unknown future cause with non-null domain rejected; Common Envelope example validation; six DTO negatives; MCP Error V1 remains closed `{code,message}`.

WS1 independently ran V3 and returned `ACCEPTED_WITH_BLOCKERS_FOR_STRUCTURAL_ENVELOPE_MAPPING; DRAFT_NOT_RATIFIED`, scoped to the frozen R5.4.2 export snapshot only (A2A seq1039, `ea3a3d7d-b941-4c56-9b24-d77ea566af4f`). WS2 sent final bounded disposition to WS8 (reply `61ed96d3-1c03-43c6-b1c7-33aa39ebfe47`).

**Live/export identity remains unresolved:** WS8's isolated live worktree still hashes the mapping document as `99cc73c032c0706be4138847ccfe2f064cda9c025a9149023778e8535180a3eb`, while canonical R5.4.2 export hashes as `e8c60aaf...`. WS2 requested WS8 reconciliation (A2A `bc1ea6ea-8682-4aed-9ee8-da671ce6003a`). V3 and WS1 acceptance apply to the canonical export snapshot only; do not claim the live worktree was corrected or that the two trees are identical.

Accepted mapping scope only: exact diagnostic object as Common Envelope payload; `message_type=runalith.control.domain-diagnostic.v1`; preserve subject/correlation/causation; host-injected producer identity; route-derived effect class; outer `payload_digest` separate. No digest canonicalization profile, runtime route/serializer, authentication/audience, HTTP/retry, terminality, provider truth, cryptographic or production behavior is approved. No transport or contract ratification.

## 2. Diagnostics V2.3.1 frozen-source clarification

V2.3.1 pins historical `runalith-trust/src/lib.rs` SHA `5fba5f3c618609c72e354e35488c92baf5b5c753754cda45f2c1e0484107be6f`. Current live WS6 file SHA is reported as `eab8876e0a12c0d2c5f683c36c100c34efd706135d6fe75681082ab502320f95`; difference is exactly one `pub mod domain_prefixed_signature;` declaration. WS8 states the exact historical source remains packaged as `lib.rs` and current bytes separately retained as `lib.current.rs`, without overwriting either snapshot (A2A seq1025, `65709476-6b8e-4b8b-9452-032910152f03`).

WS1 and WS6 confirm the helper's `DomainPrefixedSignatureError` is a distinct error family, not converted to `TrustError`, does not change `TrustError::code()`, emits no AGG_/GOVERNANCE_ stable code and returns byte-profile metadata rather than trust authorization or `VERIFIED` (WS6 reply `3f8c0104-5e39-4b8c-8d46-d44f946245b8`, forwarded in WS1 seq1009). Keep it outside the frozen 29-code inventory. Do not parse Display or infer `AUTHENTICATION_FAILED`. A future caller integration requires a versioned successor with exact emitter/callsite tests.

WS2 clarification note: `02-control-domain-error-diagnostics-v2.3.1-source-drift-note.md`, SHA-256 `7d8ac8a9a2be38417e2b3ca28c56eb7af75e08278dee9185e540e0dc6835a02a`. V2.3.1 itself remains immutable and is a frozen reviewed snapshot, not a dynamic future source-completeness guarantee.

## 3. Control/Worker renewal boundary and authority

WS3 ACKed WS2 producer-source review (seq956): Store `TaskLeaseRenewal` DTO field names and TTL `1..=600` are compatible only at producer DTO level. HTTP producer remains `NOT_PROVEN / NOT WIRED`: `WorkerControlAuthority` is `Value -> Value`, route does not validate typed response fields, standalone composition leaves worker authority unset and returns 503, no Store-backed adapter is found. Request/receipt still lack `claim_id`/`receipt_id`; WorkerStore renewal journal and supervisor integration remain unproven. WS3 requires typed request/response DTO, backend composition and real Store-backed HTTP integration test before runtime acceptance.

Authority status remains `PENDING / NOT_ASSIGNED`, neither approved nor rejected. No Project Owner/architecture owner, Host Security endpoint, appointment artifact/hash, human escalation channel or decision record. WS4 v6-to-v7 migration and Control attempt semantics remain unapproved; no migration or production mutation.

## 4. Pending reviews and latest inbox

- WS1 V3 canonical-export review: independently PASS and accepted with structural blockers; A2A seq1039. ACKed.
- WS3 review request for canonical mapping V3: queued as `d148c50c-3cec-4511-b537-8b33e867cf43`; pending.
- WS7 review request for canonical mapping V3: queued as `9a13f058-8493-4d24-8edc-076819b8f309`; pending.
- WS8 live/export reconciliation request: queued as `bc1ea6ea-8682-4aed-9ee8-da671ce6003a`; pending.
- WS8 historical-source boundary response (seq1025) and WS1 review responses through seq1040 were received and ACKed where possible.
- WS2 inbox last read through sequence 1040; no newer message present at final read.

## 5. Reproduction and final limits

WS2 reran V3 mapping review, producer DTO V1.0.1 validator, diagnostics V2.3.1 validator, and CommandRequest V1.2 validator: all PASS. V3 output explicitly limits proof to frozen snapshot and structural mapping. Existing Store renewal test result recorded earlier remains 6/6; standalone WorkerControl HTTP integration is still NOT WIRED.

No commit, push, ACL change, production operation, migration, or unrelated dirty-tree cleanup performed. The repository already contains broad dirty and untracked state outside WS2's review artifacts; these were left untouched.

**Overall:** structural WS8 mapping accepted with blockers on canonical export only; live/export reconciliation and WS3/WS7 reviews pending; V2.3.1 helper excluded from 29-code inventory; HTTP renewal integration NOT WIRED; Project Owner/Host Security NOT_ASSIGNED; contracts NOT_RATIFIED; production dispatch/cutover NOT_AUTHORIZED; release readiness NOT_PROVEN.

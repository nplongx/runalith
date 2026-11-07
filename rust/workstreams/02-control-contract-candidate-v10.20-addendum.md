# WS2 Control Contract Candidate V10.20 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.19 SHA-256 `56d92d8715d1ab3adca8c6ade51ad26943b78a724a0a9e10b422dcda9aa6a305`  
**Scope:** close WS3/WS7 mapping V3 reviews and correct WS2's copied-validator path defect.

## 1. WS1/WS3/WS7 exact mapping review dispositions

All three consumer workstreams have now independently accepted the WS8 mapping V1.0.1 canonical R5.4.2 bytes with blockers, limited to structural direct-payload mapping and explicitly not ratified:

- **WS1:** independent V3 validator PASS; `ACCEPTED_WITH_BLOCKERS_FOR_STRUCTURAL_ENVELOPE_MAPPING; DRAFT_NOT_RATIFIED` for canonical export snapshot only (A2A seq1039).
- **WS3:** exact-hash V3 oracle PASS; same structural-only disposition (A2A seq1099, message `642554aa-7595-46ff-91e1-90730b1a264c`).
- **WS7:** exact-hash review PASS; `ACCEPT WITH BLOCKERS` for mapping-only direct payload projection (WS8 relay seq1094, message `2943c805-85e4-4583-a782-1f8928e02f7b`).

Exact canonical mapping pins:

- Document `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`.
- Example `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`.
- Validator `dbd8f166f151d171a06e3ba5a9e91ec63519b0c207231d18805a807e0b324130`.

V3 fixture/test/doc remain immutable: `4ba40924a5952c666f4c9fcc561979a517fbc631186d82081591f028a5337195`, `ebe7812df65639e6b6c4e1044834f72b7b1ca39790b9a285399a4c4f1be1cdb9`, `d928717b725b72ee94942ba4d96f5b8bd5fcbb35e4488b638f6e2bd9782cdddb`. WS7's separate review archive SHA `ad61f632f45384c25ccbd60edd69174db51f22672504a508270c23db99797fba`; 11-entry source-manifest SHA `039d2b5feb24322b0d50ac134fd829630dd709959548a05eeab1c3f87e0488ab`. WS2 independently ran `sha256sum -c SOURCE-MANIFEST.sha256`, WS8 mapping validator and WS2 producer validator in WS7 snapshot: all PASS.

Accepted scope only: exact closed two-field diagnostic payload preserved unchanged; message type `runalith.control.domain-diagnostic.v1`; outer identity, authenticated producer, subject, effect class, correlation, causation and payload digest remain separate; `domain_code:null`/unknown future cause remains UNKNOWN/UNRESOLVED; MCP Error V1 stays `{code,message}`. No digest canonicalization, authenticated runtime identity/audience, runtime route/serializer, HTTP/retry, terminality, provider truth, authority or production behavior is accepted. Common Envelope and mapping remain DRAFT/NOT RATIFIED.

## 2. WS3-discovered copied-validator defect fixed by immutable successor

WS3 found the older WS2 copy of WS8's R5.4.2 mapping test referenced `08-common-envelope-v1.schema.json` and the unversioned mapping example, but WS2 had correctly frozen the dependencies under explicit snapshot names. WS2 reproduced the failure: expected Common Envelope SHA `ba01c0c9...`, actual wrong-path schema SHA `4d8361ce...`.

The original copied file remains unchanged. WS2 published a path-corrected immutable successor:

`02-ws8-control-domain-diagnostic-v1.0.1-envelope-mapping-R5.4.2.snapshot-test-v2.py` SHA-256 `7ed09e6ef8f1b11f2dd733375bd2fc067872e331b3a49ab5cf6dddae091e1974`.

The successor points to `02-ws8-common-envelope-v1.schema.snapshot.json`, corrected document/example snapshots, and pins the original WS8 validator SHA. Command from repo root:

```bash
python3 -B rust/workstreams/02-ws8-control-domain-diagnostic-v1.0.1-envelope-mapping-R5.4.2.snapshot-test-v2.py
```

Result: PASS all source/document/example/original-validator SHA pins; exact 29/29 mapping; wrong valid pair; duplicate/missing map/source rows; unknown future null/non-null policy; Common Envelope shape; six DTO negatives; MCP Error V1 closed. WS2 replied to WS3 with the fix and evidence (A2A `07bd4ded-0032-48c6-b550-aa293245ec25`). The V3 exact-hash review oracle itself was unchanged and already PASS.

## 3. Remaining export integrity and renewal boundaries

- WS8 live, canonical export and WS7 mapping document copies all hash `e8c60aaf...`; this is reconciled.
- R5.4.2 outer export still lacks `MANIFEST.sha256`; `python3 -B verify-export.py` returns `MANIFEST.sha256 missing or not a regular file`. Package integrity NOT VERIFIED. WS8 still needs to build the manifest, verify exact file set, and provide manifest/archive hashes. WS2 did not mutate the export.
- WS3 renewal prepared journal/parser tests PASS, including 20/20 control_http and 103+3 full worker crate, fmt and Clippy; journal remains not supervisor-integrated. Current Control HTTP server remains `Value -> Value`, `worker_control=None`, no Store-backed adapter, standalone route 503, no claim_id/receipt_id; end-to-end producer and retry receipt NOT PROVEN.
- Project Owner/Host Security remains NOT_ASSIGNED.

Latest WS2 inbox read through sequence **1099**. WS3 V3 review is closed as structural-only; WS7 final review evidence is recorded via WS8 relay; WS8 export manifest remains pending.

**Overall:** WS1/WS3/WS7 mapping V3 accepted with blockers for exact canonical mapping bytes only; copied-validator path defect corrected in a separate WS2-owned successor; R5.4.2 package integrity NOT VERIFIED; Control renewal producer/supervisor path NOT WIRED; authority NOT_ASSIGNED; contracts NOT_RATIFIED; production dispatch/cutover NOT_AUTHORIZED; release readiness NOT_PROVEN.

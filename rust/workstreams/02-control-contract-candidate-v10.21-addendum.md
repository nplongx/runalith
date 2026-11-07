# WS2 Control Contract Candidate V10.21 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.20 SHA-256 `f7355c71408c695a43cb19a7b735cb6939d3c3a0ec3581195f9c725b3c64ec07`  
**Purpose:** final evidence reconciliation for WS8 mapping V3, WS7 review archives and remaining package gate.

## 1. Mapping review gates closed (structural-only)

WS1, WS3 and WS7 have independently accepted WS8 ControlDomainDiagnostic mapping V1.0.1 for exact canonical R5.4.2 bytes with blockers, `DRAFT_NOT_RATIFIED`:

- WS1: A2A seq1039, PASS and `ACCEPTED_WITH_BLOCKERS_FOR_STRUCTURAL_ENVELOPE_MAPPING`.
- WS3: A2A seq1099, same bounded disposition. WS2 ACK/reply `07bd4ded-0032-48c6-b550-aa293245ec25` records WS2's corrected local snapshot-test path.
- WS7: WS8 relay A2A seq1094, `ACCEPT WITH BLOCKERS` for direct payload structural mapping only; WS1 independently confirmed this in seq1110.

All reviews pin the same canonical mapping document SHA `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`, example `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`, validator `dbd8f166f151d171a06e3ba5a9e91ec63519b0c207231d18805a807e0b324130`. Live WS8, canonical R5.4.2 export and WS7 review snapshot copies all agree on document hash.

No review ratifies digest canonicalization, authenticated host identity/audience, runtime route/serializer, HTTP/MCP behavior, retry, terminality, provider truth, authority, production or release readiness. Common Envelope/mapping remain DRAFT/NOT RATIFIED.

## 2. WS7 review archives and integrity evidence

Two separate WS7 review archives are retained; do not conflate them:

1. `WS8-MAPPING-V1.0.1-REVIEW-20261103.tar.gz` SHA-256 `991f4d9900d2b6b26a70603d2fb3cfbc2e66b3d84f30e3592f322be77e1ec848`; its 9-entry `SOURCE-MANIFEST.sha256` SHA `270e4761d187e6e07b90a299a44542695e7445757ebb8722d49abdb089dcb2cc`. WS2 ran `sha256sum -c SOURCE-MANIFEST.sha256`: all 9 entries PASS.
2. `WS2-WS8-MAPPING-R54.2-ORACLE-REVIEW-20261103.tar.gz` SHA-256 `ad61f632f45384c25ccbd60edd69174db51f22672504a508270c23db99797fba`; its 11-entry manifest SHA `039d2b5feb24322b0d50ac134fd829630dd709959548a05eeab1c3f87e0488ab`. WS2 ran `sha256sum -c SOURCE-MANIFEST.sha256`: all 11 entries PASS. It includes WS2 V3 oracle fixture/test and exact canonical document/example/original WS8 validator snapshots.

WS2 independently ran both mapping and producer validators in the WS7 review snapshot: PASS. The V3 oracle and the corrected WS2 snapshot-test successor also PASS.

## 3. WS2 copied WS8 validator path correction

WS3 found that the first WS2 copy of the WS8 mapping validator still referenced unversioned envelope-schema/example paths. WS2 reproduced the failure, preserved that earlier copy, and created:

`02-ws8-control-domain-diagnostic-v1.0.1-envelope-mapping-R5.4.2.snapshot-test-v2.py` SHA-256 `7ed09e6ef8f1b11f2dd733375bd2fc067872e331b3a49ab5cf6dddae091e1974`.

Command:

```bash
python3 -B rust/workstreams/02-ws8-control-domain-diagnostic-v1.0.1-envelope-mapping-R5.4.2.snapshot-test-v2.py
```

PASS: exact pins for producer schema/fixture/validator/doc, diagnostics source, frozen Common Envelope schema, canonical mapping document/example and original WS8 mapping-validator snapshot; exact 29/29 projection; wrong valid pair; duplicate/missing mapped/source rows; future unknown null/non-null policy; envelope projection; six DTO negatives; MCP Error V1 closed.

## 4. Remaining blockers — no change

- R5.4.2 outer export has no `MANIFEST.sha256`. WS2 reran `python3 -B verify-export.py` and it still returns `MANIFEST.sha256 missing or not a regular file`. Package integrity remains `NOT_VERIFIED`; WS8 must generate deterministic manifest, pass exact file-set verification, and return manifest/archive hashes. WS2 did not modify the export.
- WS3 renewal client journal/parser is tested (20/20 `control_http`; full worker 103 library +3 binary; fmt/Clippy PASS) but journal is not wired to supervisor. Control API remains untyped `Value -> Value`, worker authority unset, no Store-backed adapter, standalone worker routes fail closed with 503, no `claim_id`/`receipt_id` in current Store DTO. End-to-end renewal producer/supervisor recovery is NOT PROVEN.
- Project Owner/Host Security remains `NOT_ASSIGNED`; no production migration/dispatch authority.

WS2 inbox last read through sequence **1110**. WS3 and WS7 mapping V3 reviews are closed with bounded acceptance. WS8 export-manifest request remains pending.

**Overall:** WS8 mapping structural reviews closed across WS1/WS3/WS7 with blockers and no ratification; canonical mapping doc identity reconciled; WS7 archive manifests independently verified; WS8 copied validator corrected; R5.4.2 outer package still NOT VERIFIED; renewal producer/supervisor integration NOT WIRED; authority NOT_ASSIGNED; contracts NOT_RATIFIED; production dispatch/cutover NOT_AUTHORIZED; release readiness NOT_PROVEN.

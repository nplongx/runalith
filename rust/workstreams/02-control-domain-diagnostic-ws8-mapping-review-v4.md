# WS2 exact-hash cross-review: WS8 canonical R5.4.2 mapping V4 status

**Status:** `ACCEPTED_WITH_BLOCKERS_FOR_STRUCTURAL_ENVELOPE_MAPPING; DRAFT_NOT_RATIFIED`.

## Canonical bytes and reconciled identity

The corrected WS8 mapping V1.0.1 document, example and validator are pinned:

- Document SHA-256: `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`.
- Example SHA-256: `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`.
- Validator SHA-256: `dbd8f166f151d171a06e3ba5a9e91ec63519b0c207231d18805a807e0b324130`.

WS2 independently recomputed the mapping document hash at all three locations; all now equal `e8c60aaf...`:

1. WS8 isolated worktree: `/home/long/work/chatgpt-adapter-ws8-20261103/rust/workstreams/08-control-domain-diagnostic-v1.0.1-envelope-mapping.md`.
2. Canonical R5.4.2 export: `/home/long/work/WS8-R5.4.2-EXPORT-20261103/WS8/workstreams/08-control-domain-diagnostic-v1.0.1-envelope-mapping.md`.
3. WS7 review snapshot: `/home/long/work/ws7-evidence/ws8-mapping-v1.0.1-review-20261103/08-control-domain-diagnostic-v1.0.1-envelope-mapping.md`.

This supersedes the transient `99cc73c...` observation recorded in V3 review note lines 14-15. V3 note remains unchanged as historical evidence; this V4 note is the current identity statement.

## Independent review dispositions

- WS1: PASS; `ACCEPTED_WITH_BLOCKERS_FOR_STRUCTURAL_ENVELOPE_MAPPING; DRAFT_NOT_RATIFIED` (A2A seq1039).
- WS3: PASS; same mapping-only disposition (A2A seq1099, message `642554aa-7595-46ff-91e1-90730b1a264c`).
- WS7: PASS; `ACCEPT WITH BLOCKERS` for structural direct-payload projection only (WS8 relay seq1094, confirmed by WS1 seq1110).

WS7 evidence archive `WS2-WS8-MAPPING-R54.2-ORACLE-REVIEW-20261103.tar.gz` SHA-256 `ad61f632f45384c25ccbd60edd69174db51f22672504a508270c23db99797fba`; its 11-entry source manifest SHA `039d2b5feb24322b0d50ac134fd829630dd709959548a05eeab1c3f87e0488ab`; all 11 source files pass `sha256sum -c`. Separate earlier WS7 archive `WS8-MAPPING-V1.0.1-REVIEW-20261103.tar.gz` SHA-256 `991f4d9900d2b6b26a70603d2fb3cfbc2e66b3d84f30e3592f322be77e1ec848` remains separately retained.

## Reproduction

```bash
python3 -B rust/workstreams/02-control-domain-diagnostic-ws8-mapping-review-v3-test.py
python3 -B rust/workstreams/02-ws8-control-domain-diagnostic-v1.0.1-envelope-mapping-R5.4.2.snapshot-test-v2.py
```

Both WS2 validators PASS. V3 fixture SHA `4ba40924a5952c666f4c9fcc561979a517fbc631186d82081591f028a5337195`; V3 test SHA `ebe7812df65639e6b6c4e1044834f72b7b1ca39790b9a285399a4c4f1be1cdb9`; corrected copied-validator successor SHA `7ed09e6ef8f1b11f2dd733375bd2fc067872e331b3a49ab5cf6dddae091e1974`.

Tests cover exact dependency pins, unique 29/29 source pair projection; wrong valid pair; duplicate/missing mapping rows; duplicate/missing authoritative rows; future unknown/null preserved as UNKNOWN/UNRESOLVED; future unknown/non-null rejected; direct Common Envelope payload; six DTO negatives; MCP Error V1 remains closed `{code,message}`.

## Limits

Accepted only for structural mapping of the frozen R5.4.2 mapping bytes. No canonical digest profile, auth/audience, runtime route/serializer, HTTP/retry, terminality, provider truth, authority or production ratification. Common Envelope and mapping remain DRAFT/NOT RATIFIED.

R5.4.2 outer export package remains independently unverified: `python3 -B verify-export.py` fails `MANIFEST.sha256 missing or not a regular file`. Mapping-file identity reconciliation does not imply package/archive integrity.

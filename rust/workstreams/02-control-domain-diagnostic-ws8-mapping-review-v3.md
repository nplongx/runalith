# WS2 exact-hash cross-review: WS8 canonical R5.4.2 mapping

Status: ACCEPTED_WITH_BLOCKERS_FOR_STRUCTURAL_ENVELOPE_MAPPING; DRAFT_NOT_RATIFIED.

Canonical WS8 R5.4.2 export snapshots are pinned and recomputed by the V3 validator:
- Mapping doc `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`.
- Example `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`.
- Validator `dbd8f166f151d171a06e3ba5a9e91ec63519b0c207231d18805a807e0b324130`.

Command: `python3 -B rust/workstreams/02-control-domain-diagnostic-ws8-mapping-review-v3-test.py`.

V3 reuses V2 exact-pair and mutation checks, while pinning the canonical R5.4.2 export doc bytes. Expected PASS includes exact byte SHA, unique 29/29 cause/domain map, wrong valid pair, duplicate/missing mapped/source rows, future unknown cause/null preserve, unknown/non-null reject, Common Envelope example and MCP V1 closed.

The canonical R5.4.2 document corrects the producer version label to `1.0.1-draft`. However the WS8 isolated live worktree still hashes to the prior `99cc73c...` document while the export snapshot hashes `e8c60aaf...`. Thus export content correction is verified, but WS8 live-worktree/export identity reconciliation remains pending. Do not claim the live source tree is corrected until WS8 confirms.

Structural mapping only. No runtime route, digest canonicalization, auth, HTTP/retry, terminality, authority or production proof.

Fixture SHA `4ba40924a5952c666f4c9fcc561979a517fbc631186d82081591f028a5337195`; validator SHA `ebe7812df65639e6b6c4e1044834f72b7b1ca39790b9a285399a4c4f1be1cdb9`.

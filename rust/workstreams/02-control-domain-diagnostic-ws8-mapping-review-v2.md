# WS2 exact-hash cross-review: WS8 mapping R3

Status: ACCEPTED_WITH_BLOCKERS_FOR_STRUCTURAL_ENVELOPE_MAPPING; DRAFT_NOT_RATIFIED.

WS2 froze byte-identical WS8 R3 snapshots and independently recomputes their SHA-256 in the review validator:
- mapping doc `99cc73c032c0706be4138847ccfe2f064cda9c025a9149023778e8535180a3eb`
- example `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`
- validator `dbd8f166f151d171a06e3ba5a9e91ec63519b0c207231d18805a807e0b324130`
- Common Envelope schema `ba01c0c9f973ace4d4b438307338fef1f18e45f99dba2929ddd33696cbee18b2`

Reproduction: `python3 -B rust/workstreams/02-control-domain-diagnostic-ws8-mapping-review-v2-test.py`.

PASS: byte hashes for WS8 R3 and all producer/envelope dependencies; exact unique 29/29 cause-domain pairs; wrong valid pair rejected; duplicate/missing mapped rows rejected; duplicate/missing source rows rejected; unknown future cause/null preserved UNKNOWN/UNRESOLVED; unknown future cause/non-null rejected; Common Envelope example; six DTO negatives; MCP Error V1 closed.

One explicit blocker remains: WS8 R3 document contains stale producer version text `1.0.0-draft`; referenced WS2 DTO is `1.0.1-draft`. WS1 asks for WS8 V1.0.2/errata; no final exact content acceptance until corrected. Snapshot is unchanged.

Mapping accepted structurally only: unchanged payload, message_type `runalith.control.domain-diagnostic.v1`, outer identity/subject/correlation/causation and payload_digest separate. No runtime, digest canonicalization, auth, HTTP/retry, terminality, or production proof.

WS2 oracle fixture SHA `9a040442297d8cfbe4d35de75ce6abeddd39381a1f33104dd7081201dfdb65ed`; validator SHA `cccc0d7c81ab024522b3db44eddc9790f8d2410e63bca55b4cbd236900c404b1`.

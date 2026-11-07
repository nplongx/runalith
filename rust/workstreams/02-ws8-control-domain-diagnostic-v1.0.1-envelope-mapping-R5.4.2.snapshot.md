# WS8 mapping proposal V1.0.1: ControlDomainDiagnosticV1.0.1 in Common Envelope v1

**Revision: WS8 mapping V1.0.1. Status: DRAFT / NOT RATIFIED / mapping-only.** Producer owner: WS2. Transport mapping owner: WS8. No route, HTTP, retry, terminality, authentication or production authority is approved. This proposal does not change MCP service/error V1 (`{code,message}`), Common Envelope v1.0.0 schema, or any producer's signed/canonical bytes.

## Exact producer inputs

WS2 contract ID: `urn:runalith:contracts:control-domain-diagnostic:v1.0.1` (`ControlDomainDiagnosticV1.0.1`, version `1.0.1-draft`). The closed producer schema requires exactly:

- `domain_code`: one of `AUTHENTICATION_FAILED`, `AUTHORITY_UNAVAILABLE`, `IDEMPOTENCY_CONFLICT`, `MALFORMED_REQUEST`, `SUBJECT_MISMATCH`, or `null` when WS2 marks the source case `REVIEW_REQUIRED`/unmapped.
- `cause_code`: exact case-sensitive source code string; preserve byte-for-byte and do not alias, shorten, lowercase, derive or replace it with `domain_code`.

Pinned WS2 producer artifacts:

| Artifact | SHA-256 |
|---|---|
| `02-control-domain-diagnostic-v1.0.1.schema.json` | `445a7fe8d8c88d7ffd22389ee3cfeeaa553878d55565990633e2feb14a192cfb` |
| `02-control-domain-diagnostic-v1.0.1.fixtures.json` | `d702db8a4ddf0a9b2b0d96115b182adca3d471f82d1531c47bf2258b8ea25af3` |
| `02-control-domain-diagnostic-v1.0.1-test.py` | `e54daa19579603a2a7c4410e25a860d6631667e564864144b368886de6a574d8` |
| `02-control-domain-diagnostic-v1.0.1.md` | `7c5998d57678325c25abe9c400dde02d7d76ac50c0b421120307d7ae4ad7c5bf` |

The v1.0.1 producer validator passed 29 exact source projections, six negative cases and an explicit future-unknown cause case. V1.0.1 preserves syntactically valid unknown future cause_code values verbatim; receivers must retain UNKNOWN/UNRESOLVED and never infer a domain category, success or retry. This is structural evidence only, not runtime route or semantic ratification.

## Mapping

For a route that has independently chosen a Common Envelope response, map the exact `ControlDomainDiagnosticV1` object directly to the outer envelope `payload` (no wrapper, field rename, normalization or flattening). Suggested message type: `runalith.control.domain-diagnostic.v1`; `message_kind=response`.

| Envelope field | Mapping rule |
|---|---|
| `schema_version` | Common Envelope wire version, distinct from producer DTO `1.0.1-draft`. Current proposal is v1.0.0 only. |
| `message_type` | `runalith.control.domain-diagnostic.v1` for this typed payload profile. |
| `message_id` | Unique outer response identity; never reuse the producer `cause_code`, domain code or request ID. |
| `producer_id` | Inject from authenticated host/service context; never trust a payload-supplied producer identity. |
| `created_at` | Host-created UTC timestamp with `Z`; not proof of source freshness. |
| `correlation_id` | Preserve the exact request correlation ID. |
| `causation_id` | Exact outer request `message_id` that caused this response. |
| `effect_class` | Route-derived classification; do not infer it from either diagnostic code. |
| `idempotency_key` | Include when required by the route's mutating effect class; preserve the route's exact operation key. |
| `subject` | Preserve the exact request subject and bindings; do not derive subject identity from diagnostic fields. |
| `payload_digest` | Separate SHA-256 over exact payload bytes under a producer-approved named canonicalization profile. This proposal does not select or ratify that profile. Never copy a domain digest or `cause_code` into it. |
| `payload` | Exact closed two-field WS2 DTO, unchanged. |

The Common Envelope schema `urn:runalith:workstreams:08:common-envelope:v1.0.0` SHA-256 `ba01c0c9f973ace4d4b438307338fef1f18e45f99dba2929ddd33696cbee18b2` permits a generic object payload. That structural openness does not itself validate this producer DTO; consumers must validate `payload` against the exact WS2 schema hash above. The envelope schema and this mapping remain DRAFT / NOT RATIFIED.

## Explicit non-mappings and fail-closed boundaries

- Do not put these fields into MCP service/error V1 `{code,message}`; it is closed and remains unchanged.
- Do not collapse `domain_code` and `cause_code`, infer HTTP status, retryability, terminality, admission, trust or authorization from either field.
- `domain_code=null` means unresolved mapping, not success, absence of error, approval or authorization.
- `cause_code` is an opaque exact source identifier, not a transport error identifier.
- Common Envelope v1 has no explicit audience field. Audience/principal/peer authorization remains authenticated out-of-band host context; this mapping does not create or assert it.
- The outer `payload_digest` is a separate digest domain; signed inner payloads retain their producer-owned bytes and signature preimages.
- No route, dispatch, HTTP adapter, runtime serializer, database transaction or production trust/nonce authority is implemented by this proposal.

## Evidence and next gate

The standalone versioned mapping validator recomputes exact SHA-256 pins for the WS2 v1.0.1 schema/fixture/validator/doc, WS2 v2.3.1 source fixture and W8 envelope schema; asserts a one-to-one exact 29-code cause-to-domain projection with no duplicates or missing rows; checks direct pass-through and outer response shape; and preserves a syntactically valid unknown future cause verbatim only with `domain_code=null`; a non-null domain attribution is rejected. The harness also contains mutation tests for a wrong-but-valid known domain, duplicate/missing mapped rows, duplicate/missing authoritative source rows, and unknown future cause with a non-null domain. It does not verify payload digest canonicalization, cryptographic identity, host authentication, route behavior, HTTP/retry policy or cross-workstream ratification. Before any runtime use, WS2 must ratify its producer DTO; WS1/2/3/7 must review the transport profile; the Common Envelope must be separately ratified; and an accountable human owner must approve route/authority boundaries. The current mapping test uses versioned filenames; the earlier unversioned filenames are not used for this revision. Current accountable human WS8 owner: `UNASSIGNED`.


### Immutable revision history

The prior WS8 V1.0.0 reviewed hashes and decisions are retained in `08-control-domain-diagnostic-v1.0.0-mapping-review-history.json`. The prior artifact bodies could not be recovered from the available worktrees or exports; the history file records the original hashes and explicitly avoids claiming byte reconstruction. V1.0.1 uses separate versioned filenames.

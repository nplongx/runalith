# WS2 ControlDomainDiagnosticV1 Route Payload

**Status:** `DRAFT_NOT_RATIFIED`  
**Owner:** WS2 (Control producer semantics)  
**Purpose:** typed, route-specific response payload preserving exact `domain_code` and `cause_code` as separate fields.

## Schema

- Schema ID: `urn:runalith:contracts:control-domain-diagnostic:v1`
- Schema file: `02-control-domain-diagnostic-v1.schema.json`
- Required fields: `domain_code`, `cause_code`
- `domain_code`: one of `MALFORMED_REQUEST`, `SUBJECT_MISMATCH`, `AUTHENTICATION_FAILED`, `AUTHORITY_UNAVAILABLE`, `IDEMPOTENCY_CONFLICT`, or `null` when source/phase attribution remains `REVIEW_REQUIRED`.
- `cause_code`: exact, case-sensitive source cause string; preserve verbatim.
- `additionalProperties: false`; no aliases, flattening or unknown fields.

The DTO contains only diagnostic identity. It does not carry HTTP status, retryability, terminality, admission, authority, provider outcome, or envelope identity/digest. A null `domain_code` means no proposed domain attribution; it does not mean success, no error, or terminality.

## Transport boundary

WS8 confirms there is no existing typed/versioned route diagnostic response DTO in its current R5.4 snapshot. Common Envelope V1 has an open `payload` object but does not define this DTO. MCP `McpServiceErrorV1` remains closed `{code,message}` and must not be extended or repurposed. This schema is intended as the WS2-owned typed payload that WS8 may later map into Common Envelope `payload`; outer `payload_digest` remains a distinct envelope field.

No route implementation or Common Envelope mapping is claimed. WS8 mapping/profile artifact requires this exact schema/hash plus WS1/WS2/WS3/WS7 consumer review. WS2 owns payload semantics; WS8 owns wire mapping mechanics.

## Fixture projection

The fixture projects all 29 cause/domain pairs from Diagnostics V2.3.1 and includes six negative cases: missing each required field, unknown domain, lowercase cause, unknown field, and wrong domain type. `domain_code:null` remains representable for unresolved mappings.

## Reproduction

```bash
python3 -B -m json.tool rust/workstreams/02-control-domain-diagnostic-v1.schema.json >/dev/null
python3 -B -m json.tool rust/workstreams/02-control-domain-diagnostic-v1.fixtures.json >/dev/null
python3 -B rust/workstreams/02-control-domain-diagnostic-v1-test.py
```

The validator checks fixture projection and a closed-object structural profile. It is not a standards-complete JSON Schema implementation, runtime serializer, route integration, Common Envelope mapping, HTTP/retry behavior, cryptographic proof or authority verification.

## Exact hashes

- Schema: `d7a8e65543c5e97dac02a0794624c1ea7c7dc1cf300467c0ac982ebc346138fd`
- Fixture: `a1a1a7881472f6d8ba57e1a06c29d1c22e01babfd3180b9e9d8779d537afcf36`
- Validator: `c50c4cbbb9d0b0c2ef462f5a6329e3469278833725be1f475cd1c43396d6ebcb`
- Document: calculate after final write.

**Disposition:** proposal for cross-workstream review; `DRAFT_NOT_RATIFIED`; no route/production activation.

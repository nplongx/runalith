# WS2 ControlDomainDiagnosticV1.0.1 Route Payload

**Status:** `DRAFT_NOT_RATIFIED`  
**Owner:** WS2 (Control producer semantics)  
**Supersedes:** V1.0.0 schema `d7a8e65543c5e97dac02a0794624c1ea7c7dc1cf300467c0ac982ebc346138fd`, fixture `a1a1a7881472f6d8ba57e1a06c29d1c22e01babfd3180b9e9d8779d537afcf36`, validator `c50c4cbbb9d0b0c2ef462f5a6329e3469278833725be1f475cd1c43396d6ebcb`, document `314af74d13fd6973d5fd61634c56becca41577c5ee8befdb841c6ee71e559ff2`.

## Schema shape

- Schema ID: `urn:runalith:contracts:control-domain-diagnostic:v1.0.1`
- Required fields: `domain_code`, `cause_code`
- `domain_code`: one of `MALFORMED_REQUEST`, `SUBJECT_MISMATCH`, `AUTHENTICATION_FAILED`, `AUTHORITY_UNAVAILABLE`, `IDEMPOTENCY_CONFLICT`, or `null` when mapping is unresolved / `REVIEW_REQUIRED`.
- `cause_code`: exact, case-sensitive source cause string. Preserve verbatim.
- `additionalProperties: false`; no aliases or flattening.

## Receiver forward-compatibility rule

A syntactically valid but unrecognized future `cause_code` must be preserved byte-for-byte/string-for-string as received and treated as `UNKNOWN` / `UNRESOLVED`. Receiver must not infer `AUTHENTICATION_FAILED`, success, retryability, terminality or admission. The schema intentionally permits future uppercase cause identifiers instead of enumerating only the current 29 codes. `domain_code:null` does not mean success or absence of an error.

## WS1 review corrections

V1.0.1 adds actual SHA-256 computation of the source Diagnostics V2.3.1 fixture in the validator; checks exact unique 29/29 cause-code set coverage (not only row count); and adds a forward-compatibility unknown-cause fixture. The payload shape remains unchanged.

## Transport boundary

WS8 confirmed no existing typed/versioned route diagnostic response DTO exists in R5.4. Common Envelope V1 has an open `payload` object but does not define this DTO. MCP `McpServiceErrorV1` remains closed `{code,message}` and must not be extended or repurposed. This schema is a WS2-owned route payload proposal. WS8 may later define its own mapping/profile into Common Envelope `payload`, preserving outer subject/correlation/causation and `payload_digest` independently. No HTTP, retry, terminality, admission, authority, provider outcome or envelope identity semantics are defined here.

## Reproduction

```bash
python3 -B -m json.tool rust/workstreams/02-control-domain-diagnostic-v1.0.1.schema.json >/dev/null
python3 -B -m json.tool rust/workstreams/02-control-domain-diagnostic-v1.0.1.fixtures.json >/dev/null
python3 -B rust/workstreams/02-control-domain-diagnostic-v1.0.1-test.py
```

Validator performs source-fixture byte-hash verification, exact 29-code set/uniqueness and pair projection, closed-object structural checks, six negative mutations and unknown-future-code preservation. It is not a standards-complete JSON Schema implementation, runtime serializer, route integration, Common Envelope mapping, HTTP/retry behavior, cryptographic proof or authority verification.

## Exact hashes

- Schema: `445a7fe8d8c88d7ffd22389ee3cfeeaa553878d55565990633e2feb14a192cfb`
- Fixture: `d702db8a4ddf0a9b2b0d96115b182adca3d471f82d1531c47bf2258b8ea25af3`
- Validator: `e54daa19579603a2a7c4410e25a860d6631667e564864144b368886de6a574d8`
- Document: calculate after this hash table is finalized.

**Disposition:** proposal for WS1/WS3/WS7/WS8 review; `DRAFT_NOT_RATIFIED`; no route/production activation.

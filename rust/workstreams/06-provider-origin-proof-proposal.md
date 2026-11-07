# WS6 proposal — Provider origin proof and Governance verifier contract

**Status:** PROPOSED / NOT RATIFIED. No provider trust domain, issuer, audience, scope, root, signing key, nonce owner, production service or provider dispatch is selected or provisioned by this document. This is a verifier contract proposal for review by WS4, WS8 and the Project/Host authority owner.

## 1. Security conclusion

A response body plus SHA-256 proves only that the observed bytes match a digest. A locally selected provider account string, HTTP status, successful poll, or TLS encryption by itself does not create a portable independently verifiable terminal proof. ProviderTerminalProofVerifier must return a fail-closed verified result only when an approved source-authentication model binds the complete dispatch subject, provider/account/run identity, exact terminal result and response bytes to an independently trusted issuer.

The current W4 ProviderTerminalProofV1 and injected verifier are draft port shapes. W4 explicitly does not claim that raw response bytes or TLS alone constitute a Governance receipt. W6 supplies no permissive verifier.

## 2. Two mutually exclusive proof modes (owner must choose)

### A. Provider-native signed proof

The provider signs a detached or embedded proof with a provider-controlled signing key. W4 must demonstrate that the provider actually publishes verifiable signing material and guarantees the signed fields. WS6 verifies the provider signature under an independently administered provider-origin trust configuration. A response digest without the provider signature is insufficient.

### B. Authenticated adapter-read observation

Where the provider offers no signed proof, an explicitly appointed trusted adapter/observation authority may sign an observation receipt after performing an authenticated provider read. This proves that the trusted adapter observed exact bytes from a configured authenticated endpoint; it is **not** a provider-native signature and must be reported as a distinct proof mode. The signed record must include endpoint hostname and scheme, HTTP method and normalized path/query identity, TLS peer SPKI/certificate fingerprint, authenticated client identity where applicable, provider account/run, request correlation, response status, exact response byte digest/length/media type and observation time. The adapter signing identity and its root/key lifecycle require a separately appointed custodian. A locally configured account ID or unsigned adapter log is not sufficient.

The two modes cannot be silently substituted for each other. A deployment must explicitly ratify which mode(s) a named provider/account supports and how the authenticated endpoint/key registry is administered.

## 3. Candidate signed envelope (field contract only)

A future versioned envelope should be a closed object with no unknown fields and at minimum bind:

**Envelope and authority**
- schema version; proof kind; explicit proof mode (provider_native_signature or authenticated_adapter_observation); algorithm; issuer; audience; scope; provider ID; provider account ID;
- key ID; trust-root SPKI SHA-256; exact typed trust snapshot reference and its digest (including numeric config version and complete configuration fingerprint);
- unique nonce; canonical issued-at and expiry; full signed-envelope digest returned by the verifier.

**Exact dispatch subject**
- workflow ID; task ID; claim ID; attempt ID; owner epoch; lease ID; worker ID;
- Control fence ID and the exact authenticated Control receipt digest; ACL digest; side-effect ID;
- immutable dispatch request digest; provider idempotency key; plan digest; request payload digest;
- provider run ID and account identity selected before dispatch.

**Exact terminal observation**
- terminal conclusion and provider status as distinct typed values; response body SHA-256, exact byte length and media type; response/request correlation or provider event ID;
- in authenticated-adapter mode: authenticated endpoint identity and TLS peer fingerprint, HTTP request identity and observation time, plus the adapter/observation authority identity.

No field is accepted as authoritative merely because it is present in the envelope. The verifier host pins the expected issuer, audience, scope, provider and account and compares every subject field to the immutable W4 dispatch intent and authenticated W2/W3 fence supplied over public ports. The exact response bytes delivered to W5 must hash to the signed response digest. ArtifactRefV1 records byte custody and provenance; it is not a substitute for signature/origin verification.

## 4. Signed-byte and trust rules (proposed, not frozen)

- Candidate preimage: an authority-approved proof-domain label, one NUL byte, then RFC 8785/JCS canonical UTF-8 bytes of the closed envelope with only signature removed. The actual domain label and schema version must be assigned by the Project/Host authority owner; this document deliberately does not mint one.
- Ed25519 signatures must decode as canonical standard Base64 to exactly 64 bytes. Noncanonical Base64, unknown fields, duplicate/ambiguous identity, wrong algorithm, malformed timestamps or a mismatched full-envelope digest fail closed.
- Trust must be provider/account-scoped as ratified by the authority owner. Do not reuse execution_approval, goal_idea_verifier, GovernanceApprovalReceiptV1, or a WS7 source-attestation domain implicitly. The current TRUST_DOMAIN_SPECS has exactly five other domains; TrustSnapshotRefV1 cannot identify a provider-origin domain today. No domain expansion is authorized here.
- Issuer, audience, scope, provider ID and provider account are host-pinned. Validate key validity at issue and verification time, revocation, current trust high-water, configuration anti-rollback and bounded TTL/future-skew. A stale/unobserved/rolled-back trust configuration is UNKNOWN/UNRESOLVED, never a provider rejection.
- Replay nonce is distinct from W4 dispatch idempotency and WS2 Control fence nonce. Bind it to signed-envelope digest, terminal subject digest and response digest. Exact byte-identical replay is idempotent; changed binding conflicts; missing/unavailable nonce authority yields unavailable/unknown and no lease settlement.
- Re-check current trust/revocation immediately before the Control commit fence. The exact transaction, nonce persistence, inbox/outbox and freshness-to-settlement ordering cannot be promised across DBs until D-01 is decided. No two-DB SQLite pseudo-transaction is acceptable.

## 5. Verifier result and downstream responsibility

WS6 should expose a narrow ProviderOriginProofVerifier port or the approved ProviderTerminalProofVerifier implementation through public types only. Its successful result is an opaque authenticated proof receipt binding proof mode, provider/account/run, full subject digest, response digest, issuer/key/root/config snapshot, nonce disposition, issued/expiry times and signed-envelope digest. A signed proof of provider observation is not itself the Control lifecycle decision.

- W4 owns provider adapter, provider account configuration, immutable intent, provider run, request/response bytes and NOT_SENT/ACCEPTED/REJECTED/UNKNOWN observation state.
- WS6 owns signature/trust verification and approved trust-domain/key/replay policy; it does not own provider effects or workflow settlement.
- WS2 owns Control lifecycle and final settlement/CAS, using the verified proof and current fence in its approved transaction.
- WS3 owns worker/process observations and journal; local cgroup/process termination is not provider terminal proof.
- WS5 owns response artifact bytes and manifest; an artifact reference is not an authenticated provider claim.
- WS8 owns the common wire envelope and Gateway publication/transport contract.

UNKNOWN, unavailable trust, invalid origin or stale subject must not release the lease, authorize success, trigger an automatic resend or be converted to NOT_SENT. A verified provider REJECTED terminal response remains a provider outcome, not an authentication failure. An authenticated proof may not rewrite the W2 lifecycle independently.

## 6. Acceptance evidence required

1. Provider-specific signed proof or authenticated-read endpoint model, exact trust-root provenance, provider-account isolation and named issuer/key custodian.
2. Node/Rust golden vector with exact domain-separated preimage bytes, digest, signature and response-body bytes; negative vectors for wrong issuer/audience/account/run, changed attempt/owner epoch/lease/fence/ACL/side-effect/idempotency/plan/payload/response hash, wrong mode, noncanonical Base64, tampered signature and unknown fields.
3. Key validity, expiry/future-skew, revocation, high-water rollback/currentness, wrong endpoint or TLS peer, and exact provider/account config binding.
4. Exact replay, nonce conflict, concurrency/restart and unavailable-storage tests against a production-owned durable port when that owner and D-01 contract exist. The current cfg(test) SQLite evidence is test-only.
5. Public-port integration proves W4 cannot settle from raw bytes, W6 cannot read W4 private DB, and WS2 cannot settle without the exact current verified proof in the approved commit fence.
6. Timeout, provider UNKNOWN, late/reordered response, process crash, stale trust, nonce-store outage and revocation race remain non-authorizing and non-retrying unless an explicit owner-ratified recovery contract says otherwise.

## 7. Required owner decisions

- Project/architecture Owner: choose provider-native signature vs authenticated adapter observation per provider; name the trusted source authority and accountable human owner; approve distinct domain/issuer/audience/scope; name root/key provisioning, rotation/revocation and incident custodian; approve nonce/replay authority and D-01 persistence/commit fence.
- WS4: supply exact provider API proof semantics or authenticated-read endpoint/identity contract, immutable provider/account/run/intent binding, terminal-status semantics, source hashes and producer tests; identify which provider and account are covered.
- WS2: publish the exact Control fence public contract and atomic settlement/freshness/currentness transaction boundary.
- WS8: ratify the common envelope fields and domain/cause preservation without merging auth, origin, evidence or lifecycle outcomes.

Until those decisions exist, this remains PROPOSED / NOT RATIFIED. No wire DTO, trust domain, key, signer, durable nonce adapter, provider route, production verification, settlement, migration or dispatch is implemented or authorized by this draft.

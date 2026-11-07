# WS6 Trust source snapshot V2.3.4

**Status:** `DRAFT_NOT_RATIFIED`  
**Owner:** WS6  
**Consumer:** WS2, for the immutable successor to its V2.3.3 bounded Trust error-origin map.

## Predecessor and purpose

This source snapshot succeeds the WS2 V2.3.3 live-source evidence without modifying it. The exact predecessor pins are:

- Fixture `02-control-domain-error-diagnostics-v2.3.3-live-source.fixtures.json`: `ee6e40c56bb0785d08c375bd3c6cae1dcbbd53499094845bf692960bc542f66b`.
- Validator `02-control-domain-error-diagnostics-v2.3.3-live-source-test.py`: `ff4d7aa07659f570a44d6c4d49e74edb496339b8da5bb7fc398bea7aa9f25267`.
- Note `02-control-domain-error-diagnostics-v2.3.3-live-source-note.md`: `9bfa4cc1175c7acf25d315315e82ffe895d8d9fd494a4d8f4ebcae1e1ee06668`.

V2.3.3 remains immutable. This successor is a read-only, seven-file whole-source pin map. It does not add a public error code or change any schema, DTO, trust domain, issuer/audience, nonce, persistence, or authority contract.

## Current snapshot

The exact seven current Trust source hashes and predecessor-drift flags are machine-readable in `06-trust-source-snapshot-v2.3.4.json`; run `python3 -B rust/workstreams/06-trust-source-snapshot-v2.3.4-test.py` to recheck all hashes and anchors. Only `approval_decision.rs` and `lib.rs` differ from the V2.3.3 pins. The prior `lib.rs` intermediate hash `7dff6b9f...` is superseded; the final Cargo-formatted live hash is the JSON-pinned value.

`lib.rs` current anchors:
- `TrustError::code`: lines 94–108.
- `map_public_key_parse_failure`: lines 227–243.
- `classify_signature_verification_output`: lines 245–261.
- Ambiguous OpenSSL exit-code regression test: lines 428–466.

`approval_decision.rs` current anchors:
- `verify_approval_evidence`: lines 151–166.
- `verify_approval_evidence_envelope`: lines 173–227.
- `verify_approval_evidence_with_mode`: lines 229–250.
- canonical comparison helper: lines 1059–1065.

**Important limitation:** V2.3.3 preserved the prior whole-file hash for `approval_decision.rs`, but not its prior source bytes. The present successor therefore records whole-file hash drift and current line anchors only. It does not claim the exact changed hunk or distinguish semantic change from formatting-only change for that path.

## Verification lineage

The same final formatted 14-module Trust snapshot was previously verified with:

```sh
CARGO_TARGET_DIR=/dev/shm/ws6-error-taxonomy-target-20261104 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path rust/Cargo.toml -p runalith-trust --locked --offline --jobs 1 -- --test-threads=1
# 91 passed, 0 failed, 0 ignored; doc-tests 0/0; exit 0

CARGO_TARGET_DIR=/dev/shm/ws6-error-taxonomy-target-20261104 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy --manifest-path rust/Cargo.toml -p runalith-trust --all-targets --locked --offline --jobs 1 -- -D warnings
# PASS; exit 0

cargo fmt --manifest-path rust/Cargo.toml -p runalith-trust -- --check
# PASS; exit 0
```

The current seven hashes were rechecked while producing this successor. Cargo was not rerun during this successor capture because other workstreams had active Cargo jobs on separate target directories. The validator rechecks source and predecessor identity, not execution history.

## Disposition

`DRAFT_NOT_RATIFIED / SOURCE_SNAPSHOT_PUBLISHED`. WS2 may consume the exact snapshot as input to its independently versioned V2.3.4 consumer artifact. The snapshot is not a production-trust claim, project decision, D-01/D-02 resolution, or authorization to provision keys, signer, verifier, reviewer, provider, or nonce authority.

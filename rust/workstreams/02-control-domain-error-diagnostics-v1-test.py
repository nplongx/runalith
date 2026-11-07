#!/usr/bin/env python3
"""Structural crosswalk test for DRAFT WS6 diagnostic subcodes in WS2 errors."""
from __future__ import annotations
import json
from pathlib import Path
FIXTURE = Path(__file__).with_name("02-control-domain-error-diagnostics-v1.fixtures.json")
EXPECTED = {
 "GOVERNANCE_RECEIPT_SIGNATURE_ENVELOPE_INVALID": "AUTHENTICATION_FAILED",
 "AGG_APPROVAL_SIGNATURE_INVALID": "AUTHENTICATION_FAILED",
 "GOVERNANCE_RECEIPT_IDENTITY_UNAUTHORIZED": "AUTHENTICATION_FAILED",
 "GOVERNANCE_RECEIPT_BINDING_INVALID": "SUBJECT_MISMATCH",
 "PAYLOAD_MISMATCH": "SUBJECT_MISMATCH",
 "DIGEST_MISMATCH": "SUBJECT_MISMATCH",
 "TRUST_SNAPSHOT_MISMATCH": "SUBJECT_MISMATCH",
 "AGG_TRUST_CONFIG_NOT_OBSERVED": "AUTHORITY_UNAVAILABLE",
 "AGG_TRUST_CONFIG_ROLLBACK": "AUTHORITY_UNAVAILABLE",
 "AGG_TRUST_ROOT_REVOKED": "AUTHORITY_UNAVAILABLE",
 "AGG_TRUST_ROOT_OUTSIDE_VALIDITY": "AUTHORITY_UNAVAILABLE",
 "GOVERNANCE_RECEIPT_NONCE_CONFLICT": "IDEMPOTENCY_CONFLICT",
 "GOVERNANCE_RECEIPT_NONCE_LEDGER_UNAVAILABLE": "AUTHORITY_UNAVAILABLE",
}

def main() -> int:
    d = json.loads(FIXTURE.read_text(encoding="utf-8"))
    rows = d["cases"]
    actual = {r["cause_code"]: r["domain_code"] for r in rows}
    assert actual == EXPECTED, (actual, EXPECTED)
    assert len(rows) == len(actual)
    assert all(r["automatic_retry"] is False for r in rows)
    assert all(r["resolution"] in {"REJECTED", "UNKNOWN", "UNRESOLVED", "CONFLICT"} for r in rows)
    assert all(r["cause_code"] != "AUTHORITY_UNAVAILABLE" for r in rows)
    print("PASS exact WS6 cause-code inventory and WS2 domain grouping")
    for row in rows:
        if row["domain_code"] == "AUTHORITY_UNAVAILABLE":
            assert row["cause_code"] in EXPECTED and row["resolution"] in {"UNKNOWN", "UNRESOLVED"}
    print("PASS AUTHORITY_UNAVAILABLE retains precise cause_code and UNKNOWN/UNRESOLVED")
    nonce = next(r for r in rows if r["cause_code"] == "GOVERNANCE_RECEIPT_NONCE_CONFLICT")
    assert nonce["domain_code"] == "IDEMPOTENCY_CONFLICT" and nonce["automatic_retry"] is False
    print("PASS nonce rebinding is non-retryable IDEMPOTENCY_CONFLICT")
    rejected = d["valid_rejected_receipt"]
    assert rejected["decision"] == "Rejected" and rejected["domain_code"] is None
    assert rejected["admission_authorized"] is False and rejected["transport_error"] is False
    print("PASS valid signed Rejected remains a domain decision, not transport/auth error")
    print("LIMIT: structural fixture only; no verifier/runtime/API behavior or ratification")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

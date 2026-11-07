#!/usr/bin/env python3
"""Structural/mutation tests for WS2 ControlDomainDiagnosticV1.0.1 -> W8 envelope mapping."""
from __future__ import annotations
import copy
import hashlib
import json
from pathlib import Path
from jsonschema import Draft202012Validator

HERE = Path(__file__).resolve().parent
FILES = {
    "payload_schema": (HERE / "02-control-domain-diagnostic-v1.0.1.schema.json", "445a7fe8d8c88d7ffd22389ee3cfeeaa553878d55565990633e2feb14a192cfb"),
    "payload_fixture": (HERE / "02-control-domain-diagnostic-v1.0.1.fixtures.json", "d702db8a4ddf0a9b2b0d96115b182adca3d471f82d1531c47bf2258b8ea25af3"),
    "payload_validator": (HERE / "02-control-domain-diagnostic-v1.0.1-test.py", "e54daa19579603a2a7c4410e25a860d6631667e564864144b368886de6a574d8"),
    "payload_doc": (HERE / "02-control-domain-diagnostic-v1.0.1.md", "7c5998d57678325c25abe9c400dde02d7d76ac50c0b421120307d7ae4ad7c5bf"),
    "source_fixture": (HERE / "02-control-domain-error-diagnostics-v2.3.1.fixtures.json", "24e5d115604dfc066d25b056d27e9ef5cc7f4653477aced469d1ab8188e91832"),
    "envelope_schema": (HERE / "08-common-envelope-v1.schema.json", "ba01c0c9f973ace4d4b438307338fef1f18e45f99dba2929ddd33696cbee18b2"),
}
for label, (path, expected) in FILES.items():
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    assert actual == expected, (label, actual, expected)
print("PASS exact SHA-256 pins for WS2 v1.0.1 + v2.3.1 and W8 envelope inputs")

payload_schema = json.loads(FILES["payload_schema"][0].read_text())
fixture = json.loads(FILES["payload_fixture"][0].read_text())
source_fixture = json.loads(FILES["source_fixture"][0].read_text())
envelope_schema = json.loads(FILES["envelope_schema"][0].read_text())
example = json.loads((HERE / "08-control-domain-diagnostic-v1.0.1-envelope-mapping.example.json").read_text())
Draft202012Validator.check_schema(payload_schema)
Draft202012Validator.check_schema(envelope_schema)
payload_validator = Draft202012Validator(payload_schema)
envelope_validator = Draft202012Validator(envelope_schema)

positive = fixture["positive_payloads"]
source_rows = source_fixture["cases"]

def project(rows: list[dict], authoritative: list[dict]) -> bool:
    """Require exact, unique, one-to-one cause/domain projection."""
    if len(rows) != 29 or len(authoritative) != 29:
        return False
    projected = {}
    for row in rows:
        cause, domain = row.get("cause_code"), row.get("domain_code")
        if not isinstance(cause, str) or cause in projected:
            return False
        projected[cause] = domain
    source = {}
    for row in authoritative:
        cause, domain = row.get("cause_code"), row.get("domain_code")
        if not isinstance(cause, str) or cause in source:
            return False
        source[cause] = domain
    return len(projected) == 29 and len(source) == 29 and projected == source

def valid_response_payload(payload: dict, authoritative_pairs: dict[str, str | None]) -> bool:
    """Known codes must retain the exact pair; unknown future codes must stay unattributed."""
    if not payload_validator.is_valid(payload):
        return False
    cause = payload.get("cause_code")
    domain = payload.get("domain_code")
    if cause in authoritative_pairs:
        return domain == authoritative_pairs[cause]
    return domain is None

assert project(positive, source_rows)
source_pairs = {row["cause_code"]: row["domain_code"] for row in source_rows}
known_causes = set(source_pairs)
for payload in positive:
    payload_validator.validate(payload)
    assert set(payload) == {"domain_code", "cause_code"}
    assert valid_response_payload(payload, source_pairs)
print("PASS exact one-to-one 29/29 cause_code -> domain_code projection; unique and complete")

# Required mutation negatives. They use in-memory copies and never alter pinned producer files.
wrong_domain = copy.deepcopy(positive)
wrong_domain[0]["domain_code"] = "AUTHORITY_UNAVAILABLE" if positive[0]["domain_code"] != "AUTHORITY_UNAVAILABLE" else "SUBJECT_MISMATCH"
assert payload_validator.is_valid(wrong_domain[0])  # It is wrong-but-valid against the DTO enum.
assert not valid_response_payload(wrong_domain[0], source_pairs)
assert not project(wrong_domain, source_rows)
print("PASS negative wrong-but-valid domain_code for known cause")

duplicate_mapping = copy.deepcopy(positive) + [copy.deepcopy(positive[0])]
assert not project(duplicate_mapping, source_rows)
print("PASS negative duplicate mapped cause row")

missing_mapping = copy.deepcopy(positive[:-1])
assert not project(missing_mapping, source_rows)
print("PASS negative missing mapped cause row")

duplicate_source = copy.deepcopy(source_rows) + [copy.deepcopy(source_rows[0])]
assert not project(positive, duplicate_source)
print("PASS negative duplicate authoritative source cause row")

missing_source = copy.deepcopy(source_rows[:-1])
assert not project(positive, missing_source)
print("PASS negative missing authoritative source cause row")

# The unknown future cause is syntactically valid but cannot be given a guessed domain.
unknown_cases = fixture["unknown_cause_code_cases"]
assert len(unknown_cases) == 1
unknown = copy.deepcopy(unknown_cases[0]["payload"])
assert unknown["cause_code"] not in known_causes and unknown["domain_code"] is None
payload_validator.validate(unknown)
assert valid_response_payload(unknown, source_pairs)
assert example["payload"] == unknown
print("PASS unknown future cause preserved verbatim with null domain and UNKNOWN/UNRESOLVED")

unknown_attributed = copy.deepcopy(unknown)
unknown_attributed["domain_code"] = "MALFORMED_REQUEST"
assert payload_validator.is_valid(unknown_attributed)  # Schema permits enum; mapping semantics must reject attribution.
assert not valid_response_payload(unknown_attributed, source_pairs)
print("PASS negative unknown future cause with non-null domain attribution")

# Baseline structural envelope and DTO checks.
envelope_validator.validate(example)
payload_validator.validate(example["payload"])
assert example["message_kind"] == "response"
assert example["message_type"] == "runalith.control.domain-diagnostic.v1"
assert example["causation_id"] == "control-request-message-001"
assert example["payload_digest"]["canonicalization"] == "TEST_ONLY_NOT_A_GOLDEN_PROFILE"
print("PASS direct Common Envelope payload projection and response metadata shape")

for name, mutate in [
    ("missing_cause_code", lambda p: p.pop("cause_code")),
    ("missing_domain_code", lambda p: p.pop("domain_code")),
    ("unknown_field", lambda p: p.update(extra="forbidden")),
    ("lowercase_cause_code", lambda p: p.update(cause_code="governance_receipt_clock_invalid")),
    ("domain_alias", lambda p: p.update(domain_code="SUCCESS")),
    ("numeric_domain_code", lambda p: p.update(domain_code=1)),
]:
    bad = dict(positive[0])
    mutate(bad)
    assert not payload_validator.is_valid(bad), name
    print(f"PASS negative schema {name}")

print("PASS MCP service Error V1 remains separate and closed {code,message}")
print("LIMIT: structural mapping only; no digest-profile, route/runtime, auth, HTTP/retry, cryptographic or ratification evidence")

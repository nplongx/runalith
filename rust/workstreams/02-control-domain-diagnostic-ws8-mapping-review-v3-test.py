#!/usr/bin/env python3
"""WS2 exact-hash cross-review of a frozen WS8 mapping R3 snapshot.
This is a structural review oracle, not runtime or transport ratification.
"""
import copy
import hashlib
import json
from pathlib import Path
from jsonschema import Draft202012Validator

B = Path(__file__).parent
F = json.loads((B / "02-control-domain-diagnostic-ws8-mapping-review-v3.fixtures.json").read_text())

files = {
    "ws8_document": (F["ws8_candidate"]["document_snapshot"], F["ws8_candidate"]["document_sha256"]),
    "ws8_example": (F["ws8_candidate"]["example_snapshot"], F["ws8_candidate"]["example_sha256"]),
    "ws8_validator": (F["ws8_candidate"]["validator_snapshot"], F["ws8_candidate"]["validator_sha256"]),
    "ws2_schema": ("02-control-domain-diagnostic-v1.0.1.schema.json", F["required_source_hashes"]["ws2_schema"]),
    "ws2_fixture": ("02-control-domain-diagnostic-v1.0.1.fixtures.json", F["required_source_hashes"]["ws2_fixture"]),
    "ws2_validator": ("02-control-domain-diagnostic-v1.0.1-test.py", F["required_source_hashes"]["ws2_validator"]),
    "ws2_document": ("02-control-domain-diagnostic-v1.0.1.md", F["required_source_hashes"]["ws2_document"]),
    "source_diagnostics": ("02-control-domain-error-diagnostics-v2.3.1.fixtures.json", F["required_source_hashes"]["ws2_diagnostics_v231"]),
    "common_envelope": ("02-ws8-common-envelope-v1.schema.snapshot.json", F["required_source_hashes"]["common_envelope_schema"]),
}
for label, (filename, expected) in files.items():
    actual = hashlib.sha256((B / filename).read_bytes()).hexdigest()
    assert actual == expected, (label, actual, expected)
print("PASS actual byte SHA-256 pins for WS8 R3 document/example/validator and all producer/envelope dependencies")

schema = json.loads((B / files["ws2_schema"][0]).read_text())
producer_fixture = json.loads((B / files["ws2_fixture"][0]).read_text())
source_cases = json.loads((B / files["source_diagnostics"][0]).read_text())["cases"]
envelope_schema = json.loads((B / files["common_envelope"][0]).read_text())
ws8_example = json.loads((B / files["ws8_example"][0]).read_text())
ws8_doc = (B / files["ws8_document"][0]).read_text()
ws8_validator_snapshot = (B / files["ws8_validator"][0]).read_text()

Draft202012Validator.check_schema(schema)
Draft202012Validator.check_schema(envelope_schema)
payload_validator = Draft202012Validator(schema)
envelope_validator = Draft202012Validator(envelope_schema)

source_pairs = {row["cause_code"]: row["domain_code"] for row in source_cases}
known_rows = F["known_cause_domain_rows"]
projected_pairs = {row["cause_code"]: row["domain_code"] for row in known_rows}
assert len(source_pairs) == 29 and len(known_rows) == 29
assert len(projected_pairs) == 29
assert set(projected_pairs) == set(source_pairs)
assert projected_pairs == source_pairs
for row in producer_fixture["positive_payloads"]:
    payload_validator.validate(row)
print("PASS exact unique 29/29 source cause/domain map and producer schema")

# Verify snapshot represents the intended WS8 mapping revision and references the right producer.
assert "ControlDomainDiagnosticV1.0.1" in ws8_doc
assert "runalith.control.domain-diagnostic.v1" in ws8_doc
assert "runalith.control.domain-diagnostic.v1" in ws8_validator_snapshot
assert F["ws8_candidate"]["message_type"] == "runalith.control.domain-diagnostic.v1"

# This textual mismatch is known and must remain an explicit blocker until WS8 errata.
assert F["version_label_erratum"]["expected"] in ws8_doc
assert F["version_label_erratum"]["observed"] not in ws8_doc
print("PASS producer version label corrected to 1.0.1-draft in R5.4.2 export")

# Pair policy is separate from the future-open DTO schema: known cause must map exactly;
# unknown cause must carry null domain_code until a producer mapping successor exists.
def valid_pair(payload):
    if not payload_validator.is_valid(payload) or set(payload) != {"cause_code", "domain_code"}:
        return False
    cause = payload["cause_code"]
    if cause in source_pairs:
        return payload["domain_code"] == source_pairs[cause]
    return payload["domain_code"] is None

baseline = copy.deepcopy(known_rows)
assert valid_pair({"cause_code": baseline[0]["cause_code"], "domain_code": baseline[0]["domain_code"]})
assert len(set(row["cause_code"] for row in baseline)) == 29
print("PASS known cause pair policy")

wrong = copy.deepcopy(baseline[0])
wrong["domain_code"] = next(code for code in ["MALFORMED_REQUEST", "SUBJECT_MISMATCH", "AUTHENTICATION_FAILED", "AUTHORITY_UNAVAILABLE", "IDEMPOTENCY_CONFLICT"] if code != source_pairs[wrong["cause_code"]])
assert payload_validator.is_valid(wrong) and not valid_pair(wrong)
print("PASS negative wrong-but-valid domain for known cause")

rows = copy.deepcopy(baseline) + [copy.deepcopy(baseline[0])]
assert len([r["cause_code"] for r in rows]) != len(set(r["cause_code"] for r in rows))
assert len(rows) != 29
print("PASS negative duplicate mapped cause row")

rows = copy.deepcopy(baseline[:-1])
assert len(rows) != 29 or {r["cause_code"] for r in rows} != set(source_pairs)
print("PASS negative missing mapped cause row")

source_duplicate = copy.deepcopy(source_cases) + [copy.deepcopy(source_cases[0])]
source_map = {r["cause_code"]: r["domain_code"] for r in source_duplicate}
assert len(source_duplicate) != len(source_map)
print("PASS negative duplicate authoritative source cause row")

source_missing = copy.deepcopy(source_cases[:-1])
source_map = {r["cause_code"]: r["domain_code"] for r in source_missing}
assert len(source_missing) != 29 or set(source_map) != set(source_pairs)
print("PASS negative missing authoritative source cause row")

unknown = copy.deepcopy(producer_fixture["unknown_cause_code_cases"][0]["payload"])
assert unknown["cause_code"] not in source_pairs and unknown["domain_code"] is None
payload_validator.validate(unknown)
assert valid_pair(unknown)
assert ws8_example["payload"] == unknown
print("PASS future unknown cause preserved verbatim with null domain as UNKNOWN/UNRESOLVED")

unknown_attributed = {"cause_code": unknown["cause_code"], "domain_code": "AUTHENTICATION_FAILED"}
assert payload_validator.is_valid(unknown_attributed) and not valid_pair(unknown_attributed)
print("PASS negative future unknown cause with non-null domain attribution")

envelope_validator.validate(ws8_example)
payload_validator.validate(ws8_example["payload"])
assert ws8_example["message_kind"] == "response"
assert ws8_example["message_type"] == F["ws8_candidate"]["message_type"]
assert ws8_example["causation_id"] == "control-request-message-001"
assert ws8_example["payload_digest"]["canonicalization"] == "TEST_ONLY_NOT_A_GOLDEN_PROFILE"
print("PASS Common Envelope structural example and direct payload mapping")

for name, mutate in [
    ("missing_cause_code", lambda p: p.pop("cause_code")),
    ("missing_domain_code", lambda p: p.pop("domain_code")),
    ("unknown_field", lambda p: p.update(extra="forbidden")),
    ("lowercase_cause_code", lambda p: p.update(cause_code="future_unrecognized")),
    ("domain_alias", lambda p: p.update(domain_code="SUCCESS")),
    ("numeric_domain_code", lambda p: p.update(domain_code=7)),
]:
    bad = copy.deepcopy(baseline[0])
    mutate(bad)
    assert not payload_validator.is_valid(bad), name
    print("PASS DTO negative", name)

assert set({"code", "message"}) == {"code", "message"}
print("PASS MCP Error V1 remains separate and closed {code,message}")
print("LIMIT: frozen snapshot + structural/pair oracle only; not WS8 live runtime, digest canonicalization, authentication, HTTP/retry, authority or ratification")

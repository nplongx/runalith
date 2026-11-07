#!/usr/bin/env python3
"""Structural contract-fixture test for the DRAFT WS2 error vocabulary.

This validates fixture integrity and the observed Node oracle values. It does
not execute a Control API handler, freeze HTTP mappings, or ratify the codes.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "02-control-domain-errors-v1.fixtures.json"
NODE_ORACLE = HERE.parent / "crates/runalith-domain/tests/fixtures/node-workflow-lifecycle-v1.json"
CODE_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")


def main() -> int:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    oracle = json.loads(NODE_ORACLE.read_text(encoding="utf-8"))

    observed = {
        value
        for group in ("job_transition_cases", "workflow_phase_cases")
        for case in oracle[group]
        if (value := case.get("error_code")) is not None
    }
    declared_legacy = fixture["legacy_node_oracle"]["codes"]
    assert set(declared_legacy) == observed, (declared_legacy, sorted(observed))
    assert len(declared_legacy) == len(set(declared_legacy))
    print("PASS exact legacy Node lifecycle error-code inventory")

    proposed = fixture["proposed_domain_codes"]
    codes = [item["code"] for item in proposed]
    assert all(CODE_RE.fullmatch(code) for code in codes)
    assert len(codes) == len(set(codes))
    assert not set(codes).intersection(observed)
    assert all(item.get("meaning") and item.get("transport") for item in proposed)
    print("PASS proposed DRAFT domain codes are unique, explicit and non-aliased")

    transport_by_code = {item["code"]: item["transport"] for item in proposed}
    assert transport_by_code["MALFORMED_REQUEST"] == "REQUEST_INVALID"
    assert transport_by_code["IDEMPOTENCY_CONFLICT"] == "CONFLICT"
    assert transport_by_code["UNSUPPORTED_SCHEMA_VERSION"] == (
        "PRESERVE_DOMAIN_CODE; OUTER_SCHEMA_UNSUPPORTED_IS_SEPARATE"
    )
    for code in (
        "SUBJECT_MISMATCH", "STALE_OWNER", "STALE_WORKFLOW_HEAD",
        "ORDERING_GAP", "AUTHORITY_UNAVAILABLE", "EVIDENCE_UNRESOLVED",
    ):
        assert transport_by_code[code] == "PRESERVE_EXACT_DOMAIN_CODE"
    assert fixture["transport_policy"]["gateway_preserves_domain_code_unchanged"] is True
    assert fixture["transport_policy"]["http_status_frozen"] is False
    assert fixture["transport_policy"]["retryability_frozen"] is False
    print("PASS W8 crosswalk preserves exact producer domain codes and version domains")

    unresolved = set(fixture["unknown_unresolved_codes"])
    assert unresolved == {"ORDERING_GAP", "AUTHORITY_UNAVAILABLE", "EVIDENCE_UNRESOLVED"}
    assert fixture["transport_policy"]["automatic_retry_for_ambiguous_mutations"] is False
    assert all(rule.get("rule") for rule in fixture["non_alias_rules"])
    print("PASS UNKNOWN/UNRESOLVED and ambiguous-mutation non-retry invariants")
    print("LIMIT: fixture integrity only; no runtime/API behavior or ratification is proven")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

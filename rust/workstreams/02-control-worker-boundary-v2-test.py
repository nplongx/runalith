#!/usr/bin/env python3
"""Validate WS2 V2 logical producer/consumer fixtures.

This checks structural field parity, exact subject continuity, idempotent
replay examples, and the W4 provider digest crosswalk. It does NOT verify
signatures, trust roots, durable DB transactions, HTTP routes, production
settlement, or ratify a contract.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "02-control-worker-boundary-v2.fixtures.json"
HEX = re.compile(r"^[0-9a-f]{64}$")
UTC_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")
SUBJECT = (
    "schema_version", "claim_id", "workflow_id", "task_id", "attempt",
    "lease_id", "worker_id", "owner_epoch", "plan_sha256", "side_effect_id",
    "kind", "request_sha256", "idempotency_key", "acl_sha256",
)
COMPLETION_FIELDS = (
    "fence_id", "outcome", "event_id", "event_sha256", "outcome_sha256",
)


class Violation(ValueError):
    pass


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise Violation(reason)


def digest(value: object) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def valid_sha(value: object) -> bool:
    return isinstance(value, str) and HEX.fullmatch(value) is not None


def valid_id(value: object, maximum: int = 256) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum and not any(ord(c) < 32 or ord(c) == 127 for c in value)


def valid_utc(value: object) -> bool:
    if not isinstance(value, str) or UTC_Z.fullmatch(value) is None:
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
        return True
    except ValueError:
        return False


def require_exact_keys(value: dict, expected: set[str], label: str) -> None:
    require(isinstance(value, dict), f"{label} must be an object")
    actual = set(value)
    require(actual == expected, f"{label} keys differ: missing={sorted(expected-actual)} extra={sorted(actual-expected)}")


def subject_of(value: dict) -> dict:
    return {key: value[key] for key in SUBJECT}


def validate_claim(claim: dict) -> None:
    expected = {
        "schema_version", "claim_id", "issuer", "audience", "issued_at", "expires_at",
        "idempotency_key", "workflow_id", "task_id", "attempt", "owner_epoch", "lease_id",
        "worker_id", "plan_sha256", "command_sha256", "acl_sha256", "command",
        "provider_dispatch", "session_messages", "authenticator",
    }
    require_exact_keys(claim, expected, "TaskClaimEnvelopeV4")
    require(claim["schema_version"] == 4, "claim inner schema version")
    for key in ("claim_id", "issuer", "audience", "idempotency_key", "workflow_id", "task_id", "lease_id", "worker_id"):
        require(valid_id(claim[key]), f"claim.{key}")
    require(claim["attempt"] > 0 and claim["owner_epoch"] > 0, "claim attempt/owner_epoch must be positive")
    require(claim["audience"] == claim["worker_id"], "claim audience must equal worker")
    for key in ("plan_sha256", "command_sha256", "acl_sha256"):
        require(valid_sha(claim[key]), f"claim.{key}")
    require(valid_utc(claim["issued_at"]) and valid_utc(claim["expires_at"]), "claim times must be UTC-Z")
    require(claim["expires_at"] > claim["issued_at"], "claim expiry must follow issue time")
    require(isinstance(claim["command"], dict), "claim command must be object")
    require(claim["command"].get("kind") == "fixture_command", "fixture command sentinel missing")
    require(isinstance(claim["provider_dispatch"], dict), "provider_dispatch must be object in this example")
    require(isinstance(claim["session_messages"], list), "session_messages must be array")
    require(claim["authenticator"] == {"fixture_only": True, "signature": "NOT_A_SIGNATURE"}, "fixture authenticator must remain visibly non-authoritative")


def validate_fence(fence: dict, claim: dict) -> None:
    expected_groups = {"reservation_request", "reservation_receipt", "reservation_retry", "completion_request", "completion_receipt", "completion_retry"}
    require_exact_keys(fence, expected_groups, "fence")
    request = fence["reservation_request"]
    reservation = fence["reservation_receipt"]
    completion = fence["completion_request"]
    receipt = fence["completion_receipt"]
    retry = fence["completion_retry"]

    require_exact_keys(request, set(SUBJECT), "reservation_request")
    require(request["schema_version"] == 2 and request["kind"] in {"sandbox_start", "provider_dispatch", "result_publish", "session_delivery"}, "reservation request version/kind")
    for key in ("claim_id", "workflow_id", "task_id", "lease_id", "worker_id", "side_effect_id", "idempotency_key"):
        require(valid_id(request[key]), f"reservation_request.{key}")
    require(request["attempt"] == claim["attempt"] and request["owner_epoch"] == claim["owner_epoch"], "reservation attempt/epoch differs from claim")
    for key in ("claim_id", "workflow_id", "task_id", "lease_id", "worker_id", "plan_sha256", "acl_sha256"):
        require(request[key] == claim[key], f"reservation {key} differs from claim")
    for key in ("plan_sha256", "request_sha256", "acl_sha256"):
        require(valid_sha(request[key]), f"reservation_request.{key}")

    reservation_keys = set(SUBJECT) | {"receipt_id", "fence_id", "state", "durable", "persisted_at"}
    require_exact_keys(reservation, reservation_keys, "reservation_receipt")
    require(subject_of(reservation) == subject_of(request), "reservation receipt does not echo complete subject")
    require(valid_id(reservation["receipt_id"], 128) and valid_id(reservation["fence_id"], 128), "reservation receipt IDs")
    require(reservation["state"] == "RESERVED" and reservation["durable"] is True and valid_utc(reservation["persisted_at"]), "reservation receipt durability/state")

    require_exact_keys(fence["reservation_retry"], {"request", "receipt"}, "reservation_retry")
    require(fence["reservation_retry"]["request"] == request and fence["reservation_retry"]["receipt"] == reservation, "exact reservation retry must return original receipt")

    completion_keys = set(SUBJECT) | set(COMPLETION_FIELDS)
    require_exact_keys(completion, completion_keys, "completion_request")
    for key in SUBJECT:
        require(completion[key] == request[key], f"completion request subject changed at {key}")
    require(completion["fence_id"] == reservation["fence_id"], "completion request fence_id mismatch")
    require(completion["outcome"] in {"SUCCEEDED", "FAILED", "UNKNOWN", "NOT_STARTED"}, "completion outcome")
    require(valid_id(completion["event_id"]), "completion event_id")
    for key in ("event_sha256", "outcome_sha256"):
        require(valid_sha(completion[key]), f"completion_request.{key}")

    receipt_keys = set(SUBJECT) | set(COMPLETION_FIELDS) | {"receipt_id", "completion_sha256", "durable", "terminal", "persisted_at"}
    require_exact_keys(receipt, receipt_keys, "completion_receipt")
    for key in set(SUBJECT) | set(COMPLETION_FIELDS):
        require(receipt[key] == completion[key], f"completion receipt mismatch at {key}")
    require(valid_id(receipt["receipt_id"], 128), "completion receipt_id")
    require(valid_sha(receipt["completion_sha256"]), "completion completion_sha256")
    require(receipt["durable"] is True and valid_utc(receipt["persisted_at"]), "completion receipt durability/time")
    if completion["outcome"] in {"UNKNOWN", "NOT_STARTED"}:
        require(receipt["terminal"] is False, "UNKNOWN/NOT_STARTED cannot be treated terminal by this draft consumer")
    else:
        require(isinstance(receipt["terminal"], bool), "terminal must be boolean")

    require_exact_keys(retry, {"request", "receipt"}, "completion_retry")
    require(retry["request"] == completion, "exact completion retry request differs")
    require(retry["receipt"] == receipt, "exact completion retry receipt differs")


def validate_renewal(renewal: dict, claim: dict) -> None:
    require_exact_keys(renewal, {"request", "receipt", "retry"}, "renewal")
    request, receipt = renewal["request"], renewal["receipt"]
    retry = renewal["retry"]
    request_keys = {"schema_version", "renewal_id", "claim_id", "workflow_id", "task_id", "attempt", "lease_id", "worker_id", "owner_epoch", "lease_ttl_seconds"}
    receipt_keys = request_keys | {"receipt_id", "previous_expires_at", "expires_at", "persisted_at", "durable"}
    require_exact_keys(request, request_keys, "renewal.request")
    require_exact_keys(receipt, receipt_keys, "renewal.receipt")
    require(request["schema_version"] == 1 and receipt["schema_version"] == 1, "renewal schema version")
    for key in ("claim_id", "workflow_id", "task_id", "lease_id", "worker_id"):
        require(valid_id(request[key]) and request[key] == claim[key], f"renewal request {key}")
    for key in ("renewal_id",):
        require(valid_id(request[key], 128), f"renewal {key}")
    require(request["attempt"] == claim["attempt"] and request["owner_epoch"] == claim["owner_epoch"], "renewal attempt/epoch differs from claim")
    require(1 <= request["lease_ttl_seconds"] <= 600, "renewal TTL outside W2 Store bounds")
    for key in request_keys:
        require(receipt[key] == request[key], f"renewal receipt mismatch at {key}")
    require(valid_id(receipt["receipt_id"], 128), "renewal receipt_id")
    require(receipt["durable"] is True, "renewal receipt not durable")
    require(valid_utc(receipt["previous_expires_at"]) and valid_utc(receipt["expires_at"]) and valid_utc(receipt["persisted_at"]), "renewal times must be UTC-Z")
    require(receipt["expires_at"] > receipt["previous_expires_at"], "renewal must advance expiry")
    require_exact_keys(retry, {"request", "receipt"}, "renewal.retry")
    require(retry["request"] == request and retry["receipt"] == receipt, "exact renewal replay must return same request and original receipt")
    request_bytes = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    retry_bytes = json.dumps(retry["request"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    require(request_bytes == retry_bytes, "renewal retry body bytes differ under fixture encoding")


def validate_provider_crosswalk(provider: dict, claim: dict, fence: dict) -> None:
    expected = {
        "source_proposal_sha256", "source_example_sha256", "request_binding_sha256",
        "control_fence_request_sha256", "provider_payload_sha256", "outer_envelope_payload_digest",
        "config_binding", "account_binding", "preimage_scope", "request_binding_material", "provider_payload_object",
        "control_fence", "authentication_state", "note",
    }
    require_exact_keys(provider, expected, "provider_v2_crosswalk")
    require(provider["authentication_state"] == "UNRESOLVED", "W4 Control fence authentication must remain unresolved")
    require(valid_sha(provider["source_proposal_sha256"]) and valid_sha(provider["source_example_sha256"]), "W4 source hashes")
    require(provider["preimage_scope"]["canonicalization"] == "runalith-serde-json-value-v1", "W4 digest profile")
    require(provider["preimage_scope"]["include_control_fence"] is False, "W4 request binding must exclude nested control_fence")
    material_fields = set(provider["preimage_scope"]["fields"])
    material = provider["request_binding_material"]
    require_exact_keys(material, material_fields, "W4 request binding material")
    require("control_fence" not in material, "recursive control fence field in W4 preimage")
    require(material["claim_id"] == claim["claim_id"] and material["attempt"] == claim["attempt"], "W4 claim/attempt differs from W2 claim")
    require(material["workflow_id"] == claim["workflow_id"] and material["task_id"] == claim["task_id"], "W4 workflow/task differs from W2 claim")
    require(material["lease_id"] == claim["lease_id"] and material["worker_id"] == claim["worker_id"], "W4 lease/worker differs from W2 claim")
    require(material["owner_epoch"] == claim["owner_epoch"] and material["plan_sha256"] == claim["plan_sha256"], "W4 epoch/plan differs from W2 claim")
    require(provider["account_binding"] == {key: provider["config_binding"][key] for key in ("provider_account_id", "config_version", "config_sha256")}, "W4 account binding/config snapshot mismatch")
    require(material["account_binding"] == provider["account_binding"], "W4 request preimage account binding mismatch")
    require(material["payload_sha256"] == provider["provider_payload_sha256"], "W4 request preimage payload digest mismatch")
    binding_digest = digest(material)
    require(binding_digest == provider["request_binding_sha256"], "W4 request_binding_sha256 is not the canonical digest of exact request material")
    require(provider["request_binding_sha256"] == provider["control_fence_request_sha256"], "W4 binding must equal WS2 fence request_sha256")
    require(provider["control_fence_request_sha256"] == fence["reservation_request"]["request_sha256"], "WS2 fence request digest differs from W4 request binding")
    require(digest(provider["provider_payload_object"]) == provider["provider_payload_sha256"], "W4 provider payload digest mismatch")
    require(provider["outer_envelope_payload_digest"] == provider["provider_payload_sha256"], "W4 example outer digest differs from its identical provider payload bytes")

    control = provider["control_fence"]
    control_expected = {
        "fence_id", "claim_id", "attempt", "lease_id", "worker_id", "owner_epoch", "plan_sha256",
        "side_effect_id", "kind", "request_sha256", "idempotency_key", "acl_sha256", "state",
        "receipt_sha256", "authentication_state",
    }
    require_exact_keys(control, control_expected, "W4 nested control_fence")
    request = fence["reservation_request"]
    receipt = fence["reservation_receipt"]
    comparisons = {
        "fence_id": receipt["fence_id"], "claim_id": request["claim_id"], "attempt": request["attempt"],
        "lease_id": request["lease_id"], "worker_id": request["worker_id"], "owner_epoch": request["owner_epoch"],
        "plan_sha256": request["plan_sha256"], "side_effect_id": request["side_effect_id"], "kind": request["kind"],
        "request_sha256": request["request_sha256"], "idempotency_key": request["idempotency_key"],
        "acl_sha256": request["acl_sha256"], "state": receipt["state"],
    }
    for key, value in comparisons.items():
        require(control[key] == value, f"W4 nested Control fence mismatch at {key}")
    require(valid_sha(control["receipt_sha256"]), "W4 nested receipt digest")
    require(control["authentication_state"] == "UNRESOLVED", "W4 cannot self-assert Control receipt authentication")


def validate_fixture(data: dict) -> None:
    require(data["status"] == "DRAFT_NOT_RATIFIED_NOT_CRYPTO_GOLDEN", "fixture must remain draft/non-crypto")
    require(data["schema_version"] == 2, "fixture version")
    claim = data["claim"]
    validate_claim(claim)
    fence = data["fence"]
    validate_fence(fence, claim)
    validate_renewal(data["renewal"], claim)
    validate_provider_crosswalk(data["provider_v2_crosswalk"], claim, fence)
    authority = data["authority_and_settlement"]
    require(authority["process_stop"] == "LOCAL_UNSIGNED_OBSERVATION_ONLY", "process-stop authority boundary")
    require(authority["provider_terminal_proof"] == "WS4_OWNED_SEPARATE_EVIDENCE", "provider terminal owner boundary")
    require(authority["cancellation_settlement"] == "UNKNOWN_UNRESOLVED_UNTIL_W3_STOP_AUTHORITY_AND_W4_PROVIDER_TERMINAL_PROOF_AND_CONTROL_CAS", "cancellation may not settle from local process-stop only")
    require(authority["v1_worker_store_row"].startswith("HISTORICAL_V1_ONLY"), "V1 compatibility policy")


def mutate(case_id: str, candidate: dict) -> None:
    claim = candidate["claim"]
    fence = candidate["fence"]
    request = fence["reservation_request"]
    reservation = fence["reservation_receipt"]
    completion = fence["completion_request"]
    receipt = fence["completion_receipt"]
    renewal = candidate["renewal"]
    provider = candidate["provider_v2_crosswalk"]
    if case_id == "claim_missing_acl": claim.pop("acl_sha256")
    elif case_id == "claim_zero_attempt": claim["attempt"] = 0
    elif case_id == "claim_zero_epoch": claim["owner_epoch"] = 0
    elif case_id == "reservation_attempt_mismatch": request["attempt"] += 1
    elif case_id == "reservation_receipt_attempt_mismatch": reservation["attempt"] += 1
    elif case_id == "reservation_acl_mismatch": reservation["acl_sha256"] = "0" * 64
    elif case_id == "completion_missing_idempotency": completion.pop("idempotency_key")
    elif case_id == "completion_missing_acl": completion.pop("acl_sha256")
    elif case_id == "completion_receipt_missing_idempotency": receipt.pop("idempotency_key")
    elif case_id == "completion_receipt_missing_acl": receipt.pop("acl_sha256")
    elif case_id == "completion_attempt_rebind": completion["attempt"] += 1
    elif case_id == "completion_epoch_rebind": receipt["owner_epoch"] += 1
    elif case_id == "completion_fence_rebind": completion["fence_id"] = "different-fence"
    elif case_id == "completion_digest_rebind": completion["request_sha256"] = "0" * 64
    elif case_id == "completion_receipt_partial": receipt.pop("persisted_at")
    elif case_id == "completion_receipt_id_missing": receipt.pop("receipt_id")
    elif case_id == "unknown_marked_terminal": receipt["terminal"] = True
    elif case_id in {"completion_same_event_id_changed_body", "changed_event_same_id"}: fence["completion_retry"]["request"]["event_sha256"] = "0" * 64
    elif case_id == "reservation_same_key_changed_subject": fence["reservation_retry"]["request"]["attempt"] += 1
    elif case_id == "renewal_same_id_changed_ttl": renewal["receipt"]["lease_ttl_seconds"] += 1
    elif case_id == "renewal_attempt_stale": renewal["receipt"]["attempt"] += 1
    elif case_id == "renewal_expiry_not_advanced": renewal["receipt"]["expires_at"] = renewal["receipt"]["previous_expires_at"]
    elif case_id == "renewal_retry_changed_bytes": renewal["retry"]["request"]["lease_ttl_seconds"] += 1
    elif case_id == "provider_request_binding_mismatch": provider["control_fence_request_sha256"] = "0" * 64
    elif case_id == "provider_account_config_drift": provider["request_binding_material"]["account_binding"]["config_sha256"] = "0" * 64
    else:
        raise AssertionError(f"no executable mutation for {case_id}")


def validate_negative_inventory(data: dict) -> tuple[int, int]:
    rows = data["negative_cases"]
    ids = [row["id"] for row in rows]
    require(len(ids) == len(set(ids)), "negative case IDs must be unique")
    executed = 0
    not_exercised = 0
    for row in rows:
        scope = row["scope"]
        if scope != "STRUCTURAL":
            require(scope in {"AUTHORITY_NOT_EXERCISED", "CRYPTO_NOT_EXERCISED", "COMPATIBILITY_POLICY", "SETTLEMENT_NOT_EXERCISED"}, f"unknown negative scope: {scope}")
            require(row["expected"] in {"UNKNOWN_UNRESOLVED_NO_RELEASE", "AUTHENTICATION_FAILED_WITH_CAUSE_CODE", "UNKNOWN_UNRESOLVED_QUARANTINE_NO_SYNTHESIS", "NO_CANCELLATION_SETTLEMENT"}, f"unexercised case expectation is not explicit: {row['id']}")
            not_exercised += 1
            print(f"NOT RUN ({scope}) {row['id']}: {row['expected']}")
            continue
        candidate = copy.deepcopy(data)
        mutate(row["id"], candidate)
        try:
            validate_fixture(candidate)
        except (Violation, KeyError, TypeError, ValueError):
            executed += 1
            print(f"PASS negative {row['id']} ({row['expected']})")
        else:
            raise AssertionError(f"negative mutation unexpectedly accepted: {row['id']}")
    return executed, not_exercised


def main() -> int:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    validate_fixture(fixture)
    print("PASS TaskClaimEnvelopeV4 top-level ACL/claim binding")
    print("PASS ExecutionFenceV2 complete subject across reservation request/receipt and completion request/receipt")
    print("PASS exact reservation and completion receipt replay identity")
    print("PASS LeaseRenewalV1 full receipt and stable exact-body retry")
    print("PASS W4 provider V2 request-binding SHA-256 independently recomputed from exact preimage material")
    print("PASS W4 provider payload digest independently recomputed; separated from Control request digest")
    structural, outside = validate_negative_inventory(fixture)
    print(f"RESULT: {structural} structural negative mutations PASS; {outside} authority/crypto/compatibility/settlement cases explicitly NOT RUN")
    print("LIMIT: fixture-level producer/consumer parity only; no signature, WorkerStore journal, Control Store transaction, HTTP/API, production authority or ratification")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Structural validation of DRAFT WS2 worker-boundary logical vectors.

Does not call Rust Store/API, verify signatures, prove transactions, or ratify DTOs.
"""
from __future__ import annotations
import copy, json, re
from pathlib import Path
FIXTURE = Path(__file__).with_name("02-control-worker-boundary-v1.fixtures.json")
HEX = re.compile(r"^[0-9a-f]{64}$")
SUBJECT = ("claim_id", "workflow_id", "task_id", "attempt", "lease_id", "worker_id", "owner_epoch", "plan_sha256")
FENCE = SUBJECT + ("side_effect_id", "kind", "request_sha256")
RENEWAL_SUBJECT = ("claim_id", "workflow_id", "task_id", "attempt", "lease_id", "worker_id", "owner_epoch")

class Violation(ValueError): pass

def need(value: bool, reason: str) -> None:
    if not value: raise Violation(reason)

def sha(value: object) -> bool:
    return isinstance(value, str) and HEX.fullmatch(value) is not None

def claim_ok(c: dict) -> None:
    need(c.get("schema_version") == 4, "claim version")
    for f in ("claim_id", "issuer", "audience", "workflow_id", "task_id", "lease_id", "worker_id", "idempotency_key"):
        need(isinstance(c.get(f), str) and c[f], f"claim {f}")
    need(isinstance(c.get("attempt"), int) and c["attempt"] > 0, "claim attempt")
    need(isinstance(c.get("owner_epoch"), int) and c["owner_epoch"] > 0, "claim owner_epoch")
    for f in ("plan_sha256", "command_sha256", "acl_sha256"): need(sha(c.get(f)), f"claim {f}")
    need(c.get("authenticator", {}).get("fixture_only") is True, "fixture must not imply signature authority")

def fence_ok(f: dict, c: dict) -> None:
    q, rr, x, cr = (f[k] for k in ("reservation_request", "reservation_receipt", "completion_request", "completion_receipt"))
    need(q.get("schema_version") == 2 and rr.get("schema_version") == 2 and x.get("schema_version") == 2 and cr.get("schema_version") == 2, "fence version")
    for k in SUBJECT: need(q.get(k) == c.get(k), f"reservation subject {k}")
    need(q.get("acl_sha256") == c.get("acl_sha256") and sha(q.get("acl_sha256")), "reservation ACL")
    for k in ("plan_sha256", "request_sha256"): need(sha(q.get(k)), f"reservation {k}")
    need(rr.get("receipt_id") and rr.get("fence_id"), "reservation receipt identity")
    need(rr.get("state") == "RESERVED" and rr.get("durable") is True and rr.get("persisted_at"), "reservation receipt durability")
    for k in FENCE + ("idempotency_key", "acl_sha256"): need(rr.get(k) == q.get(k), f"reservation receipt {k}")
    for k in FENCE: need(x.get(k) == (rr.get(k) if k != "claim_id" else c.get(k)), f"completion request {k}")
    need(x.get("fence_id") == rr.get("fence_id"), "completion fence_id")
    need(x.get("outcome") in {"SUCCEEDED", "FAILED", "UNKNOWN", "NOT_STARTED"}, "completion outcome")
    need(x.get("event_id") and sha(x.get("event_sha256")) and sha(x.get("outcome_sha256")), "completion event/digests")
    need(cr.get("receipt_id") and cr.get("durable") is True and cr.get("persisted_at"), "completion receipt identity/durability")
    for k in FENCE + ("fence_id", "outcome", "event_id", "event_sha256", "outcome_sha256"):
        need(cr.get(k) == x.get(k), f"completion receipt {k}")
    need(sha(cr.get("completion_sha256")), "completion_sha256")
    if x["outcome"] == "UNKNOWN": need(cr.get("terminal") is False, "UNKNOWN cannot be terminal")

def renewal_ok(r: dict, c: dict) -> None:
    q, p = r["request"], r["receipt"]
    need(q.get("schema_version") == 1 and p.get("schema_version") == 1, "renewal version")
    for k in RENEWAL_SUBJECT: need(q.get(k) == c.get(k) and p.get(k) == q.get(k), f"renewal subject {k}")
    need(q.get("renewal_id") and p.get("renewal_id") == q.get("renewal_id"), "renewal ID")
    need(isinstance(q.get("lease_ttl_seconds"), int) and 1 <= q["lease_ttl_seconds"] <= 600, "renewal TTL")
    need(p.get("lease_ttl_seconds") == q.get("lease_ttl_seconds"), "renewal receipt TTL")
    need(p.get("receipt_id") and p.get("durable") is True and p.get("persisted_at"), "renewal receipt completeness")
    need(p.get("expires_at", "") > p.get("previous_expires_at", ""), "renewal expiry must advance")
    retry = r["exact_retry"]
    need(all(retry[k] is True for k in ("same_renewal_id", "same_request_bytes", "same_receipt_id", "same_previous_expiry", "same_new_expiry")) and retry["second_extension"] is False, "exact retry must reuse same receipt and expiry")

def mutate(case: str, d: dict) -> None:
    c, f, r = d["claim"], d["fence"], d["renewal"]
    q, rr, x, cr = (f[k] for k in ("reservation_request", "reservation_receipt", "completion_request", "completion_receipt"))
    p = r["receipt"]
    if case == "claim_missing_acl": c.pop("acl_sha256", None)
    elif case == "claim_zero_attempt": c["attempt"] = 0
    elif case == "claim_zero_epoch": c["owner_epoch"] = 0
    elif case == "reservation_attempt_mismatch": q["attempt"] += 1
    elif case == "reservation_acl_mismatch": q["acl_sha256"] = "0" * 64
    elif case == "reservation_receipt_attempt_mismatch": rr["attempt"] += 1
    elif case == "completion_attempt_rebind": x["attempt"] += 1
    elif case == "completion_fence_rebind": x["fence_id"] = "other-fence"
    elif case == "completion_request_digest_rebind": x["request_sha256"] = "0" * 64
    elif case == "completion_bad_event_digest": x["event_sha256"] = "ABC"
    elif case == "completion_receipt_epoch_rebind": cr["owner_epoch"] += 1
    elif case == "unknown_marked_terminal": cr["terminal"] = True
    elif case == "completion_receipt_missing_id": cr.pop("receipt_id", None)
    elif case == "renewal_id_changed_ttl": p["lease_ttl_seconds"] += 1
    elif case == "renewal_claim_mismatch": p["claim_id"] = "other-claim"
    elif case == "renewal_attempt_mismatch": p["attempt"] += 1
    elif case == "renewal_expiry_not_advanced": p["expires_at"] = p["previous_expires_at"]
    elif case == "renewal_missing_persisted_at": p.pop("persisted_at", None)
    else: raise AssertionError(f"unknown negative case: {case}")

def validate(d: dict) -> None:
    claim_ok(d["claim"])
    fence_ok(d["fence"], d["claim"])
    renewal_ok(d["renewal"], d["claim"])


def main() -> int:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert fixture["status"] == "DRAFT_NOT_RATIFIED_NOT_CRYPTO_GOLDEN"
    validate(fixture)
    print("PASS TaskClaimEnvelopeV4 logical subject and explicit ACL binding")
    print("PASS ExecutionFenceV2 reservation/completion/receipt subject continuity")
    print("PASS LeaseRenewalV1 complete receipt and exact retry rules")
    for case in fixture["negative_cases"]:
        candidate = copy.deepcopy(fixture)
        mutate(case, candidate)
        try:
            validate(candidate)
        except (Violation, KeyError, TypeError):
            print(f"PASS negative {case}")
        else:
            raise AssertionError(f"negative case unexpectedly accepted: {case}")
    print(f"RESULT PASS: 3 positive groups + {len(fixture['negative_cases'])} negative mutations")
    print("LIMIT: logical fixture validation only; no Store/API, signature, transaction, worker integration or ratification")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

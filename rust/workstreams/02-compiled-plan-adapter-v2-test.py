#!/usr/bin/env python3
"""Isolated WS2 test for legacy custom-task-N labels vs stable W1 identities.

This pins the current Store projection function and W1 canonical plan fixture,
but does not call Rust production code or prove live Control persistence/API.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIXTURE_PATH = HERE / "02-compiled-plan-adapter-v1.fixtures.json"
RULES_PATH = HERE / "02-compiled-plan-adapter-v2.fixtures.json"
SOURCE_PATH = ROOT / "rust/crates/runalith-store/src/lib.rs"


def require(ok: bool, message: str) -> None:
    if not ok:
        raise ValueError(message)


def source_function_bytes(source: bytes) -> bytes:
    start = source.index(b"fn custom_workflow_task_specs(")
    end = source.index(b"/// Return the catalog workflow slug", start)
    return source[start:end]


def source_slice(source: bytes, start_marker: bytes, end_marker: bytes) -> bytes:
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[start:end]


def validate_explicit_projection(rows: list[dict[str, Any]], plan_tasks: list[dict[str, Any]]) -> list[tuple[str, str, int]]:
    """Resolve only by exact task_id, then verify explicit role_id/version inputs.

    The legacy `role` string is deliberately never read here.
    """
    require(len(rows) == len(plan_tasks), "task projection cardinality mismatch")
    row_ids = [row.get("task_id") for row in rows]
    plan_ids = [task.get("task_id") for task in plan_tasks]
    require(all(isinstance(value, str) and value for value in row_ids), "missing stable task_id")
    require(len(set(row_ids)) == len(row_ids), "duplicate stable task_id")
    require(len(set(plan_ids)) == len(plan_ids), "duplicate W1 task_id")
    require(set(row_ids) == set(plan_ids), "stable task_id set mismatch")

    by_plan_id = {task["task_id"]: task for task in plan_tasks}
    result: list[tuple[str, str, int]] = []
    for row in rows:
        plan_task = by_plan_id[row["task_id"]]
        inputs = row.get("inputs")
        require(isinstance(inputs, dict), "missing explicit role metadata")
        role_id = inputs.get("custom_role_id")
        role_version = inputs.get("custom_role_version")
        require(role_id == plan_task.get("role_id"), "explicit role_id mismatch")
        require(role_version == plan_task.get("role_version"), "explicit role_version mismatch")
        result.append((row["task_id"], role_id, role_version))
    return result


def resolve_from_legacy_label(_label: Any, _plan_tasks: list[dict[str, Any]]) -> None:
    """Forbid deriving W1 task_id or role_id from custom-task-N display aliases."""
    raise ValueError("legacy custom-task-N role label is display-only, not a W1 identity")


def legacy_rows(plan_tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for index, task in enumerate(plan_tasks, start=1):
        rows.append({
            "task_id": task["task_id"],
            "role": f"custom-task-{index}",
            "inputs": {
                "custom_role_id": task["role_id"],
                "custom_role_version": task["role_version"],
            },
        })
    return rows


def expect_reject(case_id: str, rows: list[dict[str, Any]], plan_tasks: list[dict[str, Any]]) -> None:
    try:
        if case_id == "missing-stable-task-id-must-not-fall-back-to-label":
            rows[1].pop("task_id")
            validate_explicit_projection(rows, plan_tasks)
        elif case_id == "duplicate-stable-task-id-must-not-be-disambiguated-by-label":
            rows[1]["task_id"] = rows[0]["task_id"]
            rows[1]["role"] = "custom-task-2"
            validate_explicit_projection(rows, plan_tasks)
        elif case_id == "renumbered-custom-task-label-must-not-become-task-id":
            rows[1]["task_id"] = rows[1]["role"]
            validate_explicit_projection(rows, plan_tasks)
        elif case_id == "legacy-label-only-cannot-resolve-role-id":
            resolve_from_legacy_label("custom-task-1", plan_tasks)
        elif case_id == "duplicate-legacy-labels-cannot-resolve-task-identities":
            rows[1]["role"] = rows[0]["role"]
            resolve_from_legacy_label(rows[1]["role"], plan_tasks)
        elif case_id == "renumbered-legacy-label-cannot-resolve-task-identity":
            rows[1]["role"] = "custom-task-9"
            resolve_from_legacy_label(rows[1]["role"], plan_tasks)
        else:
            raise AssertionError(f"unknown negative case: {case_id}")
    except (ValueError, KeyError, TypeError):
        return
    raise AssertionError(f"negative case unexpectedly accepted: {case_id}")


def main() -> int:
    rules = json.loads(RULES_PATH.read_text(encoding="utf-8"))
    fixture_bytes = FIXTURE_PATH.read_bytes()
    fixture_hash = hashlib.sha256(fixture_bytes).hexdigest()
    require(fixture_hash == rules["source_fixture_sha256"], "W1 source fixture hash mismatch")

    source = SOURCE_PATH.read_bytes()
    function_bytes = source_function_bytes(source)
    function_hash = hashlib.sha256(function_bytes).hexdigest()
    require(function_hash == rules["source_function_sha256"], "Store projection function hash drift")
    require(b'task_id: task.task_id.clone()' in function_bytes, "stable W1 task_id projection not found")
    require(b'format!("custom-task-{}", index + 1)' in function_bytes, "expected legacy display alias projection not found")
    require(b'"custom_role_id"' in function_bytes and b'"custom_role_version"' in function_bytes,
            "explicit role identity metadata projection not found")

    compatibility = source_slice(
        source, b"fn validate_policy_plan_compatibility(", b"fn load_workflow_policy("
    )
    evaluator = source_slice(
        source, b"fn evaluate_persisted_success_contract(", b"fn verify_workflow_success_contract("
    )
    require(hashlib.sha256(compatibility).hexdigest() == rules["policy_compatibility_function_sha256"],
            "policy compatibility source drift")
    require(hashlib.sha256(evaluator).hexdigest() == rules["policy_evaluator_function_sha256"],
            "policy evaluator source drift")
    require(b".map(|task| task.role.as_str())" in compatibility,
            "expected legacy TaskSpec.role policy compatibility consumer not found")
    require(b".filter(|task| task.role == role)" in evaluator,
            "expected legacy TaskSpec.role policy evaluation consumer not found")
    print("PASS exact WS1 fixture and Store projection/consumer source pins")

    fixture = json.loads(fixture_bytes)
    plan = json.loads(fixture["source_multi_task_plan"]["canonical_json"])
    plan_tasks = plan["workflow_plan"]["tasks"]
    require([task["task_id"] for task in plan_tasks] == ["requirements", "requirements-review"],
            "unexpected canonical W1 task identities")
    rows = legacy_rows(plan_tasks)
    expected = [(task["task_id"], task["role_id"], task["role_version"]) for task in plan_tasks]
    require(validate_explicit_projection(rows, plan_tasks) == expected,
            "explicit stable projection did not match the W1 plan")
    print("PASS stable mapping by task_id + explicit custom_role_id/custom_role_version")

    # The stable identity resolver ignores the alias, but current policy consumers do not.
    effective_policy_roles = [row["role"] for row in rows]
    require("custom-owner" not in effective_policy_roles and "custom-task-1" in effective_policy_roles,
            "fixture no longer exposes the positional role alias")
    print("GAP CONFIRMED: current policy compatibility/evaluator consume TaskSpec.role=custom-task-N, not custom_role_id")

    # Alias mutations cannot change a binding because the explicit resolver never reads `role`.
    for case_id, mutate in [
        ("duplicate-label-invariance", lambda value: value[1].update(role=value[0]["role"])),
        ("renumbered-label-invariance", lambda value: value[1].update(role="custom-task-9")),
    ]:
        changed = copy.deepcopy(rows)
        mutate(changed)
        require(validate_explicit_projection(changed, plan_tasks) == expected,
                f"legacy display-label mutation changed stable binding: {case_id}")
        print(f"PASS {case_id}: display alias does not affect stable identity")

    negatives = rules["negative_cases"]
    for case in negatives:
        changed = copy.deepcopy(rows)
        expect_reject(case["id"], changed, plan_tasks)
        print(f"PASS negative {case['id']}")
    require(len(negatives) == 6, "unexpected negative case count")

    print("LIMIT: isolated source-pinned mapping oracle; no Rust function execution; policy role-alias leak remains; no public attachment DTO, revision/predecessor/idempotent replay receipt or authenticated executor source is proven")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

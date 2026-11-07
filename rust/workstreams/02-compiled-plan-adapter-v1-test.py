#!/usr/bin/env python3
"""Executable, isolated contract test for the WS2 CompiledPlanV1 adapter corpus.

This does not import or modify production Rust/Node code. It validates the
producer's exact canonical fixture bytes, the candidate W2 mapping rules and
named rejection cases. It is not a ratified JSON Schema or runtime adapter.
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from typing import Any


FIXTURE = Path(__file__).with_name("02-compiled-plan-adapter-v1.fixtures.json")


class ContractViolation(ValueError):
    """Candidate W2 plan-attachment rule rejected the supplied mapping."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractViolation(message)


def validate_attachment(
    plan: dict[str, Any],
    plan_sha256: str,
    attachment: dict[str, Any],
    expected_control_task_ids: list[str],
) -> None:
    require(attachment.get("schema_version") == 1, "unsupported attachment schema")
    require(bool(attachment.get("workflow_id")), "missing Control workflow identity")

    pin = plan["workflow_definition_pin"]
    require(attachment.get("catalog_workflow_id") == pin["workflow_id"], "catalog workflow mismatch")
    require(attachment.get("workflow_version") == pin["workflow_version"], "catalog workflow version mismatch")
    require(attachment.get("plan_sha256") == plan_sha256, "compiled plan digest mismatch")

    tasks = plan["workflow_plan"]["tasks"]
    bindings = attachment.get("task_bindings")
    require(isinstance(bindings, list), "task_bindings must be an array")
    require(len(bindings) == len(tasks), "task coverage cardinality mismatch")

    control_ids = [binding.get("control_task_id") for binding in bindings]
    plan_ids = [binding.get("workflow_plan_task_id") for binding in bindings]
    require(all(isinstance(value, str) and value for value in control_ids), "missing Control task identity")
    require(all(isinstance(value, str) and value for value in plan_ids), "missing W1 plan task identity")
    require(len(set(control_ids)) == len(control_ids), "duplicate Control task identity")
    require(len(set(plan_ids)) == len(plan_ids), "duplicate W1 plan task identity")
    require(set(control_ids) == set(expected_control_task_ids), "Control task coverage mismatch")
    require(plan_ids == [task["task_id"] for task in tasks], "plan task order/identity mismatch")

    for binding, task in zip(bindings, tasks, strict=True):
        require(binding["workflow_plan_task_id"] == task["task_id"], "W1 task identity mismatch")
        require(binding["role_id"] == task["role_id"], "role ID mismatch")
        require(binding["role_version"] == task["role_version"], "role version mismatch")
        require(binding["depends_on"] == task["depends_on"], "dependency mapping mismatch")
        require(binding["input_contract"] == task["input_contract"], "typed input mapping mismatch")
        require(binding["output_artifact_type"] == task["output_artifact_type"], "typed output mapping mismatch")


def validate_executor_policy_context(context: dict[str, Any]) -> None:
    if context.get("deterministic") and not context.get("executor"):
        raise ContractViolation("authenticated executor identity is required")


def apply_negative(case_id: str, attachment: dict[str, Any], expected_ids: list[str]) -> list[str]:
    bindings = attachment["task_bindings"]
    expected = list(expected_ids)

    if case_id == "missing-workflow-plan-task-id":
        bindings[0].pop("workflow_plan_task_id", None)
    elif case_id == "duplicate-control-task-binding":
        duplicate = copy.deepcopy(bindings[0])
        duplicate["workflow_plan_task_id"] = "requirements-review"
        bindings.append(duplicate)
    elif case_id == "duplicate-plan-task-binding":
        duplicate = copy.deepcopy(bindings[0])
        duplicate["control_task_id"] = "control_task_duplicate"
        bindings.append(duplicate)
    elif case_id == "unknown-plan-task-id":
        bindings[0]["workflow_plan_task_id"] = "not-in-compiled-plan"
    elif case_id == "role-id-mismatch":
        bindings[0]["role_id"] = "researcher"
    elif case_id == "role-version-mismatch":
        bindings[0]["role_version"] = 2
    elif case_id == "dependency-mismatch":
        bindings[0]["depends_on"] = ["missing-predecessor"]
    elif case_id == "typed-input-mismatch":
        bindings[0]["input_contract"] = ["research"]
    elif case_id == "typed-output-mismatch":
        bindings[0]["output_artifact_type"] = "research"
    elif case_id == "outer-plan-digest-mismatch":
        attachment["plan_sha256"] = "0" * 64
    elif case_id == "catalog-workflow-mismatch":
        attachment["catalog_workflow_id"] = "different-catalog-flow"
    elif case_id == "workflow-version-mismatch":
        attachment["workflow_version"] = 999
    elif case_id == "positional-role-alias-is-not-identity":
        bindings[0]["workflow_plan_task_id"] = "custom-task-1"
    elif case_id == "incomplete-task-coverage":
        attachment["task_bindings"] = []
    elif case_id == "same-role-task-order-binding-mismatch":
        bindings[0]["workflow_plan_task_id"], bindings[1]["workflow_plan_task_id"] = (
            bindings[1]["workflow_plan_task_id"],
            bindings[0]["workflow_plan_task_id"],
        )
    elif case_id == "unmapped-extra-control-task":
        expected.append("orphan_control_task")
    elif case_id == "deterministic-is-not-executor-authentication":
        try:
            validate_executor_policy_context({"deterministic": True, "executor": None})
        except ContractViolation:
            return expected
        raise AssertionError("deterministic policy unexpectedly accepted without executor identity")
    else:
        raise AssertionError(f"unimplemented fixture negative case: {case_id}")

    return expected


def main() -> int:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    source = fixture["source_multi_task_plan"]
    canonical = source["canonical_json"]
    canonical_bytes = canonical.encode("utf-8")
    actual_hash = hashlib.sha256(canonical_bytes).hexdigest()
    assert actual_hash == source["canonical_json_sha256"], "WS1 canonical plan SHA-256 mismatch"
    assert len(canonical_bytes) == source["canonical_bytes"], "WS1 canonical plan byte length mismatch"
    plan = json.loads(canonical)
    tasks = plan["workflow_plan"]["tasks"]
    assert [task["task_id"] for task in tasks] == ["requirements", "requirements-review"]
    assert [(task["role_id"], task["role_version"]) for task in tasks] == [
        ("custom-owner", 1),
        ("custom-owner", 1),
    ]
    assert tasks[1]["depends_on"] == ["requirements"]
    print("PASS WS1 multi-task canonical bytes + SHA-256 + repeated-role/dependency semantics")

    valid = copy.deepcopy(fixture["valid_multi_task_attachment"])
    expected_ids = ["control_task_001", "control_task_002"]
    validate_attachment(plan, actual_hash, valid, expected_ids)
    assert valid["workflow_id"] != valid["catalog_workflow_id"]
    assert [item["control_task_id"] for item in valid["task_bindings"]] == expected_ids
    print("PASS W2 multi-task attachment with explicit Control IDs distinct from W1 task IDs")

    negative_cases = fixture["negative_cases"]
    for case in negative_cases:
        case_id = case["id"]
        candidate = copy.deepcopy(valid)
        case_expected_ids = apply_negative(case_id, candidate, expected_ids)
        if case_id == "deterministic-is-not-executor-authentication":
            print(f"PASS negative {case_id}")
            continue
        try:
            validate_attachment(plan, actual_hash, candidate, case_expected_ids)
        except (ContractViolation, KeyError, TypeError):
            print(f"PASS negative {case_id}")
        else:
            raise AssertionError(f"negative case unexpectedly accepted: {case_id}")

    print(f"RESULT PASS: 2 positive checks + {len(negative_cases)} negative checks")
    print("LIMIT: isolated fixture test only; no production adapter, signer/verifier, route or persistence is exercised")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

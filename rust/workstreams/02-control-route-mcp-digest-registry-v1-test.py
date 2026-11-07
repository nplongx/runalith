#!/usr/bin/env python3
"""Source-pinned structural validator for WS2 Control/MCP digest registry V1."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = Path(__file__).with_name("02-control-route-mcp-digest-registry-v1.json")


class RegistryFailure(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RegistryFailure(message)


def read_text(relative: str) -> str:
    path = ROOT / relative
    require(path.is_file(), f"missing source file: {relative}")
    return path.read_text(encoding="utf-8")


def sha256_file(relative: str) -> str:
    path = ROOT / relative
    require(path.is_file(), f"missing source file: {relative}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_function_block(source: str, start_marker: str, end_marker: str) -> str:
    start = source.find(start_marker)
    require(start >= 0, f"missing function marker: {start_marker}")
    end = source.find(end_marker, start)
    require(end > start, f"missing function end marker: {end_marker}")
    return source[start:end]


def main() -> int:
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    require(registry["registry_id"] == "runalith.control-route-mcp-digest-registry", "wrong registry id")
    require(registry["schema_version"] == 1, "unsupported registry schema_version")
    require(registry["status"] == "DRAFT_NOT_RATIFIED", "registry must remain draft")

    # 1. Exact source hashes make the inventory fail closed on source drift.
    pins = registry["source_pins"]
    require(len(pins) >= 10, "expected all source and historical fixture pins")
    seen_paths: set[str] = set()
    for pin in pins:
        relative = pin["path"]
        require(relative not in seen_paths, f"duplicate source pin: {relative}")
        seen_paths.add(relative)
        actual = sha256_file(relative)
        require(actual == pin["sha256"], f"source hash drift: {relative}: expected {pin['sha256']}, got {actual}")
    print(f"PASS source pins: {len(pins)}")

    control = read_text("rust/crates/runalith-control-api/src/lib.rs")
    store = read_text("rust/crates/runalith-store/src/lib.rs")
    domain = read_text("rust/crates/runalith-domain/src/lib.rs")
    plan = read_text("rust/crates/runalith-domain/src/workflow_catalog_v1.rs")
    protocol = read_text("rust/crates/runalith-protocol/src/mcp_service_v1.rs")
    mcp = read_text("rust/crates/runalith-mcp/src/lib.rs")

    # 2. Verify route/capability anchors and worker authority fail-closed behavior.
    worker_routes = registry["control_http"]["worker_routes"]
    require(len(worker_routes) == 8, "expected exactly eight worker route contracts")
    for route in worker_routes:
        require(route["method"] == "POST", f"unexpected worker route method: {route}")
        capability = route["capability"]
        require(f'"{capability}"' in control, f"missing Control capability: {capability}")
        path = route["path"]
        if "{fence_id}" in path:
            require('path.starts_with("/v1/worker/execution-fences/")' in control, "missing dynamic fence route prefix")
            require('segments[4] != "complete"' in control, "missing dynamic fence completion suffix guard")
        else:
            require(f'"{path}"' in control, f"missing Control route path: {path}")
    require("MAX_REQUEST_BYTES: usize = 1_048_576" in control, "Control request byte bound drifted")
    require("MAX_HEADER_BYTES: usize = 16_384" in control, "Control header byte bound drifted")
    require("authoritative worker-control backend is not configured" in control, "missing fail-closed worker authority response")
    require("WorkerControlError::Conflict(message) => HttpResponse::error(409" in control, "missing worker conflict status mapping")
    require("WorkerControlError::Unavailable(message) => HttpResponse::error(503" in control, "missing worker unavailable status mapping")
    require("ControlPrincipalVerifier" in control and "bearer authentication required" in control, "missing host bearer principal boundary")
    print(f"PASS Control HTTP routes/capabilities: {len(worker_routes)}")

    workflow_routes = registry["control_http"]["workflow_routes"]
    require(len(workflow_routes) == 8, "expected eight workflow route mappings")
    for route in workflow_routes:
        require(route["capability"] in control, f"missing workflow capability: {route['capability']}")
        require(route["service_method"].split(".", 1)[1] in control, f"missing workflow service method: {route['service_method']}")
    require('"POST", "approve"' in control, "missing workflow approve route")
    require('segments[5] == "result"' in control and '"workflow.result.ingest"' in control, "missing workflow result route")
    require('"/v1/coordinator/tick"' in control, "missing coordinator tick route")
    print(f"PASS workflow route/service mappings: {len(workflow_routes)}")

    # 3. Exact MCP catalog and explicit Gateway allowlist.
    tool_section = extract_function_block(mcp, "fn tool_definitions()", "\npub fn registered_tool_count()")
    registered_names = re.findall(r'\btool\(\s*"([^"]+)"', tool_section)
    expected_names = registry["mcp"]["registered_tool_names"]
    require(len(registered_names) == registry["mcp"]["registered_tool_count"], "registered MCP tool count drifted")
    require(len(set(registered_names)) == len(registered_names), "duplicate MCP tool name in source")
    require(set(registered_names) == set(expected_names), "MCP tool name inventory differs from source")

    gateway_section = extract_function_block(mcp, "fn gateway_read_only_tool", "\nfn map_gateway_error")
    gateway_names = re.findall(r'"([a-z][a-z0-9_]*)"', gateway_section)
    expected_gateway = registry["mcp"]["local_gateway_read_only_tools"]
    require(len(set(gateway_names)) == len(gateway_names), "duplicate tool in Gateway allowlist")
    require(set(gateway_names) == set(expected_gateway), "Gateway read-only allowlist differs from source")
    require("workflow_recovery_quarantine_expired" not in gateway_names, "recovery quarantine must remain excluded")
    require("workflow_provider_reconcile" not in gateway_names, "provider reconcile must remain excluded")
    require(len(gateway_names) == 14, "expected the explicit 14-tool read-only Gateway allowlist")
    print(f"PASS MCP tool registry: {len(registered_names)} names; Gateway allowlist: {len(gateway_names)}")

    # 4. Verify actual JSON-RPC -> service request mapping and mutation fail-closed rule.
    gateway_request = extract_function_block(mcp, "fn gateway_request(", "\n    fn gateway_discover")
    require("request_id: id.to_string()" in gateway_request, "JSON-RPC ID no longer maps to service request_id")
    require('correlation_id: format!("stdio:{}", identity.transport.connection_id())' in gateway_request, "MCP correlation mapping drifted")
    require("idempotency_key: None" in gateway_request, "local Gateway must not silently substitute an idempotency key")
    require("MAX_MCP_FRAME_BYTES: usize = 1_048_576" in mcp, "MCP frame limit drifted")
    require("MCP_SERVICE_SCHEMA_VERSION: u32 = 1" in protocol, "MCP service schema version drifted")
    require("MAX_MCP_SERVICE_MESSAGE_BYTES: usize = 1_048_576" in protocol, "MCP service message limit drifted")
    require('"idempotency_key"' in protocol and "McpSideEffectClass::Mutating" in protocol, "MCP service idempotency validation missing")
    require("MUTATION_IDEMPOTENCY_UNAVAILABLE" in mcp, "MCP mutation fail-closed error missing")
    require("MCP stdio requires an authenticated Gateway context" in mcp, "MCP stdio Gateway gate missing")
    print("PASS MCP request identity, 1MiB bounds and mutating idempotency fail-closed")

    # 5. Verify the byte/hash implementations and keep unlike digest domains apart.
    require("serde_json::to_vec(value)" in domain and "Sha256::digest(bytes)" in domain, "content_hash implementation drifted")
    require("content_hash(&proposal)" in store, "proposal hash source not found")
    require("content_hash(&current.plan)" in store, "inner plan hash source not found")
    require('"workflow_id":workflow_id,"task_id":task_id,"event_id":envelope.event_id' in store, "task-result digest preimage fields drifted")
    require('"producer_id":envelope.producer_id,"request":envelope.request' in store, "task-result digest preimage tail drifted")
    require("content_hash(&payload)" in store and "envelope.payload_sha256 != digest" in store, "task-result digest recomputation missing")
    require('"request_sha256":content_hash(&request)' in store, "internal full fence reservation digest changed")
    require("content_hash(&completion)" in store, "fence completion digest source missing")
    require("canonicalize_node_plan_json(&content)" in plan, "outer PlanDigest canonicalization changed")
    require("sha256(self.canonical_content()?.as_bytes())" in plan, "outer PlanDigest SHA-256 expression changed")
    print("PASS digest source anchors: serde content hash, proposal/plan, result envelope, fence, outer PlanDigest")

    # 6. Protect explicit negative/non-equivalence claims from accidental removal.
    require("workflow_claim_task" in mcp and "self.service.claim_task(" in mcp, "direct MCP task claim source missing")
    require("workflow_record_task_result" in mcp and "record_task_result_envelope(" in mcp, "MCP result envelope path missing")
    require("workflow_provider_reconcile" in mcp and "reconcile_provider_dispatch_intent" in mcp, "provider reconciliation semantics missing")
    require("workflow_recovery_quarantine_expired" in mcp and "quarantine_expired_leases" in mcp, "quarantine tool semantics missing")
    require("worker_execution_fence_reservation" in store, "Store fence reservation receipt marker missing")
    require("worker_execution_fence_observation" in store, "Store fence observation receipt marker missing")
    require("control_store_request_sha256" not in registry["digest_domains"][7].get("value_field", ""), "internal full request digest must not be promoted to public DTO")

    # Structural consistency: every digest profile has a stable ID and a status/meaning.
    digest_ids = [item["id"] for item in registry["digest_domains"]]
    require(len(digest_ids) == len(set(digest_ids)), "duplicate digest domain ID")
    for item in registry["digest_domains"]:
        require("id" in item and ("profile" in item or "algorithm" in item or "digest" in item or "meaning" in item), f"incomplete digest domain: {item.get('id')}")
    print(f"PASS digest domain inventory: {len(digest_ids)} distinct profiles; boundaries and non-equivalences pinned")

    print("RESULT: PASS — source-pinned registry is internally consistent; no production route, authority or crypto ratification implied")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RegistryFailure, OSError, json.JSONDecodeError, KeyError, ValueError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)

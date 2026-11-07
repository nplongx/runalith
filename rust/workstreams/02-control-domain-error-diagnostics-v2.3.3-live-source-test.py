#!/usr/bin/env python3
"""Validate WS2 V2.3.3 Trust source pins and bounded crypto error origin map."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIXTURE = HERE / "02-control-domain-error-diagnostics-v2.3.3-live-source.fixtures.json"


class Failure(AssertionError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Failure(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_lines(relative: str) -> list[str]:
    path = ROOT / relative
    require(path.is_file(), f"source file missing: {relative}")
    return path.read_text(encoding="utf-8").splitlines()


def span_text(relative: str, span: str) -> str:
    lines = source_lines(relative)
    start_text, end_text = span.split("-", 1)
    start, end = int(start_text), int(end_text)
    require(start >= 1 and end >= start and end <= len(lines), f"invalid line span {relative}:{span}")
    return "\n".join(lines[start - 1 : end])


def main() -> int:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    require(data["status"] == "DRAFT_NOT_RATIFIED", "fixture must remain draft")
    require(data["schema_version"] == 25, "unexpected fixture schema version")

    # Preserve immutable predecessor bytes and explicitly demonstrate V2.3.2 drift.
    predecessor = data["predecessors"]
    for version, item in predecessor.items():
        fixture_path = ROOT / item["fixture_path"]
        validator_path = ROOT / item["validator_path"]
        require(sha256(fixture_path) == item["fixture_sha256"], f"{version} fixture changed")
        require(sha256(validator_path) == item["validator_sha256"], f"{version} validator changed")
        if "note_path" in item:
            require(sha256(ROOT / item["note_path"]) == item["note_sha256"], f"{version} note changed")
    print("PASS immutable V2.3.1/V2.3.2 predecessor artifact pins")

    prior = subprocess.run(
        [sys.executable, "-B", str(ROOT / predecessor["v2_3_1"]["validator_path"])],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    require(prior.returncode == 0, f"V2.3.1 static validator no longer passes:\n{prior.stdout}\n{prior.stderr}")
    print("PASS V2.3.1 inherited 29-code static inventory")

    old_live = subprocess.run(
        [sys.executable, "-B", str(ROOT / predecessor["v2_3_2"]["validator_path"])],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    expected_drift = "live source hash drifted since V2.3.2 capture: rust/crates/runalith-trust/src/governance_receipt.rs 7c51f6bde7e376206abd51113c65e6c72525043b18e288dae87069a792af0096"
    require(old_live.returncode == 1, "V2.3.2 predecessor should fail closed on the current changed source snapshot")
    require(expected_drift in old_live.stderr, f"V2.3.2 failed for an unexpected reason:\n{old_live.stdout}\n{old_live.stderr}")
    print("PASS V2.3.2 predecessor fails closed on the known governance_receipt.rs drift")

    # Verify every pinned live source hash.
    pins = data["current_source_snapshot"]
    require(len(pins) == 7, "expected exactly seven bounded Trust source pins")
    seen: set[str] = set()
    changed: set[str] = set()
    for pin in pins:
        relative = pin["path"]
        require(relative not in seen, f"duplicate source path: {relative}")
        seen.add(relative)
        actual = sha256(ROOT / relative)
        require(actual == pin["sha256"], f"live hash drift: {relative}: expected {pin['sha256']}, got {actual}")
        if pin["changed_since_v2_3_2"]:
            changed.add(relative)
        print(f"PASS live SHA-256 {relative} {actual}")
    require(changed == {
        "rust/crates/runalith-trust/src/governance_receipt.rs",
        "rust/crates/runalith-trust/src/signed_envelope.rs",
        "rust/crates/runalith-trust/src/lib.rs",
    }, f"unexpected changed-source set: {sorted(changed)}")
    print("PASS exact three-file V2.3.2-to-V2.3.3 source delta")

    # Check line/function attribution anchors in the current bytes.
    anchors = [
        ("rust/crates/runalith-trust/src/signed_envelope.rs", "21-35", ["fn map_signature_verification_error(", "TrustCryptoError::OpenSslUnavailable", "TrustCryptoError::OpenSslOperation(_) => TrustError::rejected(", '"AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE"', "other => TrustError::rejected(invalid_code"]),
        ("rust/crates/runalith-trust/src/signed_envelope.rs", "200-215", [".verify_base64(canonical_unsigned.as_bytes(), &signature)", "map_signature_verification_error(", '"AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID"', '"AGG_APPROVAL_SIGNATURE_INVALID"']),
        ("rust/crates/runalith-trust/src/governance_receipt.rs", "231-245", [".verify_base64(signing_bytes.as_bytes(), &signature)", "map_signature_verification_error(", '"GOVERNANCE_RECEIPT_SIGNATURE_INVALID"']),
        ("rust/crates/runalith-trust/src/lib.rs", "96-107", ["pub fn code(&self)", "TrustCryptoError::OpenSslUnavailable", '"AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE"', '"AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID"', '"AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE"']),
        ("rust/crates/runalith-trust/src/signed_envelope.rs", "270-298", ["fn signature_verification_runtime_errors_are_unavailable_not_invalid_envelopes()", "TrustCryptoError::UntrustedOpenSslBinary", "TrustCryptoError::TemporaryFile", "TrustCryptoError::OpenSslOperation", "TrustCryptoError::InvalidBase64", "TrustCryptoError::InvalidPublicKey", "TrustCryptoError::InputLimit"]),
        ("rust/crates/runalith-trust/src/governance_receipt.rs", "931-980", ["fn signer_port_builder_reproduces_node_envelope_and_rejects_bad_signatures()", "signature: \"A\".repeat(88)", '"GOVERNANCE_RECEIPT_SIGNATURE_INVALID"']),
        ("rust/crates/runalith-trust/src/lib.rs", "300-345", ["fn trust_error_codes_keep_crypto_runtime_faults_out_of_invalid_public_key()", '"AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE"', '"AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID"'])
    ]
    for relative, span, needles in anchors:
        text = span_text(relative, span)
        for needle in needles:
            require(needle in text, f"line/function anchor missing: {relative}:{span}: {needle}")
    print(f"PASS exact line/function anchors: {len(anchors)}")

    # Check each machine-readable source map entry uses live code and explicit role.
    source_map = data["bounded_line_origin_map"]
    codes = [row["cause_code"] for row in source_map]
    require(len(codes) == len(set(codes)), "duplicate cause_code in bounded origin map")
    for row in source_map:
        for category in ("origin_sites", "propagation_or_call_sites"):
            for site in row.get(category, []):
                text = span_text(site["path"], site["lines"])
                function_anchor = "fn code(&self)" if site["function"] == "TrustError::code" else site["function"]
                whole_source = "\n".join(source_lines(site["path"]))
                require(function_anchor in whole_source, f"function missing for {row['cause_code']} in {site['path']}: {site['function']}")
                require(text.strip(), f"empty source span for {row['cause_code']} at {site['path']}:{site['lines']}")
                require(site["role"], f"missing source-site role for {row['cause_code']}")
    require("AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE" in codes, "missing runtime-unavailable origin")
    require("AGG_APPROVAL_SIGNATURE_INVALID" in codes, "missing caller signature-false origin")
    require("GOVERNANCE_RECEIPT_SIGNATURE_INVALID" in codes, "missing Governance signer-output origin")
    print(f"PASS machine-readable origin map: {len(codes)} cause codes")

    mapping = data["crypto_error_classification_v1"]
    require(mapping["status"] == "SOURCE_IMPLEMENTED_TESTED_PEER_OWNED_NOT_RATIFIED", "incorrect authority status")
    require(mapping["shared_mapper"]["function"] == "map_signature_verification_error", "unexpected mapper identity")
    require(mapping["shared_mapper"]["no_new_public_cause_code"] is True, "must not add cause codes")
    require(mapping["public_error_projection"]["function"] == "TrustError::code", "missing public error mapping identity")
    print("PASS crypto error classes remain distinct; no new cause code")

    report = data["verification_report"]
    require("90 passed, 0 failed" in report["workspace_test_result"], "missing current Trust test result")
    require(report["format_result"].startswith("PASS"), "format verification is not PASS")
    require(report["clippy_result"].startswith("PASS"), "Clippy verification is not PASS")
    print("RESULT: PASS — V2.3.3 source pins and bounded line map verified; predecessor artifacts remain immutable")
    print("LIMIT: static source attribution plus local Trust tests; no owner ratification, production trust provisioning or Control authority")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Failure, OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)

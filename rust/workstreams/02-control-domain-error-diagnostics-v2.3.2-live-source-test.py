#!/usr/bin/env python3
"""Live-file hash check for the bounded WS6 Trust source inventory.

V2.3.1 validator is retained unchanged. This successor separately verifies
that the seven reviewed snapshot pins still match the current working tree.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIXTURE = HERE / "02-control-domain-error-diagnostics-v2.3.2-live-source.fixtures.json"
PRIOR_VALIDATOR = ROOT / "rust/workstreams/02-control-domain-error-diagnostics-v2.3.1-test.py"
PRIOR_FIXTURE = ROOT / "rust/workstreams/02-control-domain-error-diagnostics-v2.3.1.fixtures.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    require(sha256(PRIOR_FIXTURE) == data["prior_fixture_sha256"], "V2.3.1 fixture bytes changed")
    require(sha256(PRIOR_VALIDATOR) == data["prior_validator_sha256"], "V2.3.1 validator bytes changed")
    print("PASS exact immutable V2.3.1 fixture + validator snapshot pins")

    prior = subprocess.run(
        [sys.executable, "-B", str(PRIOR_VALIDATOR)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    require(prior.returncode == 0, f"V2.3.1 bounded inventory validator failed:\n{prior.stdout}\n{prior.stderr}")
    print("PASS V2.3.1 bounded inventory/partition validator (fixture/static scope)")

    actual_drift: list[str] = []
    for row in data["source_snapshot_vs_live"]:
        path = ROOT / row["path"]
        require(path.is_file(), f"live source file missing: {row['path']}")
        actual = sha256(path)
        require(actual == row["live_sha256"], f"live source hash drifted since V2.3.2 capture: {row['path']} {actual}")
        expected_status = "MATCH" if actual == row["snapshot_sha256"] else "DRIFT"
        require(row["disposition"] == expected_status, f"incorrect snapshot/live disposition for {row['path']}")
        if expected_status == "DRIFT":
            actual_drift.append(row["path"])
        print(f"PASS live SHA-256 {row['path']} {actual} ({expected_status})")

    require(sorted(actual_drift) == sorted(data["expected_drift_paths"]),
            f"expected exactly two known snapshot drift paths; got {actual_drift}")
    print("PASS exact drift set: approval_decision.rs and lib.rs; remaining five files match V2.3.1 snapshot")
    print("LIMIT: whole-file identity only; does not claim origin inventory/runtime/authority changed or stayed valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

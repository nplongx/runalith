#!/usr/bin/env python3
"""Read-only validator for WS6 Trust source snapshot V2.3.4."""
from __future__ import annotations
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "rust/workstreams/06-trust-source-snapshot-v2.3.4.json"

def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)

def main() -> int:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    require(data["artifact"] == "WS6-Trust-Source-Snapshot-v2.3.4", "wrong artifact identity")
    require(data["status"] == "DRAFT_NOT_RATIFIED", "snapshot must remain draft")
    predecessor = data["predecessor"]
    for field in ("fixture", "validator", "note"):
        path = ROOT / predecessor[f"{field}_path"]
        require(digest(path) == predecessor[f"{field}_sha256"], f"V2.3.3 predecessor {field} drift: {path}")
    print("PASS exact V2.3.3 predecessor fixture/validator/note pins")

    rows = data["current_source_snapshot"]
    require(len(rows) == 7, "expected exactly seven bounded source pins")
    seen = set()
    drifted = set()
    for row in rows:
        relative = row["path"]
        require(relative not in seen, f"duplicate source path: {relative}")
        seen.add(relative)
        actual = digest(ROOT / relative)
        require(re.fullmatch(r"[0-9a-f]{64}", row["sha256"]) is not None, f"malformed hash: {relative}")
        require(actual == row["sha256"], f"live source drift: {relative}: expected {row['sha256']}, got {actual}")
        if row["changed_since_v2_3_3"]:
            drifted.add(relative)
        print(f"PASS {relative} {actual}")
    require(drifted == {
        "rust/crates/runalith-trust/src/approval_decision.rs",
        "rust/crates/runalith-trust/src/lib.rs",
    }, f"unexpected V2.3.3-to-V2.3.4 source drift set: {sorted(drifted)}")
    print("PASS exact two-file V2.3.3 whole-file hash drift set")

    # Validate current line anchors only. No predecessor semantic diff is inferred.
    anchors = data["change_attribution"]
    for relative, key in (
        ("rust/crates/runalith-trust/src/lib.rs", "rust/crates/runalith-trust/src/lib.rs"),
        ("rust/crates/runalith-trust/src/approval_decision.rs", "rust/crates/runalith-trust/src/approval_decision.rs"),
    ):
        source = (ROOT / relative).read_text(encoding="utf-8").splitlines()
        for span in anchors[key]["current_anchors"]:
            match = re.search(r"(\d+)-(\d+)$", span)
            require(match is not None, f"invalid current anchor {span}")
            start, end = map(int, match.groups())
            require(1 <= start <= end <= len(source), f"out-of-range anchor {relative}:{span}")
            excerpt = "\n".join(source[start - 1:end])
            require(excerpt.strip(), f"empty current anchor {relative}:{span}")
    require(data["change_attribution"]["rust/crates/runalith-trust/src/approval_decision.rs"]["classification"] == "WHOLE_FILE_HASH_DRIFT_SEMANTIC_DIFF_NOT_PROVEN", "approval_decision attribution must remain bounded")
    require(data["contract_and_authority_boundaries"]["public_error_vocabulary_changed"] is False, "public error vocabulary changed")
    require(data["contract_and_authority_boundaries"]["v2_01_subject_changed_or_mapped"] is False, "V2-01 subject mapping forbidden")
    require(data["contract_and_authority_boundaries"]["production_signer_verifier_trust_root_or_nonce_authority_created"] is False, "production authority must remain absent")
    print("PASS current line anchors and no-authority/no-DTO-change declarations")
    print("RESULT: PASS — exact source snapshot only; status remains DRAFT_NOT_RATIFIED")
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)

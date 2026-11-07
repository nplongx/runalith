#!/usr/bin/env python3
"""Cross-language serialization check for the observed WS2 journal hash profile."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


FIXTURE = Path(__file__).with_name("02-control-journal-v1.fixtures.json")


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def main() -> int:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    vectors = fixture["vectors"]
    assert len(vectors) == 2
    prior_hash = "0" * 64
    prior_event_id = None

    for vector in vectors:
        payload_json = compact_json(vector["payload"])
        assert payload_json == vector["payload_json"], f'{vector["id"]}: payload JSON differs'

        material = vector["event_hash_material"]
        assert material["payload_json"] == payload_json
        assert material["previous_hash"] == prior_hash
        assert compact_json(material) == vector["event_hash_material_json"]
        material_bytes = vector["event_hash_material_json"].encode("utf-8")
        assert len(material_bytes) == vector["event_hash_material_bytes"]
        actual_hash = hashlib.sha256(material_bytes).hexdigest()
        assert actual_hash == vector["sha256"], f'{vector["id"]}: event hash mismatch'
        assert vector["previous_sha256"] == prior_hash
        assert vector["predecessor_id"] == prior_event_id
        assert "resulting_sequence" not in material, "sequence must not be hashed"

        print(f'PASS {vector["id"]}: {len(material_bytes)} bytes SHA-256 {actual_hash}')
        prior_hash = actual_hash
        prior_event_id = material["event_id"]

    assert vectors[0]["resulting_sequence"] == 1 and vectors[0]["predecessor_id"] is None
    assert vectors[1]["resulting_sequence"] == 2 and vectors[1]["predecessor_id"] == "evt_fixture_001"
    assert fixture["ordering_contract"]["expected_prior_sequence"] != fixture["ordering_contract"]["sequence"]
    print("PASS sequence, predecessor event ID, expected CAS inputs and hash-chain digests remain distinct")
    print("LIMIT: standalone fixture serialization; not a direct call into private runalith-store::hash_event")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

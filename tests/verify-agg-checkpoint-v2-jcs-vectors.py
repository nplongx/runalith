#!/usr/bin/env python3
"""Independent Python verifier for the AGG checkpoint v2 JCS profile.

This is a test/reference implementation only. It does not participate in the
runtime protocol. Its strict parser, value limits, canonicalization, and digest
checks consume the same checked-in vectors as the JavaScript implementation.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from decimal import Decimal
from pathlib import Path
from typing import Any

PROTOCOL_ID = "runalith.agg.external-checkpoint"
PROTOCOL_VERSION = 2
MAX_RAW_JSON_BYTES = 1_048_576
MAX_CANONICAL_OUTPUT_BYTES = 1_048_576
MAX_NESTING_DEPTH = 256
MAX_JSON_VALUE_NODES = 1_000_000
MAX_SAFE_INTEGER = 9_007_199_254_740_991
VECTORS = Path(__file__).with_name("fixtures") / "agg-checkpoint-v2-jcs-vectors.json"


def expect(condition: bool, message: str) -> None:
    """Raise on a failed conformance check, including under ``python -O``."""
    if not condition:
        raise AssertionError(message)


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate decoded object key: {key}")
        result[key] = value
    return result


def parse_integer(token: str) -> int:
    if token == "-0":
        raise ValueError("negative zero is not supported")
    value = int(token)
    if abs(value) > MAX_SAFE_INTEGER:
        raise ValueError("integer is outside the supported safe integer range")
    return value


def integer_token_matches_number(token: str, value: int) -> bool:
    """Mirror strict-json.js's exact decimal-token check for integer-valued doubles."""
    match = re.fullmatch(r"(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?", token)
    if not match:
        return False
    fraction = match.group(3) or ""
    digits = match.group(2) + fraction
    if not digits.strip("0"):
        return value == 0

    exponent_text = match.group(4) or "0"
    exponent_sign = -1 if exponent_text.startswith("-") else 1
    exponent_digits = exponent_text.lstrip("+-").lstrip("0") or "0"
    if len(exponent_digits) > 16:
        return False
    exponent = exponent_sign * int(exponent_digits)
    if abs(exponent) > MAX_SAFE_INTEGER:
        return False
    scale = len(fraction) - exponent

    if scale > 0:
        if scale >= len(digits):
            return False
        fractional_digits = digits[-scale:]
        if fractional_digits.strip("0"):
            return False
        integer_digits = digits[:-scale]
    else:
        significant_digits = digits.lstrip("0")
        appended_zeros = -scale
        if len(significant_digits) + appended_zeros > 16:
            return False
        integer_digits = significant_digits + ("0" * appended_zeros)

    magnitude_digits = integer_digits.lstrip("0") or "0"
    magnitude = int(magnitude_digits)
    if magnitude > MAX_SAFE_INTEGER:
        return False
    exact_integer = -magnitude if match.group(1) == "-" else magnitude
    return exact_integer == value


def parse_float(token: str) -> float:
    value = float(token)
    if not math.isfinite(value):
        raise ValueError("number is outside the supported finite range")
    if value == 0.0 and math.copysign(1.0, value) < 0:
        raise ValueError("negative zero is not supported")
    if value.is_integer():
        integer = int(value)
        if abs(integer) > MAX_SAFE_INTEGER:
            raise ValueError("integer-valued number is outside the supported safe integer range")
        if not integer_token_matches_number(token, integer):
            raise ValueError("integer-valued number token is not exactly represented")
    return value


def reject_constant(token: str) -> Any:
    raise ValueError(f"non-finite number is not valid JSON: {token}")


def assert_well_formed_unicode(value: str, label: str) -> None:
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise ValueError(f"{label} contains an unpaired surrogate")


def validate_value(value: Any, depth: int = 0, node_count: list[int] | None = None) -> None:
    """Validate materialized JSON data using the normative v2 value profile."""
    if node_count is None:
        node_count = [0]
    if depth > MAX_NESTING_DEPTH:
        raise ValueError("maximum nesting depth exceeded")
    node_count[0] += 1
    if node_count[0] > MAX_JSON_VALUE_NODES:
        raise ValueError("maximum JSON node count exceeded")

    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        assert_well_formed_unicode(value, "string")
        return
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise ValueError("integer is outside the supported safe integer range")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("numbers must be finite IEEE-754 values")
        if value == 0.0 and math.copysign(1.0, value) < 0:
            raise ValueError("negative zero is not supported")
        if value.is_integer() and abs(value) > MAX_SAFE_INTEGER:
            raise ValueError("integer-valued number is outside the supported safe integer range")
        return
    if isinstance(value, list):
        for item in value:
            validate_value(item, depth + 1, node_count)
        return
    if isinstance(value, dict):
        for key, member_value in value.items():
            if not isinstance(key, str):
                raise TypeError("JSON object member names must be strings")
            assert_well_formed_unicode(key, "object member name")
            validate_value(member_value, depth + 1, node_count)
        return
    raise TypeError(f"not a JSON value: {type(value).__name__}")


def parse_json(raw: bytes | str) -> Any:
    """Parse original UTF-8 bytes, rejecting duplicate keys and profile violations."""
    if isinstance(raw, str):
        try:
            encoded = raw.encode("utf-8", errors="strict")
        except UnicodeEncodeError as error:
            raise ValueError(f"input is not valid UTF-8: {error}") from error
    elif isinstance(raw, bytes):
        encoded = raw
    else:
        raise TypeError("JSON input must be original UTF-8 bytes or text")

    if len(encoded) > MAX_RAW_JSON_BYTES:
        raise ValueError(f"raw JSON exceeds the {MAX_RAW_JSON_BYTES}-byte limit")
    try:
        text = encoded.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ValueError(f"input is not valid UTF-8: {error}") from error
    if text.startswith("\ufeff"):
        raise ValueError("UTF-8 BOM is not permitted")

    try:
        value = json.loads(
            text,
            object_pairs_hook=reject_duplicate_keys,
            parse_int=parse_integer,
            parse_float=parse_float,
            parse_constant=reject_constant,
        )
    except json.JSONDecodeError as error:
        if error.msg == "Extra data":
            raise ValueError("trailing content after the JSON value") from error
        raise ValueError(f"invalid JSON: {error.msg}") from error
    except RecursionError as error:
        raise ValueError("maximum nesting depth exceeded") from error

    validate_value(value)
    return value


def quote_string(value: str) -> str:
    assert_well_formed_unicode(value, "string")
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def number_to_ecmascript(value: int | float) -> str:
    if isinstance(value, bool):
        raise TypeError("boolean is not a number here")
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise ValueError("unsafe integer")
        return str(value)
    if not math.isfinite(value):
        raise ValueError("non-finite number")
    if value == 0.0 and math.copysign(1.0, value) < 0:
        raise ValueError("negative zero")
    if value.is_integer():
        integer = int(value)
        if abs(integer) > MAX_SAFE_INTEGER:
            raise ValueError("unsafe integer-valued number")
        return str(integer)

    shortest = repr(value).lower()
    if "e" not in shortest:
        return shortest
    mantissa, exponent_text = shortest.split("e", 1)
    exponent = int(exponent_text)
    if -6 <= exponent < 21:
        return format(Decimal(shortest), "f")
    if mantissa.endswith(".0"):
        mantissa = mantissa[:-2]
    sign = "+" if exponent >= 0 else ""
    return f"{mantissa}e{sign}{exponent}"


def utf16_sort_key(value: str) -> bytes:
    assert_well_formed_unicode(value, "object member name")
    return value.encode("utf-16-be")


def _canonicalize(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return quote_string(value)
    if isinstance(value, (int, float)):
        return number_to_ecmascript(value)
    if isinstance(value, list):
        return "[" + ",".join(_canonicalize(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=utf16_sort_key)
        return "{" + ",".join(quote_string(key) + ":" + _canonicalize(value[key]) for key in keys) + "}"
    raise TypeError(f"not a JSON value: {type(value).__name__}")


def canonicalize(value: Any) -> str:
    validate_value(value)
    canonical = _canonicalize(value)
    if len(canonical.encode("utf-8")) > MAX_CANONICAL_OUTPUT_BYTES:
        raise ValueError(f"canonical output exceeds {MAX_CANONICAL_OUTPUT_BYTES} bytes")
    return canonical


def vector_input(vector: dict[str, Any]) -> bytes:
    if "input_hex" in vector:
        return bytes.fromhex(vector["input_hex"])
    return vector["input_utf8"].encode("utf-8")


def generated_raw(vector: dict[str, Any]) -> bytes:
    if vector["generator"] == "json_ascii_string":
        return json.dumps("a" * vector["content_bytes"], ensure_ascii=True).encode("utf-8")
    if vector["generator"] == "nested_arrays":
        depth = vector["depth"]
        return ("[" * depth + "0" + "]" * depth).encode("ascii")
    raise ValueError(f"unknown raw boundary vector generator: {vector['generator']}")


def generated_value(vector: dict[str, Any]) -> Any:
    if vector["generator"] == "materialized_ascii_string":
        return "a" * vector["content_bytes"]
    if vector["generator"] == "nested_arrays":
        value: Any = 0
        for _ in range(vector["depth"]):
            value = [value]
        return value
    if vector["generator"] == "array_of_nulls":
        return [None] * vector["items"]
    raise ValueError(f"unknown materialized boundary vector generator: {vector['generator']}")


def verify_vectors() -> int:
    vectors = json.loads(VECTORS.read_text(encoding="utf-8"))
    expect(vectors["protocol_id"] == PROTOCOL_ID, "protocol_id mismatch")
    expect(vectors["protocol_version"] == PROTOCOL_VERSION, "protocol_version mismatch")
    expect(vectors["profile"] == {
        "max_raw_json_bytes": MAX_RAW_JSON_BYTES,
        "max_canonical_output_bytes": MAX_CANONICAL_OUTPUT_BYTES,
        "max_nesting_depth": MAX_NESTING_DEPTH,
        "max_json_value_nodes": MAX_JSON_VALUE_NODES,
        "integer_valued_numbers": "safe-integers-only",
        "negative_zero": "reject",
        "unicode": "valid-utf8-and-well-formed-scalars",
        "duplicate_decoded_object_keys": "reject",
    }, "normative profile metadata mismatch")

    checked = 0
    for vector in vectors["canonicalization_vectors"]:
        actual = canonicalize(parse_json(vector["input_utf8"].encode("utf-8")))
        expect(actual == vector["canonical_utf8"], vector["name"])
        checked += 1

    for vector in vectors["strict_parse_vectors"]:
        try:
            value = parse_json(vector_input(vector))
        except (TypeError, ValueError, UnicodeError, RecursionError) as error:
            expect(vector["expected"] == "reject", f"{vector['name']}: unexpected rejection: {error}")
            expect(vector["error"].lower() in str(error).lower(), f"{vector['name']}: wrong rejection: {error}")
        else:
            expect(vector["expected"] == "accept", f"{vector['name']}: unexpected acceptance")
            expect(canonicalize(value) == vector["canonical_utf8"], vector["name"])
        checked += 1

    for vector in vectors["generated_boundary_vectors"]:
        try:
            if vector["operation"] == "parse":
                value = parse_json(generated_raw(vector))
            else:
                value = generated_value(vector)
            actual = canonicalize(value)
        except (TypeError, ValueError, UnicodeError, RecursionError) as error:
            expect(vector["expected"] == "reject", f"{vector['name']}: unexpected rejection: {error}")
            expect(vector["error"].lower() in str(error).lower(), f"{vector['name']}: wrong rejection: {error}")
        else:
            expect(vector["expected"] == "accept", f"{vector['name']}: unexpected acceptance")
            expect(len(actual.encode("utf-8")) == vector["canonical_bytes"], vector["name"])
        checked += 1

    for vector in vectors["digest_vectors"]:
        payload = parse_json(vector["payload_utf8"].encode("utf-8"))
        envelope = {
            "protocol_id": PROTOCOL_ID,
            "protocol_version": PROTOCOL_VERSION,
            "component_domain": vector["domain"],
            "component_version": vector["component_version"],
            "payload": payload,
        }
        canonical = canonicalize(envelope)
        expect(canonical == vector["canonical_envelope_utf8"], vector["name"])
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        expect(digest == vector["sha256"], vector["name"])
        checked += 1

    return checked


def main() -> None:
    checked = verify_vectors()
    print(f"AGG checkpoint v2 cross-language vectors: PASS ({checked} vectors)")


if __name__ == "__main__":
    main()

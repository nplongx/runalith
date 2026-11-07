//! AGG external-checkpoint v2 strict JSON, JCS and domain-digest profile.
//!
//! This module implements the constrained I-JSON profile shared with
//! src/runtime/agg-checkpoint-jcs-v2.js. Callers handling external bytes must
//! use parse_json before canonicalization so duplicate keys and numeric-token
//! ambiguity cannot be erased by an earlier parser.

use std::cell::Cell;
use std::collections::{BTreeMap, HashSet};
use std::rc::Rc;

use serde::Deserializer;
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Protocol identifier embedded in every component digest envelope.
pub const PROTOCOL_ID: &str = "runalith.agg.external-checkpoint";
/// Protocol version embedded in every component digest envelope.
pub const PROTOCOL_VERSION: u64 = 2;
/// Maximum raw input and canonical output size.
pub const MAX_JSON_BYTES: usize = 1_048_576;
/// Maximum nesting depth, with the root at depth zero.
pub const MAX_JSON_DEPTH: usize = 256;
/// Maximum materialized JSON values, excluding object member names.
pub const MAX_JSON_NODES: usize = 1_000_000;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Strict parser, canonicalizer or digest error.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum AggCheckpointError {
    /// Input violated the normative v2 constrained JSON profile.
    #[error("AGG checkpoint v2 JCS: {0}")]
    Invalid(String),
}

fn invalid(message: impl Into<String>) -> AggCheckpointError {
    AggCheckpointError::Invalid(message.into())
}

/// Parse the original UTF-8 bytes with duplicate-key and numeric-token checks.
pub fn parse_json(bytes: &[u8]) -> Result<Value, AggCheckpointError> {
    parse_json_with_negative_zero(bytes, false)
}

/// Parse strict JSON for a protocol whose reference normalizes negative zero
/// to positive zero during canonical graph construction.
///
/// The AGG graph schema uses this because its Node reference validates finite
/// non-negative metrics and then hashes JSON.stringify output, which converts
/// -0 to 0. JCS checkpoint payloads must continue using parse_json, which
/// rejects negative zero.
pub fn parse_json_with_negative_zero(
    bytes: &[u8],
    allow_negative_zero: bool,
) -> Result<Value, AggCheckpointError> {
    if bytes.len() > MAX_JSON_BYTES {
        return Err(invalid(format!(
            "raw JSON exceeds the {MAX_JSON_BYTES}-byte limit"
        )));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|error| invalid(format!("input is not valid UTF-8: {error}")))?;
    if text.starts_with('\u{feff}') {
        return Err(invalid("UTF-8 BOM is not permitted"));
    }
    validate_surrogate_escapes(bytes)?;
    validate_number_tokens(bytes, allow_negative_zero)?;

    let nodes = Rc::new(Cell::new(0));
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    deserializer.disable_recursion_limit();
    let value = StrictSeed {
        depth: 0,
        nodes,
        allow_negative_zero,
    }
    .deserialize(&mut deserializer)
    .map_err(|error| invalid(format!("invalid JSON: {error}")))?;
    deserializer
        .end()
        .map_err(|error| invalid(format!("trailing content or invalid JSON: {error}")))?;
    Ok(value)
}

fn validate_surrogate_escapes(bytes: &[u8]) -> Result<(), AggCheckpointError> {
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'"' {
            index += 1;
            continue;
        }
        index += 1;
        while index < bytes.len() && bytes[index] != b'"' {
            if bytes[index] != b'\\' {
                index += 1;
                continue;
            }
            if bytes.get(index + 1) == Some(&b'u') {
                let first = parse_hex_quad(bytes, index + 2)?;
                index += 6;
                if (0xd800..=0xdbff).contains(&first) {
                    if bytes.get(index..index + 2) != Some(b"\\u") {
                        return Err(invalid("string contains an unpaired high surrogate"));
                    }
                    let second = parse_hex_quad(bytes, index + 2)?;
                    if !(0xdc00..=0xdfff).contains(&second) {
                        return Err(invalid("string contains an unpaired high surrogate"));
                    }
                    index += 6;
                } else if (0xdc00..=0xdfff).contains(&first) {
                    return Err(invalid("string contains an unpaired low surrogate"));
                }
            } else {
                index = (index + 2).min(bytes.len());
            }
        }
        index = (index + 1).min(bytes.len());
    }
    Ok(())
}

fn parse_hex_quad(bytes: &[u8], start: usize) -> Result<u16, AggCheckpointError> {
    let raw = bytes
        .get(start..start + 4)
        .ok_or_else(|| invalid("string contains an incomplete Unicode escape"))?;
    let text = std::str::from_utf8(raw)
        .map_err(|_| invalid("string contains an invalid Unicode escape"))?;
    u16::from_str_radix(text, 16).map_err(|_| invalid("string contains an invalid Unicode escape"))
}

struct StrictSeed {
    depth: usize,
    nodes: Rc<Cell<usize>>,
    allow_negative_zero: bool,
}

impl<'de> DeserializeSeed<'de> for StrictSeed {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        if self.depth > MAX_JSON_DEPTH {
            return Err(serde::de::Error::custom("maximum nesting depth exceeded"));
        }
        let count = self.nodes.get().saturating_add(1);
        if count > MAX_JSON_NODES {
            return Err(serde::de::Error::custom("maximum JSON node count exceeded"));
        }
        self.nodes.set(count);
        deserializer.deserialize_any(StrictVisitor {
            depth: self.depth,
            nodes: self.nodes,
            allow_negative_zero: self.allow_negative_zero,
        })
    }
}

struct StrictVisitor {
    depth: usize,
    nodes: Rc<Cell<usize>>,
    allow_negative_zero: bool,
}

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a value in the AGG checkpoint v2 JSON profile")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Value, E>
    where
        E: serde::de::Error,
    {
        if (value as f64).abs() > MAX_SAFE_INTEGER {
            return Err(E::custom(
                "integer is outside the supported safe integer range",
            ));
        }
        Ok(Value::Number(Number::from(value)))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Value, E>
    where
        E: serde::de::Error,
    {
        if value > MAX_SAFE_INTEGER as u64 {
            return Err(E::custom(
                "integer is outside the supported safe integer range",
            ));
        }
        Ok(Value::Number(Number::from(value)))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Value, E>
    where
        E: serde::de::Error,
    {
        if !value.is_finite() {
            return Err(E::custom("numbers must be finite IEEE-754 values"));
        }
        if value == 0.0 && value.is_sign_negative() {
            if self.allow_negative_zero {
                return Ok(Value::Number(Number::from(0)));
            }
            return Err(E::custom("negative zero is not supported"));
        }
        if value.fract() == 0.0 && value.abs() > MAX_SAFE_INTEGER {
            return Err(E::custom(
                "integer-valued number is outside the supported safe integer range",
            ));
        }
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("numbers must be finite IEEE-754 values"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Value, E>
    where
        E: serde::de::Error,
    {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Value, E>
    where
        E: serde::de::Error,
    {
        Ok(Value::String(value))
    }

    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(StrictSeed {
            depth: self.depth + 1,
            nodes: Rc::clone(&self.nodes),
            allow_negative_zero: self.allow_negative_zero,
        })? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A>(self, mut object: A) -> Result<Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Map::new();
        let mut seen = HashSet::new();
        while let Some(key) = object.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(serde::de::Error::custom(format!(
                    "duplicate decoded object key: {key}"
                )));
            }
            let value = object.next_value_seed(StrictSeed {
                depth: self.depth + 1,
                nodes: Rc::clone(&self.nodes),
                allow_negative_zero: self.allow_negative_zero,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}

fn validate_number_tokens(
    bytes: &[u8],
    allow_negative_zero: bool,
) -> Result<(), AggCheckpointError> {
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                index += 1;
                while index < bytes.len() {
                    match bytes[index] {
                        b'\\' => index = (index + 2).min(bytes.len()),
                        b'"' => {
                            index += 1;
                            break;
                        }
                        _ => index += 1,
                    }
                }
            }
            b'-' | b'0'..=b'9' => {
                let start = index;
                while index < bytes.len()
                    && !matches!(
                        bytes[index],
                        b',' | b']' | b'}' | b' ' | b'\t' | b'\r' | b'\n'
                    )
                {
                    index += 1;
                }
                let token = std::str::from_utf8(&bytes[start..index])
                    .map_err(|error| invalid(format!("invalid number token: {error}")))?;
                validate_number_token(token, allow_negative_zero)?;
            }
            _ => index += 1,
        }
    }
    Ok(())
}

fn validate_number_token(token: &str, allow_negative_zero: bool) -> Result<(), AggCheckpointError> {
    let value = token
        .parse::<f64>()
        .map_err(|_| invalid("invalid JSON number token"))?;
    if !value.is_finite() {
        return Err(invalid("number is outside the supported finite range"));
    }
    if value == 0.0 && value.is_sign_negative() {
        if allow_negative_zero {
            return Ok(());
        }
        return Err(invalid("negative zero is not supported"));
    }
    if value.fract() == 0.0 {
        if value.abs() > MAX_SAFE_INTEGER {
            return Err(invalid(
                "integer is outside the supported safe integer range",
            ));
        }
        if !integer_token_matches_number(token, value as i64) {
            return Err(invalid(
                "integer-valued number token is not exactly represented",
            ));
        }
    }
    Ok(())
}

fn integer_token_matches_number(token: &str, value: i64) -> bool {
    let (negative, unsigned) = token
        .strip_prefix('-')
        .map_or((false, token), |rest| (true, rest));
    let (mantissa, exponent_text) = unsigned.find(['e', 'E']).map_or((unsigned, "0"), |index| {
        (&unsigned[..index], &unsigned[index + 1..])
    });
    let (integer, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = format!("{integer}{fraction}");
    if digits.bytes().all(|digit| digit == b'0') {
        return value == 0;
    }
    let exponent = match exponent_text.parse::<i64>() {
        Ok(value) if value.unsigned_abs() <= 9_007_199_254_740_991 => value,
        _ => return false,
    };
    let scale = fraction.len() as i64 - exponent;
    let integer_digits = if scale > 0 {
        let scale = scale as usize;
        if scale >= digits.len() {
            return false;
        }
        let split = digits.len() - scale;
        if !digits[split..].bytes().all(|digit| digit == b'0') {
            return false;
        }
        digits[..split].to_owned()
    } else {
        let significant = digits.trim_start_matches('0');
        let appended = (-scale) as usize;
        if significant.len().saturating_add(appended) > 16 {
            return false;
        }
        format!("{significant}{}", "0".repeat(appended))
    };
    let magnitude = integer_digits.trim_start_matches('0');
    let magnitude = if magnitude.is_empty() { "0" } else { magnitude };
    let Ok(magnitude) = magnitude.parse::<u64>() else {
        return false;
    };
    if magnitude > MAX_SAFE_INTEGER as u64 {
        return false;
    }
    let exact = if negative {
        -(magnitude as i64)
    } else {
        magnitude as i64
    };
    exact == value
}

/// Canonicalize a materialized JSON value using RFC 8785 key/number rules.
pub fn canonicalize(value: &Value) -> Result<String, AggCheckpointError> {
    let mut nodes = 0;
    let canonical = canonicalize_value(value, 0, &mut nodes)?;
    if canonical.len() > MAX_JSON_BYTES {
        return Err(invalid(format!(
            "canonical output exceeds {MAX_JSON_BYTES} bytes"
        )));
    }
    Ok(canonical)
}

fn canonicalize_value(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
) -> Result<String, AggCheckpointError> {
    if depth > MAX_JSON_DEPTH {
        return Err(invalid("maximum nesting depth exceeded"));
    }
    *nodes = nodes.saturating_add(1);
    if *nodes > MAX_JSON_NODES {
        return Err(invalid("maximum JSON node count exceeded"));
    }
    match value {
        Value::Null => Ok("null".into()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(number) => {
            let value = number
                .as_f64()
                .ok_or_else(|| invalid("number is outside the supported finite range"))?;
            if !value.is_finite() {
                return Err(invalid("numbers must be finite IEEE-754 values"));
            }
            if value == 0.0 && value.is_sign_negative() {
                return Err(invalid("negative zero is not supported"));
            }
            if value.fract() == 0.0 && value.abs() > MAX_SAFE_INTEGER {
                return Err(invalid(
                    "integer-valued number is outside the supported safe integer range",
                ));
            }
            Ok(ecmascript_number_to_string(value))
        }
        Value::String(value) => serde_json::to_string(value)
            .map_err(|error| invalid(format!("cannot serialize string: {error}"))),
        Value::Array(values) => {
            let mut output = String::from("[");
            for (index, item) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&canonicalize_value(item, depth + 1, nodes)?);
            }
            output.push(']');
            Ok(output)
        }
        Value::Object(values) => {
            let mut keys: Vec<&String> = values.keys().collect();
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            let mut output = String::from("{");
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key)
                        .map_err(|error| invalid(format!("cannot serialize key: {error}")))?,
                );
                output.push(':');
                output.push_str(&canonicalize_value(&values[*key], depth + 1, nodes)?);
            }
            output.push('}');
            Ok(output)
        }
    }
}

/// Serialize one finite IEEE-754 value using ECMAScript NumberToString rules.
///
/// Callers must reject negative zero when their profile forbids it.
pub fn ecmascript_number_to_string(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let raw = format!("{value:?}").to_lowercase();
    let (negative, unsigned) = raw
        .strip_prefix('-')
        .map_or((false, raw.as_str()), |rest| (true, rest));
    let (mantissa, exponent) = unsigned
        .split_once('e')
        .map_or((unsigned, 0_i32), |(mantissa, exponent)| {
            (mantissa, exponent.parse::<i32>().unwrap_or(0))
        });
    let decimal_position = mantissa.find('.').unwrap_or(mantissa.len()) as i32 + exponent;
    let mut digits: String = mantissa
        .chars()
        .filter(|character| *character != '.')
        .collect();
    let leading_zeroes = digits.bytes().take_while(|digit| *digit == b'0').count();
    digits.drain(..leading_zeroes);
    let decimal_position = decimal_position - leading_zeroes as i32;
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }
    let scientific_exponent = decimal_position - 1;
    let body = if (-6..21).contains(&scientific_exponent) {
        if decimal_position <= 0 {
            format!("0.{}{}", "0".repeat((-decimal_position) as usize), digits)
        } else if decimal_position as usize >= digits.len() {
            format!(
                "{}{}",
                digits,
                "0".repeat(decimal_position as usize - digits.len())
            )
        } else {
            let split = decimal_position as usize;
            format!("{}.{}", &digits[..split], &digits[split..])
        }
    } else {
        let fraction = if digits.len() > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        format!(
            "{}{}e{}{}",
            &digits[..1],
            fraction,
            if scientific_exponent >= 0 { "+" } else { "" },
            scientific_exponent
        )
    };
    if negative { format!("-{body}") } else { body }
}

/// Build the versioned, domain-separated digest envelope.
pub fn digest_envelope(
    domain: &str,
    component_version: u64,
    payload: Value,
) -> Result<Value, AggCheckpointError> {
    if domain.len() > 96 || !valid_domain(domain) {
        return Err(invalid(
            "domain must be a bounded lowercase protocol identifier",
        ));
    }
    if component_version == 0 || component_version > MAX_SAFE_INTEGER as u64 {
        return Err(invalid("component version must be a positive safe integer"));
    }
    let mut envelope = BTreeMap::new();
    envelope.insert("protocol_id", Value::String(PROTOCOL_ID.into()));
    envelope.insert("protocol_version", Value::from(PROTOCOL_VERSION));
    envelope.insert("component_domain", Value::String(domain.into()));
    envelope.insert("component_version", Value::from(component_version));
    envelope.insert("payload", payload);
    serde_json::to_value(envelope)
        .map_err(|error| invalid(format!("cannot create digest envelope: {error}")))
}

/// Compute SHA-256 over the canonical versioned component envelope.
pub fn domain_digest(
    domain: &str,
    component_version: u64,
    payload: Value,
) -> Result<String, AggCheckpointError> {
    let envelope = digest_envelope(domain, component_version, payload)?;
    let canonical = canonicalize(&envelope)?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

fn valid_domain(domain: &str) -> bool {
    let bytes = domain.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    let mut previous_was_separator = false;
    for byte in bytes.iter().copied().skip(1) {
        if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            previous_was_separator = false;
        } else if matches!(byte, b'.' | b'_' | b'-') && !previous_was_separator {
            previous_was_separator = true;
        } else {
            return false;
        }
    }
    !previous_was_separator
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../../tests/fixtures/agg-checkpoint-v2-jcs-vectors.json"
        ))
        .unwrap()
    }

    #[test]
    fn shared_canonicalization_vectors_match_node_wire_bytes() {
        for vector in vectors()["canonicalization_vectors"].as_array().unwrap() {
            let value = parse_json(vector["input_utf8"].as_str().unwrap().as_bytes()).unwrap();
            assert_eq!(
                canonicalize(&value).unwrap(),
                vector["canonical_utf8"].as_str().unwrap(),
                "{}",
                vector["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn shared_strict_parse_vectors_match_acceptance_and_error_classes() {
        for vector in vectors()["strict_parse_vectors"].as_array().unwrap() {
            let input = if let Some(text) = vector["input_utf8"].as_str() {
                text.as_bytes().to_vec()
            } else {
                hex::decode(vector["input_hex"].as_str().unwrap()).unwrap()
            };
            let result = parse_json(&input);
            if vector["expected"] == "accept" {
                let value = result.unwrap();
                assert_eq!(
                    canonicalize(&value).unwrap(),
                    vector["canonical_utf8"].as_str().unwrap()
                );
            } else {
                let error = result.unwrap_err().to_string().to_lowercase();
                let expected = vector["error"].as_str().unwrap().to_lowercase();
                assert!(
                    error.contains(&expected),
                    "{}: expected {expected:?}, got {error:?}",
                    vector["name"].as_str().unwrap()
                );
            }
        }
    }

    #[test]
    fn shared_domain_digest_vector_matches_node_and_python() {
        let vector = &vectors()["digest_vectors"][0];
        let payload = parse_json(vector["payload_utf8"].as_str().unwrap().as_bytes()).unwrap();
        assert_eq!(
            canonicalize(
                &digest_envelope(
                    vector["domain"].as_str().unwrap(),
                    vector["component_version"].as_u64().unwrap(),
                    payload.clone()
                )
                .unwrap()
            )
            .unwrap(),
            vector["canonical_envelope_utf8"].as_str().unwrap()
        );
        assert_eq!(
            domain_digest(
                vector["domain"].as_str().unwrap(),
                vector["component_version"].as_u64().unwrap(),
                payload
            )
            .unwrap(),
            vector["sha256"].as_str().unwrap()
        );
    }

    #[test]
    fn raw_and_canonical_byte_limits_are_enforced() {
        let exact = format!("{{\"value\":\"{}\"}}", "x".repeat(MAX_JSON_BYTES - 12));
        assert_eq!(
            parse_json(exact.as_bytes()).unwrap()["value"]
                .as_str()
                .unwrap()
                .len(),
            MAX_JSON_BYTES - 12
        );
        let too_large = format!("{{\"value\":\"{}\"}}", "x".repeat(MAX_JSON_BYTES - 11));
        assert!(parse_json(too_large.as_bytes()).is_err());
        let exact_canonical = Value::String("x".repeat(MAX_JSON_BYTES - 2));
        assert_eq!(
            canonicalize(&exact_canonical).unwrap().len(),
            MAX_JSON_BYTES
        );
        let value = Value::String("x".repeat(MAX_JSON_BYTES));
        assert!(
            canonicalize(&value)
                .unwrap_err()
                .to_string()
                .contains("canonical output exceeds")
        );
    }

    #[test]
    fn materialized_depth_and_node_limits_are_enforced() {
        let mut nested = Value::Null;
        for _ in 0..MAX_JSON_DEPTH {
            nested = Value::Array(vec![nested]);
        }
        assert!(canonicalize(&nested).is_ok());
        nested = Value::Array(vec![nested]);
        assert!(
            canonicalize(&nested)
                .unwrap_err()
                .to_string()
                .contains("nesting depth")
        );

        let too_many = Value::Array(vec![Value::Null; MAX_JSON_NODES]);
        assert!(
            canonicalize(&too_many)
                .unwrap_err()
                .to_string()
                .contains("node count")
        );
    }

    #[test]
    fn raw_parser_enforces_exact_nesting_depth_boundary() {
        let exact = format!(
            "{}null{}",
            "[".repeat(MAX_JSON_DEPTH),
            "]".repeat(MAX_JSON_DEPTH)
        );
        assert_eq!(
            canonicalize(&parse_json(exact.as_bytes()).unwrap()).unwrap(),
            exact
        );
        let too_deep = format!("[{exact}]");
        assert!(
            parse_json(too_deep.as_bytes())
                .unwrap_err()
                .to_string()
                .contains("nesting depth")
        );
    }

    #[test]
    fn component_domain_uses_closed_lowercase_identifier_grammar() {
        let payload = Value::Null;
        for valid in ["a", "anti_replay_state", "goal.idea-v2", "a9.b_2-c3"] {
            assert!(
                digest_envelope(valid, 1, payload.clone()).is_ok(),
                "{valid}"
            );
        }
        for invalid_domain in ["", "A", "9a", "a.", "a..b", "a._b", "a__b", "a/b"] {
            assert!(
                digest_envelope(invalid_domain, 1, payload.clone()).is_err(),
                "{invalid_domain}"
            );
        }
        assert!(digest_envelope("valid", 0, payload.clone()).is_err());
        assert!(digest_envelope("valid", MAX_SAFE_INTEGER as u64 + 1, payload).is_err());
    }

    #[test]
    fn object_keys_use_utf16_order_without_unicode_normalization() {
        let value = parse_json(
            "{\"דּ\":6,\"😀\":5,\"€\":4,\"ö\":3,\"1\":2,\"\\r\":1,\"é\":\"NFC\",\"é\":\"NFD\"}"
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            canonicalize(&value).unwrap(),
            "{\"\\r\":1,\"1\":2,\"é\":\"NFD\",\"é\":\"NFC\",\"ö\":3,\"€\":4,\"😀\":5,\"דּ\":6}"
        );
    }

    #[test]
    fn digest_domains_and_versions_cannot_alias() {
        let payload = serde_json::json!({"high_water":4,"nonces":["n1","n2"]});
        let first = domain_digest("anti_replay_state", 1, payload.clone()).unwrap();
        assert_ne!(
            first,
            domain_digest("execution_authorization_state", 1, payload.clone()).unwrap()
        );
        assert_ne!(
            first,
            domain_digest("anti_replay_state", 2, payload).unwrap()
        );
    }

    #[test]
    fn strict_jcs_rejects_negative_zero_but_graph_profile_can_normalize_it() {
        assert!(parse_json(b"-0").is_err());
        assert!(parse_json(b"-0.0").is_err());
        assert_eq!(
            parse_json_with_negative_zero(b"-0.0", true).unwrap(),
            Value::from(0)
        );
    }
}

//! Node-compatible canonical JSON for workflow-plan and plan-hash inputs.
//!
//! The Node public API `src/runtime/workflow/plan.js::canonicalJson` sorts
//! object keys with JavaScript's UTF-16 code-unit ordering and then uses
//! `JSON.stringify`. Rust's default `serde_json::Map` ordering is Unicode
//! scalar-value order, which differs for supplementary-plane keys. This
//! module implements the Node ordering explicitly.
//!
//! Numeric formatting follows ECMAScript Number serialization: finite IEEE-754
//! values use shortest round-trippable decimal digits, fixed notation for
//! magnitudes in [1e-6, 1e21), exponent notation outside that interval, and
//! negative zero normalizes to zero. The workspace enables serde_json's
//! `float_roundtrip` feature so parsed decimal values preserve the same binary
//! Number as Node's JSON.parse before canonicalization.

use std::fmt::Write as _;

use serde_json::Value;
use thiserror::Error;

/// Canonicalization failures for values that cannot be represented as a
/// finite JavaScript-compatible Number or JSON string.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum NodePlanCanonicalJsonError {
    /// A JSON number could not be represented as a finite IEEE-754 Number.
    #[error("Node plan canonical JSON requires finite JavaScript Number values")]
    UnsupportedNumber,
    /// String serialization unexpectedly failed in serde_json.
    #[error("could not serialize JSON string for Node canonical JSON")]
    StringSerialization,
}

/// Serialize a JSON value using the proven Node public `canonicalJson` rules.
///
/// Object properties are sorted by UTF-16 code units, arrays retain order,
/// string escaping follows JSON.stringify, and numbers follow ECMAScript
/// Number::toString thresholds and shortest-roundtrip formatting.
pub fn canonicalize_node_plan_json(value: &Value) -> Result<String, NodePlanCanonicalJsonError> {
    let mut output = String::new();
    write_value(value, &mut output)?;
    Ok(output)
}

fn write_value(value: &Value, output: &mut String) -> Result<(), NodePlanCanonicalJsonError> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(number) => write_number(number, output)?,
        Value::String(value) => write_string(value, output)?,
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_value(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            let mut entries: Vec<_> = values.iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
            output.push('{');
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_string(key, output)?;
                output.push(':');
                write_value(value, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn write_number(
    number: &serde_json::Number,
    output: &mut String,
) -> Result<(), NodePlanCanonicalJsonError> {
    let Some(value) = number.as_f64() else {
        return Err(NodePlanCanonicalJsonError::UnsupportedNumber);
    };
    if !value.is_finite() {
        return Err(NodePlanCanonicalJsonError::UnsupportedNumber);
    }
    output.push_str(&ecmascript_number_to_string(value));
    Ok(())
}

/// Format a finite f64 like ECMAScript Number::toString / JSON.stringify.
///
/// Rust Display supplies shortest round-trippable decimal digits without an
/// exponent. ECMAScript uses that same shortest value but switches to exponent
/// notation below 1e-6 and at or above 1e21. Build the scientific coefficient
/// from the Display digits so the decimal digits themselves are not rounded or
/// recomputed during the notation conversion.
fn ecmascript_number_to_string(value: f64) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }

    let sign = if value.is_sign_negative() { "-" } else { "" };
    let magnitude = value.abs();
    let decimal = magnitude.to_string();

    if (1e-6..1e21).contains(&magnitude) {
        return format!("{sign}{decimal}");
    }

    let (integer, fraction) = decimal
        .split_once('.')
        .map_or((decimal.as_str(), ""), |(integer, fraction)| {
            (integer, fraction)
        });
    let digits = format!("{integer}{fraction}");
    let leading_zeroes = digits.bytes().take_while(|byte| *byte == b'0').count();
    let significant = digits[leading_zeroes..].trim_end_matches('0');
    debug_assert!(
        !significant.is_empty(),
        "non-zero finite value has significant digits"
    );

    let exponent = integer.len() as i32 - leading_zeroes as i32 - 1;
    let mut output = String::with_capacity(sign.len() + significant.len() + 12);
    output.push_str(sign);
    output.push(significant.as_bytes()[0] as char);
    if significant.len() > 1 {
        output.push('.');
        output.push_str(&significant[1..]);
    }
    output.push('e');
    if exponent >= 0 {
        output.push('+');
        let _ = write!(output, "{exponent}");
    } else {
        let _ = write!(output, "{exponent}");
    }
    output
}

fn write_string(value: &str, output: &mut String) -> Result<(), NodePlanCanonicalJsonError> {
    let encoded = serde_json::to_string(value)
        .map_err(|_| NodePlanCanonicalJsonError::StringSerialization)?;
    output.push_str(&encoded);
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::Value;
    use sha2::{Digest, Sha256};

    use super::*;

    #[derive(Debug, Deserialize)]
    struct NodeCanonicalJsonOracle {
        schema_version: u32,
        generated_by_node: bool,
        source: String,
        vectors: Vec<CanonicalVector>,
    }

    #[derive(Debug, Deserialize)]
    struct CanonicalVector {
        name: String,
        input_json: String,
        canonical_json: String,
        sha256: String,
    }

    fn oracle() -> NodeCanonicalJsonOracle {
        serde_json::from_str(include_str!(
            "../tests/fixtures/node-plan-canonical-json-v1.json"
        ))
        .expect("Node canonical JSON oracle must parse")
    }

    fn number_oracle() -> NodeCanonicalJsonOracle {
        serde_json::from_str(include_str!(
            "../tests/fixtures/node-plan-number-canonical-json-v1.json"
        ))
        .expect("Node ECMAScript-number oracle must parse")
    }

    fn sha256(bytes: &[u8]) -> String {
        let digest = Sha256::digest(bytes);
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn canonical_json_matches_node_public_api_vectors_and_hashes() {
        let fixture = oracle();
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.generated_by_node);
        assert!(fixture.source.contains("workflow/plan.js::canonicalJson"));
        assert!(fixture.vectors.len() >= 5);

        for vector in fixture.vectors {
            let value: Value = serde_json::from_str(&vector.input_json)
                .unwrap_or_else(|error| panic!("{} input must parse: {error}", vector.name));
            let actual = canonicalize_node_plan_json(&value)
                .unwrap_or_else(|error| panic!("{} canonicalization failed: {error}", vector.name));
            assert_eq!(actual, vector.canonical_json, "{}", vector.name);
            assert_eq!(sha256(actual.as_bytes()), vector.sha256, "{}", vector.name);
        }
    }

    #[test]
    fn canonical_json_matches_node_ecmascript_number_vectors_and_hashes() {
        let fixture = number_oracle();
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.generated_by_node);
        assert!(fixture.source.contains("JSON.parse"));
        assert_eq!(fixture.vectors.len(), 3);

        for vector in fixture.vectors {
            let value: Value = serde_json::from_str(&vector.input_json)
                .unwrap_or_else(|error| panic!("{} input must parse: {error}", vector.name));
            let actual = canonicalize_node_plan_json(&value)
                .unwrap_or_else(|error| panic!("{} canonicalization failed: {error}", vector.name));
            assert_eq!(actual, vector.canonical_json, "{}", vector.name);
            assert_eq!(sha256(actual.as_bytes()), vector.sha256, "{}", vector.name);
        }
    }

    #[test]
    fn serde_json_cannot_construct_non_finite_json_numbers() {
        assert!(serde_json::Number::from_f64(f64::NAN).is_none());
        assert!(serde_json::Number::from_f64(f64::INFINITY).is_none());
        assert!(serde_json::Number::from_f64(f64::NEG_INFINITY).is_none());
    }

    #[test]
    fn canonical_json_uses_utf16_object_key_order_and_negative_zero_normalization() {
        let value: Value = serde_json::from_str(r#"{"\uE000":1,"😀":2,"z":3}"#).unwrap();
        assert_eq!(
            canonicalize_node_plan_json(&value).unwrap(),
            format!(r#"{{"z":3,"😀":2,"{}":1}}"#, '\u{e000}')
        );
        let negative_zero: Value = serde_json::from_str("-0.0").unwrap();
        assert_eq!(canonicalize_node_plan_json(&negative_zero).unwrap(), "0");
    }
}

//! Phase 2 discriminator model v2 validation and scoring.
//!
//! This module deliberately does not participate in Phase 1 search. A validated
//! model is an offline estimate only; its score grants no evidence or execution
//! authority.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Node-compatible discriminator model schema.
pub const DISCRIMINATOR_SCHEMA_VERSION: u64 = 2;
/// Node-compatible feature schema.
pub const DISCRIMINATOR_FEATURE_SCHEMA_VERSION: u64 = 1;
/// Canonical ordered feature names used by model v2.
pub const DISCRIMINATOR_FEATURES: [&str; 7] = [
    "successConfidence",
    "riskSafety",
    "costEfficiency",
    "reusePotential",
    "informationValue",
    "testedHypothesisRatio",
    "supportEdgeRatio",
];

#[derive(Debug, Error, Clone, PartialEq, Eq)]
/// Validation and scoring errors for the discriminator contract.
pub enum DiscriminatorError {
    /// Model or feature input violates the Node contract.
    #[error("AdaptiveGoalDiscriminator: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, PartialEq)]
/// Model values after complete schema, metrics, and digest validation.
pub struct ValidatedDiscriminatorModel {
    /// Canonical model body SHA-256.
    pub model_sha256: String,
    /// Logistic regression intercept.
    pub intercept: f64,
    /// Per-feature training means.
    pub means: BTreeMap<String, f64>,
    /// Per-feature training scales.
    pub scales: BTreeMap<String, f64>,
    /// Per-feature logistic coefficients.
    pub weights: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, PartialEq)]
/// Unverified offline discriminator estimate.
pub struct DiscriminatorScore {
    /// Predicted positive-class probability.
    pub probability: f64,
    /// Canonical feature vector used for scoring.
    pub features: BTreeMap<String, f64>,
    /// Model identity used for scoring.
    pub model_sha256: String,
    /// Always `model_estimate_unverified`.
    pub classification: &'static str,
}

fn fail(message: impl Into<String>) -> DiscriminatorError {
    DiscriminatorError::Invalid(message.into())
}

fn object<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>, DiscriminatorError> {
    value
        .as_object()
        .ok_or_else(|| fail(format!("{field} must be an object")))
}

fn exact_keys(value: &Value, expected: &[&str], field: &str) -> Result<(), DiscriminatorError> {
    let map = object(value, field)?;
    let extra: Vec<_> = map
        .keys()
        .filter(|key| !expected.contains(&key.as_str()))
        .cloned()
        .collect();
    if !extra.is_empty() {
        return Err(fail(format!(
            "{field} has unsupported fields: {}",
            extra.join(", ")
        )));
    }
    for key in expected {
        if !map.contains_key(*key) {
            return Err(fail(format!("{field}.{key} is required")));
        }
    }
    Ok(())
}

fn value<'a>(input: &'a Value, key: &str, field: &str) -> Result<&'a Value, DiscriminatorError> {
    input
        .get(key)
        .ok_or_else(|| fail(format!("{field}.{key} is required")))
}

fn number(input: &Value, field: &str) -> Result<f64, DiscriminatorError> {
    input
        .as_f64()
        .filter(|number| number.is_finite())
        .ok_or_else(|| fail(format!("{field} must be finite")))
}

fn integer(input: &Value, field: &str) -> Result<u64, DiscriminatorError> {
    let value = input
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0 && value.fract() == 0.0)
        .ok_or_else(|| fail(format!("{field} must be a non-negative safe integer")))?;
    if value <= 9_007_199_254_740_991.0 {
        Ok(value as u64)
    } else {
        Err(fail(format!("{field} must be a non-negative safe integer")))
    }
}

fn digest(value: &Value) -> Result<String, DiscriminatorError> {
    // Match JSON.stringify's number spelling as well as canonicalJson's sorted
    // object keys. serde_json's serializer switches 1e-6 to exponent notation,
    // while JavaScript emits 0.000001.
    let canonical = canonical_value(value)?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

fn canonical_value(value: &Value) -> Result<String, DiscriminatorError> {
    Ok(match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::String(value) => {
            serde_json::to_string(value).map_err(|error| fail(error.to_string()))?
        }
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                integer.to_string()
            } else if let Some(integer) = value.as_u64() {
                integer.to_string()
            } else {
                let number = value
                    .as_f64()
                    .ok_or_else(|| fail("canonical JSON number is invalid"))?;
                if !number.is_finite() {
                    return Err(fail("canonical JSON only supports finite numbers"));
                }
                if number == 0.0 {
                    "0".to_owned()
                } else if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 {
                    format!("{number:.0}")
                } else {
                    javascript_number(number)
                }
            }
        }
        Value::Array(values) => {
            let parts = values
                .iter()
                .map(canonical_value)
                .collect::<Result<Vec<_>, _>>()?;
            format!("[{}]", parts.join(","))
        }
        Value::Object(values) => {
            let parts = values
                .iter()
                .map(|(key, value)| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key).map_err(|error| fail(error.to_string()))?,
                        canonical_value(value)?
                    ))
                })
                .collect::<Result<Vec<_>, DiscriminatorError>>()?;
            format!("{{{}}}", parts.join(","))
        }
    })
}

fn javascript_number(number: f64) -> String {
    let shortest = format!("{number:?}");
    let Some((mantissa, exponent)) = shortest.split_once('e') else {
        return shortest;
    };
    let exponent: i32 = exponent.parse().expect("Rust float exponent is numeric");
    if (-6..21).contains(&exponent) {
        let negative = mantissa.starts_with('-');
        let unsigned = mantissa.strip_prefix('-').unwrap_or(mantissa);
        let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
        let digits = format!("{whole}{fraction}");
        let decimal_position = whole.len() as i32 + exponent;
        let expanded = if decimal_position <= 0 {
            format!("0.{}{}", "0".repeat((-decimal_position) as usize), digits)
        } else if decimal_position as usize >= digits.len() {
            format!(
                "{}{}",
                digits,
                "0".repeat(decimal_position as usize - digits.len())
            )
        } else {
            format!(
                "{}.{}",
                &digits[..decimal_position as usize],
                &digits[decimal_position as usize..]
            )
        };
        let expanded = expanded
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned();
        if negative {
            format!("-{expanded}")
        } else {
            expanded
        }
    } else if exponent >= 0 {
        format!("{mantissa}e+{exponent}")
    } else {
        format!("{mantissa}e{exponent}")
    }
}

fn close(actual: f64, expected: f64) -> bool {
    (actual - expected).abs() <= 1e-12
}

/// Validate complete discriminator schema v2, provenance, metrics, calibration,
/// and canonical model digest. Unknown model fields are rejected.
pub fn validate_discriminator_model(
    model: &Value,
) -> Result<ValidatedDiscriminatorModel, DiscriminatorError> {
    const MODEL_KEYS: &[&str] = &[
        "schemaVersion",
        "featureSchemaVersion",
        "modelType",
        "featureNames",
        "datasetId",
        "trainingConfig",
        "trainingDataSha256",
        "validationDataSha256",
        "means",
        "scales",
        "weights",
        "intercept",
        "trainingExampleCount",
        "trainingClassCounts",
        "trainingMetrics",
        "modelSha256",
    ];
    exact_keys(model, MODEL_KEYS, "model")?;
    if value(model, "schemaVersion", "model")?.as_u64() != Some(DISCRIMINATOR_SCHEMA_VERSION)
        || value(model, "modelType", "model")?.as_str() != Some("standardized-logistic-regression")
    {
        return Err(fail("unsupported schemaVersion or modelType"));
    }
    if value(model, "featureSchemaVersion", "model")?.as_u64()
        != Some(DISCRIMINATOR_FEATURE_SCHEMA_VERSION)
    {
        return Err(fail("unsupported feature schema version"));
    }
    let dataset = value(model, "datasetId", "model")?.as_str().unwrap_or("");
    if !valid_slug(dataset) {
        return Err(fail("datasetId is invalid"));
    }

    let config = value(model, "trainingConfig", "model")?;
    exact_keys(
        config,
        &["learningRate", "epochs", "l2", "seed"],
        "model.trainingConfig",
    )?;
    let learning_rate = number(
        value(config, "learningRate", "model.trainingConfig")?,
        "model.trainingConfig.learningRate",
    )?;
    let epochs = integer(
        value(config, "epochs", "model.trainingConfig")?,
        "model.trainingConfig.epochs",
    )?;
    let l2 = number(
        value(config, "l2", "model.trainingConfig")?,
        "model.trainingConfig.l2",
    )?;
    integer(
        value(config, "seed", "model.trainingConfig")?,
        "model.trainingConfig.seed",
    )?;
    if learning_rate <= 0.0
        || learning_rate > 1.0
        || !(1..=100_000).contains(&epochs)
        || !(0.0..=10.0).contains(&l2)
    {
        return Err(fail("trainingConfig is invalid"));
    }

    for key in ["trainingDataSha256", "validationDataSha256"] {
        if !valid_digest(value(model, key, "model")?.as_str().unwrap_or("")) {
            return Err(fail("train/validation split identity is invalid"));
        }
    }
    let names = value(model, "featureNames", "model")?.as_array();
    if names.is_none_or(|names| {
        names.len() != DISCRIMINATOR_FEATURES.len()
            || names
                .iter()
                .zip(DISCRIMINATOR_FEATURES)
                .any(|(name, expected)| name.as_str() != Some(expected))
    }) {
        return Err(fail("featureNames mismatch"));
    }

    let mut parsed = Vec::new();
    for key in ["means", "scales", "weights"] {
        let field = format!("model.{key}");
        let source = value(model, key, "model")?;
        exact_keys(source, &DISCRIMINATOR_FEATURES, &field)?;
        let mut values = BTreeMap::new();
        for name in DISCRIMINATOR_FEATURES {
            let n = number(value(source, name, &field)?, &format!("{field}.{name}"))?;
            let valid = match key {
                "means" => (0.0..=1.0).contains(&n),
                "scales" => (1e-6..=1.0).contains(&n),
                _ => n.abs() <= 1e6,
            };
            if !valid {
                return Err(fail(match key {
                    "means" => format!("{field}.{name} must be in [0, 1]"),
                    "scales" => format!("{field}.{name} must be in [1e-6, 1]"),
                    _ => format!("{field}.{name} exceeds the numeric safety bound"),
                }));
            }
            values.insert(name.to_owned(), n);
        }
        parsed.push(values);
    }
    let intercept = number(value(model, "intercept", "model")?, "model.intercept")?;
    if intercept.abs() > 1e6 {
        return Err(fail(
            "model.intercept must be finite and within the numeric safety bound",
        ));
    }

    let count = integer(
        value(model, "trainingExampleCount", "model")?,
        "model.trainingExampleCount",
    )?;
    if count < 4 {
        return Err(fail("training provenance is invalid"));
    }
    let class_counts = value(model, "trainingClassCounts", "model")?;
    exact_keys(
        class_counts,
        &["negative", "positive"],
        "model.trainingClassCounts",
    )?;
    let negatives = integer(
        value(class_counts, "negative", "model.trainingClassCounts")?,
        "model.trainingClassCounts.negative",
    )?;
    let positives = integer(
        value(class_counts, "positive", "model.trainingClassCounts")?,
        "model.trainingClassCounts.positive",
    )?;
    if negatives < 1 || positives < 1 || negatives + positives != count {
        return Err(fail("training class counts mismatch"));
    }

    let metrics = value(model, "trainingMetrics", "model")?;
    const METRIC_KEYS: &[&str] = &[
        "accuracy",
        "balancedAccuracy",
        "logLoss",
        "precision",
        "recall",
        "f1",
        "brierScore",
        "confusionMatrix",
        "classBalance",
        "accuracyConfidenceInterval95",
        "calibration",
    ];
    exact_keys(metrics, METRIC_KEYS, "model.trainingMetrics")?;
    let mut scalar = BTreeMap::new();
    for key in [
        "accuracy",
        "balancedAccuracy",
        "logLoss",
        "precision",
        "recall",
        "f1",
        "brierScore",
    ] {
        let n = number(
            value(metrics, key, "model.trainingMetrics")?,
            &format!("model.trainingMetrics.{key}"),
        )?;
        if n < 0.0 || n > if key == "logLoss" { 35.0 } else { 1.0 } {
            return Err(fail(format!("model.trainingMetrics.{key} is invalid")));
        }
        scalar.insert(key, n);
    }
    let cm = value(metrics, "confusionMatrix", "model.trainingMetrics")?;
    exact_keys(
        cm,
        &[
            "truePositive",
            "trueNegative",
            "falsePositive",
            "falseNegative",
        ],
        "model.trainingMetrics.confusionMatrix",
    )?;
    let tp = integer(
        value(cm, "truePositive", "model.trainingMetrics.confusionMatrix")?,
        "confusionMatrix.truePositive",
    )?;
    let tn = integer(
        value(cm, "trueNegative", "model.trainingMetrics.confusionMatrix")?,
        "confusionMatrix.trueNegative",
    )?;
    let fp = integer(
        value(cm, "falsePositive", "model.trainingMetrics.confusionMatrix")?,
        "confusionMatrix.falsePositive",
    )?;
    let fn_ = integer(
        value(cm, "falseNegative", "model.trainingMetrics.confusionMatrix")?,
        "confusionMatrix.falseNegative",
    )?;
    if tp + tn + fp + fn_ != count {
        return Err(fail("training confusion matrix count mismatch"));
    }
    let balance = value(metrics, "classBalance", "model.trainingMetrics")?;
    exact_keys(
        balance,
        &["negative", "positive"],
        "model.trainingMetrics.classBalance",
    )?;
    let balance_negative = integer(
        value(balance, "negative", "model.trainingMetrics.classBalance")?,
        "classBalance.negative",
    )?;
    let balance_positive = integer(
        value(balance, "positive", "model.trainingMetrics.classBalance")?,
        "classBalance.positive",
    )?;
    if balance_negative < 1 || balance_positive < 1 || balance_negative + balance_positive != count
    {
        return Err(fail("training metric class balance mismatch"));
    }
    let expected_positive = tp + fn_;
    let expected_negative = tn + fp;
    let precision = if tp + fp == 0 {
        0.0
    } else {
        tp as f64 / (tp + fp) as f64
    };
    let recall = if expected_positive == 0 {
        0.0
    } else {
        tp as f64 / expected_positive as f64
    };
    let negative_recall = if expected_negative == 0 {
        0.0
    } else {
        tn as f64 / expected_negative as f64
    };
    let f1 = if precision + recall == 0.0 {
        0.0
    } else {
        2.0 * precision * recall / (precision + recall)
    };
    if balance_positive != expected_positive
        || balance_negative != expected_negative
        || !close(scalar["accuracy"], (tp + tn) as f64 / count as f64)
        || !close(scalar["precision"], precision)
        || !close(scalar["recall"], recall)
        || !close(scalar["f1"], f1)
        || !close(scalar["balancedAccuracy"], (recall + negative_recall) / 2.0)
    {
        return Err(fail(
            "training classification metrics are internally inconsistent",
        ));
    }

    let interval = value(
        metrics,
        "accuracyConfidenceInterval95",
        "model.trainingMetrics",
    )?;
    exact_keys(
        interval,
        &["lower", "upper", "method"],
        "model.trainingMetrics.accuracyConfidenceInterval95",
    )?;
    let lower = number(
        value(
            interval,
            "lower",
            "model.trainingMetrics.accuracyConfidenceInterval95",
        )?,
        "accuracyConfidenceInterval95.lower",
    )?;
    let upper = number(
        value(
            interval,
            "upper",
            "model.trainingMetrics.accuracyConfidenceInterval95",
        )?,
        "accuracyConfidenceInterval95.upper",
    )?;
    if lower < 0.0
        || upper > 1.0
        || lower > upper
        || value(
            interval,
            "method",
            "model.trainingMetrics.accuracyConfidenceInterval95",
        )?
        .as_str()
            != Some("wilson_score")
    {
        return Err(fail("training accuracy confidence interval is invalid"));
    }
    let z: f64 = 1.959963984540054;
    let accuracy = scalar["accuracy"];
    let denominator = 1.0 + z * z / count as f64;
    let center = (accuracy + z * z / (2.0 * count as f64)) / denominator;
    let margin = z
        * (accuracy * (1.0 - accuracy) / count as f64 + z * z / (4.0 * (count as f64).powi(2)))
            .sqrt()
        / denominator;
    if !close(lower, (center - margin).max(0.0)) || !close(upper, (center + margin).min(1.0)) {
        return Err(fail(
            "training accuracy confidence interval does not match accuracy and count",
        ));
    }

    let calibration = value(metrics, "calibration", "model.trainingMetrics")?
        .as_array()
        .ok_or_else(|| fail("model.trainingMetrics.calibration must contain 10 bins"))?;
    if calibration.len() != 10 {
        return Err(fail(
            "model.trainingMetrics.calibration must contain 10 bins",
        ));
    }
    let mut calibration_count = 0_u64;
    let mut positive_mass = 0.0;
    for (index, bin) in calibration.iter().enumerate() {
        let field = format!("model.trainingMetrics.calibration[{index}]");
        exact_keys(
            bin,
            &[
                "bin",
                "count",
                "meanPredictedProbability",
                "observedPositiveRate",
            ],
            &field,
        )?;
        let bin_index = integer(value(bin, "bin", &field)?, &format!("{field}.bin"))?;
        let bin_count = integer(value(bin, "count", &field)?, &format!("{field}.count"))?;
        let predicted = number(
            value(bin, "meanPredictedProbability", &field)?,
            &format!("{field}.meanPredictedProbability"),
        )?;
        let observed = number(
            value(bin, "observedPositiveRate", &field)?,
            &format!("{field}.observedPositiveRate"),
        )?;
        if bin_index != index as u64
            || !(0.0..=1.0).contains(&predicted)
            || !(0.0..=1.0).contains(&observed)
            || (bin_count == 0 && (predicted != 0.0 || observed != 0.0))
        {
            return Err(fail(format!("{field} is invalid")));
        }
        calibration_count += bin_count;
        positive_mass += bin_count as f64 * observed;
    }
    if calibration_count != count {
        return Err(fail(
            "training calibration bins do not account for all examples",
        ));
    }
    if !close(positive_mass, expected_positive as f64) {
        return Err(fail(
            "training calibration positive rates do not match class balance",
        ));
    }

    let model_hash = value(model, "modelSha256", "model")?.as_str().unwrap_or("");
    if !valid_digest(model_hash) {
        return Err(fail("modelSha256 is invalid"));
    }
    let mut body = model.clone();
    body.as_object_mut()
        .expect("validated object")
        .remove("modelSha256");
    if digest(&body)? != model_hash {
        return Err(fail("model hash mismatch"));
    }
    Ok(ValidatedDiscriminatorModel {
        model_sha256: model_hash.to_owned(),
        intercept,
        means: parsed.remove(0),
        scales: parsed.remove(0),
        weights: parsed.remove(0),
    })
}

fn valid_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(byte))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Validate exact feature keys and finite [0,1] values.
pub fn canonical_discriminator_features(
    input: &Value,
) -> Result<BTreeMap<String, f64>, DiscriminatorError> {
    exact_keys(input, &DISCRIMINATOR_FEATURES, "features")?;
    let mut features = BTreeMap::new();
    for name in DISCRIMINATOR_FEATURES {
        let n = number(value(input, name, "features")?, &format!("features.{name}"))?;
        if !(0.0..=1.0).contains(&n)
            || n == 0.0 && input[name].as_f64().is_some_and(f64::is_sign_negative)
        {
            return Err(fail(format!(
                "features.{name} must be a finite number in [0, 1]"
            )));
        }
        features.insert(name.to_owned(), n);
    }
    Ok(features)
}

/// Extract Phase 2 features with Node-compatible unknown-to-zero behavior.
pub fn extract_discriminator_features(
    state: &Value,
) -> Result<BTreeMap<String, f64>, DiscriminatorError> {
    let metrics = state.get("metrics").unwrap_or(&Value::Null);
    let semantics = state.get("semantics").unwrap_or(&Value::Null);
    let metric = |name: &str| -> Option<f64> {
        metrics
            .get(name)
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite())
    };
    let semantic = |name: &str| -> f64 {
        semantics
            .get(name)
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite())
            .unwrap_or(0.0)
    };
    let hypotheses = semantic("hypothesisCount");
    let tested = semantic("testedHypothesisCount");
    let support = semantic("supportEdgeCount");
    let path_length = state
        .get("pathNodeIds")
        .and_then(Value::as_array)
        .map_or(1.0, |path| (path.len().saturating_sub(1).max(1)) as f64);
    let clamp = |n: f64| n.clamp(0.0, 1.0);
    let mut features = BTreeMap::new();
    features.insert(
        "successConfidence".into(),
        metric("estimatedSuccessConfidence").map_or(0.0, clamp),
    );
    features.insert(
        "riskSafety".into(),
        metric("estimatedRisk").map_or(0.0, |risk| clamp(1.0 - risk)),
    );
    features.insert(
        "costEfficiency".into(),
        metric("estimatedCost").map_or(0.0, |cost| clamp(1.0 / (1.0 + cost.max(0.0)))),
    );
    features.insert(
        "reusePotential".into(),
        metric("reusePotential").map_or(0.0, clamp),
    );
    features.insert(
        "informationValue".into(),
        metric("informationValue").map_or(0.0, clamp),
    );
    features.insert(
        "testedHypothesisRatio".into(),
        clamp(tested / hypotheses.max(1.0)),
    );
    features.insert("supportEdgeRatio".into(), clamp(support / path_length));
    Ok(features)
}

/// Score canonical features using the Node standardized logistic formula.
pub fn score_discriminator(
    model: &ValidatedDiscriminatorModel,
    features: &Value,
) -> Result<DiscriminatorScore, DiscriminatorError> {
    let features = canonical_discriminator_features(features)?;
    let mut logit = model.intercept;
    for name in DISCRIMINATOR_FEATURES {
        logit += model.weights[name] * ((features[name] - model.means[name]) / model.scales[name]);
    }
    let probability = if logit >= 0.0 {
        1.0 / (1.0 + (-logit.min(709.0)).exp())
    } else {
        let exp = logit.max(-745.0).exp();
        exp / (1.0 + exp)
    };
    Ok(DiscriminatorScore {
        probability: probability.clamp(0.0, 1.0),
        features,
        model_sha256: model.model_sha256.clone(),
        classification: "model_estimate_unverified",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!(
            "../fixtures/discriminator-v2-node-golden.json"
        ))
        .expect("Node-generated golden fixture is valid JSON")
    }

    fn rehash_model(model: &mut Value) {
        let body = {
            let map = model.as_object_mut().expect("model object");
            map.remove("modelSha256");
            Value::Object(map.clone())
        };
        let hash = digest(&body).expect("canonical digest");
        model["modelSha256"] = Value::String(hash);
    }

    #[test]
    fn validates_node_model_and_matches_feature_and_score_golden() {
        let fixture = golden();
        let model = validate_discriminator_model(&fixture["model"]).unwrap();
        assert_eq!(
            model.model_sha256,
            "96f107604ebc75a39f6044c361114a4a1151f536b84e9aa632a0514dcfa0ea0c"
        );
        let features = extract_discriminator_features(&fixture["state"]).unwrap();
        for name in DISCRIMINATOR_FEATURES {
            let expected = fixture["features"][name].as_f64().unwrap();
            assert!((features[name] - expected).abs() <= 1e-15, "feature {name}");
        }
        let feature_value = serde_json::to_value(&features).unwrap();
        let score = score_discriminator(&model, &feature_value).unwrap();
        let expected_probability = fixture["score"]["probability"].as_f64().unwrap();
        assert!((score.probability - expected_probability).abs() <= 1e-14);
        assert_eq!(score.classification, "model_estimate_unverified");
        assert_eq!(score.model_sha256, model.model_sha256);
    }

    #[test]
    fn unknown_metrics_extract_as_zero_and_ratios_match_node() {
        let state = serde_json::json!({
            "metrics": {"estimatedCost": null, "estimatedRisk": null},
            "semantics": {"hypothesisCount": 0, "testedHypothesisCount": 2, "supportEdgeCount": 3},
            "pathNodeIds": ["start"]
        });
        let features = extract_discriminator_features(&state).unwrap();
        assert_eq!(features["successConfidence"], 0.0);
        assert_eq!(features["riskSafety"], 0.0);
        assert_eq!(features["costEfficiency"], 0.0);
        assert_eq!(features["testedHypothesisRatio"], 1.0);
        assert_eq!(features["supportEdgeRatio"], 1.0);
    }

    #[test]
    fn rejects_extra_keys_bad_hash_inconsistent_metrics_and_numeric_bounds() {
        let fixture = golden();
        let original = fixture["model"].clone();

        let mut extra = original.clone();
        extra["unexpected"] = Value::Bool(true);
        rehash_model(&mut extra);
        assert!(
            validate_discriminator_model(&extra)
                .unwrap_err()
                .to_string()
                .contains("unsupported fields")
        );

        let mut bad_hash = original.clone();
        bad_hash["modelSha256"] = Value::String("0".repeat(64));
        assert!(
            validate_discriminator_model(&bad_hash)
                .unwrap_err()
                .to_string()
                .contains("model hash mismatch")
        );

        let mut bad_metrics = original.clone();
        bad_metrics["trainingMetrics"]["accuracy"] = Value::from(0.99);
        rehash_model(&mut bad_metrics);
        assert!(
            validate_discriminator_model(&bad_metrics)
                .unwrap_err()
                .to_string()
                .contains("classification metrics are internally inconsistent")
        );

        let mut bad_scale = original.clone();
        bad_scale["scales"]["informationValue"] = Value::from(0.0);
        rehash_model(&mut bad_scale);
        assert!(
            validate_discriminator_model(&bad_scale)
                .unwrap_err()
                .to_string()
                .contains("must be in [1e-6, 1]")
        );

        let mut bad_weight = original.clone();
        bad_weight["weights"]["informationValue"] = Value::from(1_000_001.0);
        rehash_model(&mut bad_weight);
        assert!(
            validate_discriminator_model(&bad_weight)
                .unwrap_err()
                .to_string()
                .contains("exceeds the numeric safety bound")
        );

        let mut bad_training_bound = original.clone();
        bad_training_bound["trainingConfig"]["epochs"] = Value::from(100_001);
        rehash_model(&mut bad_training_bound);
        assert!(
            validate_discriminator_model(&bad_training_bound)
                .unwrap_err()
                .to_string()
                .contains("trainingConfig is invalid")
        );

        let mut bad_calibration = original;
        bad_calibration["trainingMetrics"]["calibration"][0]["count"] = Value::from(999_u64);
        rehash_model(&mut bad_calibration);
        assert!(
            validate_discriminator_model(&bad_calibration)
                .unwrap_err()
                .to_string()
                .contains("calibration bins do not account")
        );
    }

    #[test]
    fn feature_contract_rejects_extra_keys_and_out_of_range_values() {
        let fixture = golden();
        let mut extra = fixture["features"].clone();
        extra["extra"] = Value::from(0.5);
        assert!(
            canonical_discriminator_features(&extra)
                .unwrap_err()
                .to_string()
                .contains("unsupported fields")
        );
        let mut out_of_range = fixture["features"].clone();
        out_of_range["riskSafety"] = Value::from(1.1);
        assert!(
            canonical_discriminator_features(&out_of_range)
                .unwrap_err()
                .to_string()
                .contains("[0, 1]")
        );
    }
}

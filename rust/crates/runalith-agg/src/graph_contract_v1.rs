//! Strict AGG graph schema v1 validation and cross-language graph identity.
//!
//! This boundary mirrors validateAdaptiveGoalGraph in the Node reference.
//! It preserves metric provenance and conditional recovery contracts while
//! exposing a compatibility projection for the existing bounded Rust search.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{AggEdge, AggEdgeKind, AggError, AggGraph, AggNode, AggNodeKind};

const MAX_NODES: usize = 500;
const MAX_EDGES: usize = 2_000;
const MAX_REFERENCES_PER_NODE: usize = 64;
const METRICS: [&str; 5] = [
    "estimatedCost",
    "estimatedRisk",
    "estimatedSuccessConfidence",
    "reusePotential",
    "informationValue",
];
const NODE_TYPES: [&str; 9] = [
    "goal",
    "idea",
    "hypothesis",
    "candidate",
    "experiment",
    "capability",
    "evidence",
    "condition",
    "task",
];
const EDGE_TYPES: [&str; 9] = [
    "next_step",
    "requires_all",
    "depends_on",
    "supports",
    "alternative_to",
    "enables",
    "tested_by",
    "contradicts",
    "recovers_to",
];
const RECOVERY_OUTCOMES: [&str; 5] = [
    "failed",
    "blocked",
    "verification_failed",
    "evidence_missing",
    "contradicted",
];

/// Normalized provenance classification for one metric.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricClassification {
    /// Caller-supplied estimate; no source or calibration has been verified.
    CallerEstimateUnverified,
    /// No metric value is known.
    Unknown,
}

/// Canonical provenance attached to one node metric.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricProvenance {
    /// Whether the metric has an explicit caller-supplied value.
    pub classification: MetricClassification,
    /// Caller-declared estimation method, if any.
    pub method: Option<String>,
    /// Sorted declared source references; all remain unverified.
    pub source_refs: Vec<String>,
    /// Caller-declared confidence, not an independently verified probability.
    pub confidence: Option<f64>,
    /// Always false until an external verifier establishes provenance.
    pub provenance_verified: bool,
}

/// Fixed-order metric provenance object used for cross-language hashing.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MetricProvenanceSet {
    /// Estimated cost provenance.
    #[serde(rename = "estimatedCost")]
    pub estimated_cost: MetricProvenance,
    /// Estimated risk provenance.
    #[serde(rename = "estimatedRisk")]
    pub estimated_risk: MetricProvenance,
    /// Estimated success confidence provenance.
    #[serde(rename = "estimatedSuccessConfidence")]
    pub estimated_success_confidence: MetricProvenance,
    /// Reuse potential provenance.
    #[serde(rename = "reusePotential")]
    pub reuse_potential: MetricProvenance,
    /// Information value provenance.
    #[serde(rename = "informationValue")]
    pub information_value: MetricProvenance,
}

/// Conditional recovery contract carried only by recovers_to edges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCondition {
    /// Explicit observed outcome that activates this edge.
    pub on_outcome: String,
    /// Evidence nodes required by the recovery route.
    pub requires_evidence_node_ids: Vec<String>,
    /// Additional prerequisites required by the recovery route.
    pub requires_all_node_ids: Vec<String>,
}

/// Canonical node representation with Node-compatible field order.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CanonicalNode {
    /// Stable slug identity.
    pub id: String,
    /// Semantic node type.
    #[serde(rename = "type")]
    pub node_type: String,
    /// Optional display label; omitted when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Estimated cost; null means unknown.
    #[serde(rename = "estimatedCost")]
    pub estimated_cost: Option<f64>,
    /// Estimated risk; null means unknown.
    #[serde(rename = "estimatedRisk")]
    pub estimated_risk: Option<f64>,
    /// Estimated success confidence; null means unknown.
    #[serde(rename = "estimatedSuccessConfidence")]
    pub estimated_success_confidence: Option<f64>,
    /// Reuse potential; null means unknown.
    #[serde(rename = "reusePotential")]
    pub reuse_potential: Option<f64>,
    /// Information value; null means unknown.
    #[serde(rename = "informationValue")]
    pub information_value: Option<f64>,
    /// Full five-metric provenance object.
    #[serde(rename = "metricProvenance")]
    pub metric_provenance: MetricProvenanceSet,
    /// Sorted declared evidence references.
    #[serde(rename = "evidenceRefs")]
    pub evidence_refs: Vec<String>,
}

/// Canonical edge representation with Node-compatible field order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CanonicalEdge {
    /// Source node.
    pub from: String,
    /// Target node.
    pub to: String,
    /// Relationship type.
    #[serde(rename = "type")]
    pub edge_type: String,
    /// Required only for recovers_to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<RecoveryCondition>,
}

/// Canonical graph object. Its compact JSON bytes define graph identity.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CanonicalGraph {
    /// Graph schema version.
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    /// Start node.
    #[serde(rename = "startNodeId")]
    pub start_node_id: String,
    /// Goal node.
    #[serde(rename = "goalNodeId")]
    pub goal_node_id: String,
    /// Nodes sorted by stable ID.
    pub nodes: Vec<CanonicalNode>,
    /// Edges sorted by source, target and type.
    pub edges: Vec<CanonicalEdge>,
}

/// Fully validated, canonical graph and its Node-compatible identity.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedGraph {
    /// Canonical graph fields and normalized provenance.
    pub graph: CanonicalGraph,
    /// SHA-256 of compact ordered JSON serialization of graph.
    pub graph_hash: String,
}

impl ValidatedGraph {
    /// Return compact canonical JSON bytes used by the graph hash.
    pub fn canonical_json(&self) -> Result<String, AggError> {
        canonical_graph_json(&self.graph)
    }

    /// Project validated graph semantics into the existing bounded search API.
    ///
    /// The caller should retain this ValidatedGraph alongside the projection:
    /// metric provenance and conditional recovery contracts are not discarded
    /// from this validated object, but the legacy search projection does not
    /// yet emit the complete Node audit/provenance result.
    pub fn search_graph(&self) -> Result<AggGraph, AggError> {
        let nodes = self
            .graph
            .nodes
            .iter()
            .map(|node| {
                Ok(AggNode {
                    id: node.id.clone(),
                    kind: node_kind(&node.node_type)?,
                    label: node.label.clone(),
                    estimated_cost: node.estimated_cost,
                    estimated_risk: node.estimated_risk,
                    estimated_success_confidence: node.estimated_success_confidence,
                    reuse_potential: node.reuse_potential,
                    information_value: node.information_value,
                    evidence_refs: node.evidence_refs.clone(),
                })
            })
            .collect::<Result<Vec<_>, AggError>>()?;
        let edges = self
            .graph
            .edges
            .iter()
            .map(|edge| {
                Ok(AggEdge {
                    from: edge.from.clone(),
                    to: edge.to.clone(),
                    kind: edge_kind(&edge.edge_type)?,
                })
            })
            .collect::<Result<Vec<_>, AggError>>()?;
        let graph = AggGraph {
            graph_hash: self.graph_hash.clone(),
            start_node_id: self.graph.start_node_id.clone(),
            goal_node_id: self.graph.goal_node_id.clone(),
            nodes,
            edges,
        };
        graph.validate()?;
        Ok(graph)
    }
}

/// Parse original JSON bytes, validate the complete schema v1 contract, sort
/// canonical arrays and compute the exact Node graph identity.
pub fn validate_graph_json(bytes: &[u8]) -> Result<ValidatedGraph, AggError> {
    let input = runalith_protocol::agg_checkpoint_v2::parse_json_with_negative_zero(bytes, true)
        .map_err(|error| AggError::Invalid(error.to_string()))?;
    validate_graph_value(&input)
}

/// Validate a materialized JSON value and compute Node-compatible identity.
/// External raw bytes should use validate_graph_json to retain duplicate-key
/// and numeric-token checks.
pub fn validate_graph_value(input: &Value) -> Result<ValidatedGraph, AggError> {
    let root = object(input, "input")?;
    exact_keys(
        root,
        &[
            "schemaVersion",
            "startNodeId",
            "goalNodeId",
            "nodes",
            "edges",
            "graphHash",
        ],
        "input",
    )?;
    if number(root.get("schemaVersion"), "schemaVersion")? != 1.0 {
        return Err(invalid("schemaVersion must equal 1"));
    }
    let start_node_id = identifier(root.get("startNodeId"), "startNodeId")?;
    let goal_node_id = identifier(root.get("goalNodeId"), "goalNodeId")?;
    if start_node_id == goal_node_id {
        return Err(invalid(
            "startNodeId and goalNodeId must identify distinct nodes",
        ));
    }
    let input_nodes = array(root.get("nodes"), "nodes")?;
    if input_nodes.is_empty() || input_nodes.len() > MAX_NODES {
        return Err(invalid(format!("nodes must contain 1-{MAX_NODES} entries")));
    }
    let input_edges = array(root.get("edges"), "edges")?;
    if input_edges.len() > MAX_EDGES {
        return Err(invalid(format!("edges must contain 0-{MAX_EDGES} entries")));
    }

    let mut nodes = input_nodes
        .iter()
        .enumerate()
        .map(|(index, value)| canonical_node(value, index))
        .collect::<Result<Vec<_>, _>>()?;
    nodes.sort_by(|left, right| compare_strings(&left.id, &right.id));
    let mut node_by_id = BTreeMap::new();
    for node in &nodes {
        if node_by_id.insert(node.id.as_str(), node).is_some() {
            return Err(invalid(format!("node IDs must be unique: {}", node.id)));
        }
    }
    if !node_by_id.contains_key(start_node_id.as_str()) {
        return Err(invalid(format!("startNodeId is unknown: {start_node_id}")));
    }
    if node_by_id
        .get(goal_node_id.as_str())
        .is_none_or(|node| node.node_type != "goal")
    {
        return Err(invalid(format!(
            "goalNodeId must identify a node with type goal: {goal_node_id}"
        )));
    }

    let mut edges = input_edges
        .iter()
        .enumerate()
        .map(|(index, value)| canonical_edge(value, index))
        .collect::<Result<Vec<_>, _>>()?;
    edges.sort_by(|left, right| {
        compare_strings(&left.from, &right.from)
            .then_with(|| compare_strings(&left.to, &right.to))
            .then_with(|| compare_strings(&left.edge_type, &right.edge_type))
    });
    let mut edge_keys = BTreeSet::new();
    for edge in &edges {
        if !node_by_id.contains_key(edge.from.as_str()) {
            return Err(invalid(format!(
                "edge.from references an unknown node: {}",
                edge.from
            )));
        }
        if !node_by_id.contains_key(edge.to.as_str()) {
            return Err(invalid(format!(
                "edge.to references an unknown node: {}",
                edge.to
            )));
        }
        if !edge_keys.insert((
            edge.from.as_str(),
            edge.edge_type.as_str(),
            edge.to.as_str(),
        )) {
            return Err(invalid(format!(
                "duplicate edge: {} {} {}",
                edge.from, edge.edge_type, edge.to
            )));
        }
        if let Some(condition) = &edge.condition {
            for id in &condition.requires_evidence_node_ids {
                let Some(node) = node_by_id.get(id.as_str()) else {
                    return Err(invalid(format!(
                        "recovery condition references an unknown evidence node: {id}"
                    )));
                };
                if node.node_type != "evidence" {
                    return Err(invalid(format!(
                        "recovery condition node must have type evidence: {id}"
                    )));
                }
                if node.evidence_refs.is_empty() {
                    return Err(invalid(format!(
                        "recovery condition evidence node requires at least one source reference: {id}"
                    )));
                }
            }
            for id in &condition.requires_all_node_ids {
                if !node_by_id.contains_key(id.as_str()) {
                    return Err(invalid(format!(
                        "recovery condition references an unknown prerequisite node: {id}"
                    )));
                }
            }
        }
    }

    let graph = CanonicalGraph {
        schema_version: 1,
        start_node_id,
        goal_node_id,
        nodes,
        edges,
    };
    let canonical_json = canonical_graph_json(&graph)?;
    let graph_hash = hex::encode(Sha256::digest(canonical_json.as_bytes()));
    let validated = ValidatedGraph { graph, graph_hash };
    // The search projection reuses the established cycle/edge semantics.
    validated.search_graph()?;
    Ok(validated)
}

fn canonical_node(input: &Value, index: usize) -> Result<CanonicalNode, AggError> {
    let field = format!("nodes[{index}]");
    let input = object(input, &field)?;
    exact_keys(
        input,
        &[
            "id",
            "type",
            "label",
            "estimatedCost",
            "estimatedRisk",
            "estimatedSuccessConfidence",
            "reusePotential",
            "informationValue",
            "metricProvenance",
            "evidenceRefs",
        ],
        &field,
    )?;
    let id = identifier(input.get("id"), &format!("{field}.id"))?;
    let node_type = string(input.get("type"), &format!("{field}.type"))?;
    if !NODE_TYPES.contains(&node_type.as_str()) {
        return Err(invalid(format!("{field}.type is unsupported")));
    }
    let label = match input.get("label") {
        None => None,
        Some(Value::String(value)) => {
            if value.trim().encode_utf16().count() > 500 {
                return Err(invalid(format!(
                    "{field}.label must be a string up to 500 characters"
                )));
            }
            Some(value.trim().to_owned())
        }
        Some(_) => {
            return Err(invalid(format!(
                "{field}.label must be a string up to 500 characters"
            )));
        }
    };
    let estimated_cost = nullable_number(
        input.get("estimatedCost"),
        &format!("{field}.estimatedCost"),
        0.0,
        1e9,
    )?;
    let estimated_risk = nullable_number(
        input.get("estimatedRisk"),
        &format!("{field}.estimatedRisk"),
        0.0,
        1.0,
    )?;
    let estimated_success_confidence = nullable_number(
        input.get("estimatedSuccessConfidence"),
        &format!("{field}.estimatedSuccessConfidence"),
        0.0,
        1.0,
    )?;
    let reuse_potential = nullable_number(
        input.get("reusePotential"),
        &format!("{field}.reusePotential"),
        0.0,
        1.0,
    )?;
    let information_value = nullable_number(
        input.get("informationValue"),
        &format!("{field}.informationValue"),
        0.0,
        1.0,
    )?;
    let metric_values = [
        estimated_cost,
        estimated_risk,
        estimated_success_confidence,
        reuse_potential,
        information_value,
    ];
    let provenance_input = match input.get("metricProvenance") {
        None => None,
        Some(value) => Some(object(value, &format!("{field}.metricProvenance"))?),
    };
    if let Some(metadata) = provenance_input {
        exact_keys(metadata, &METRICS, &format!("{field}.metricProvenance"))?;
    }
    let mut provenance = Vec::with_capacity(METRICS.len());
    for (metric, supplied_value) in METRICS.iter().zip(metric_values) {
        let explicit_value = supplied_value.is_some();
        let metadata = provenance_input.and_then(|value| value.get(*metric));
        let (method, source_refs, confidence) = if let Some(metadata) = metadata {
            let metadata = object(metadata, &format!("{field}.metricProvenance.{metric}"))?;
            exact_keys(
                metadata,
                &["method", "sourceRefs", "confidence"],
                &format!("{field}.metricProvenance.{metric}"),
            )?;
            let method = match metadata.get("method") {
                None => None,
                Some(Value::String(value)) => {
                    if value.trim().encode_utf16().count() > 240 {
                        return Err(invalid(format!(
                            "{field}.metricProvenance.{metric}.method must be a string up to 240 characters"
                        )));
                    }
                    let value = value.trim();
                    if value.is_empty() {
                        None
                    } else {
                        Some(value.to_owned())
                    }
                }
                Some(_) => {
                    return Err(invalid(format!(
                        "{field}.metricProvenance.{metric}.method must be a string up to 240 characters"
                    )));
                }
            };
            let source_refs = match metadata.get("sourceRefs") {
                None => Vec::new(),
                Some(value) => reference_list(
                    Some(value),
                    &format!("{field}.metricProvenance.{metric}.sourceRefs"),
                    16,
                )?,
            };
            let confidence = nullable_number(
                metadata.get("confidence"),
                &format!("{field}.metricProvenance.{metric}.confidence"),
                0.0,
                1.0,
            )?;
            (method, source_refs, confidence)
        } else {
            (None, Vec::new(), None)
        };
        provenance.push(MetricProvenance {
            classification: if explicit_value {
                MetricClassification::CallerEstimateUnverified
            } else {
                MetricClassification::Unknown
            },
            method: method.or_else(|| {
                if explicit_value {
                    Some("unspecified caller estimate".into())
                } else {
                    None
                }
            }),
            source_refs,
            confidence,
            provenance_verified: false,
        });
    }
    let evidence_refs = reference_list(
        input.get("evidenceRefs"),
        &format!("{field}.evidenceRefs"),
        MAX_REFERENCES_PER_NODE,
    )?;
    let mut provenance = provenance.into_iter();
    let metric_provenance = MetricProvenanceSet {
        estimated_cost: provenance.next().expect("five metric keys"),
        estimated_risk: provenance.next().expect("five metric keys"),
        estimated_success_confidence: provenance.next().expect("five metric keys"),
        reuse_potential: provenance.next().expect("five metric keys"),
        information_value: provenance.next().expect("five metric keys"),
    };
    Ok(CanonicalNode {
        id,
        node_type,
        label,
        estimated_cost,
        estimated_risk,
        estimated_success_confidence,
        reuse_potential,
        information_value,
        metric_provenance,
        evidence_refs,
    })
}

fn canonical_edge(input: &Value, index: usize) -> Result<CanonicalEdge, AggError> {
    let field = format!("edges[{index}]");
    let input = object(input, &field)?;
    exact_keys(input, &["from", "to", "type", "condition"], &field)?;
    let from = identifier(input.get("from"), &format!("{field}.from"))?;
    let to = identifier(input.get("to"), &format!("{field}.to"))?;
    if from == to {
        return Err(invalid(format!(
            "{field} must not connect a node to itself"
        )));
    }
    let edge_type = string(input.get("type"), &format!("{field}.type"))?;
    if !EDGE_TYPES.contains(&edge_type.as_str()) {
        return Err(invalid(format!("{field}.type is unsupported")));
    }
    let condition = match (edge_type.as_str(), input.get("condition")) {
        ("recovers_to", Some(value)) => Some(canonical_recovery_condition(value, &field)?),
        ("recovers_to", None) => {
            return Err(invalid(format!(
                "{field}.condition is required for recovers_to"
            )));
        }
        (_, Some(_)) => {
            return Err(invalid(format!(
                "{field}.condition is only valid for recovers_to"
            )));
        }
        (_, None) => None,
    };
    Ok(CanonicalEdge {
        from,
        to,
        edge_type,
        condition,
    })
}

fn canonical_recovery_condition(
    input: &Value,
    edge_field: &str,
) -> Result<RecoveryCondition, AggError> {
    let field = format!("{edge_field}.condition");
    let input = object(input, &field)?;
    exact_keys(
        input,
        &["onOutcome", "requiresEvidenceNodeIds", "requiresAllNodeIds"],
        &field,
    )?;
    let on_outcome = string(input.get("onOutcome"), &format!("{field}.onOutcome"))?;
    if !RECOVERY_OUTCOMES.contains(&on_outcome.as_str()) {
        return Err(invalid(format!("{field}.onOutcome is unsupported")));
    }
    Ok(RecoveryCondition {
        on_outcome,
        requires_evidence_node_ids: reference_list(
            input.get("requiresEvidenceNodeIds"),
            &format!("{field}.requiresEvidenceNodeIds"),
            MAX_NODES,
        )?,
        requires_all_node_ids: reference_list(
            input.get("requiresAllNodeIds"),
            &format!("{field}.requiresAllNodeIds"),
            MAX_NODES,
        )?,
    })
}

fn reference_list(
    value: Option<&Value>,
    field: &str,
    maximum: usize,
) -> Result<Vec<String>, AggError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = array(Some(value), field)?;
    if values.len() > maximum {
        return Err(invalid(format!(
            "{field} must be an array with at most {maximum} entries"
        )));
    }
    let mut refs = Vec::with_capacity(values.len());
    for (index, item) in values.iter().enumerate() {
        let value = string(Some(item), &format!("{field}[{index}]"))?;
        let value = value.trim();
        if value.is_empty() || value.encode_utf16().count() > 512 {
            return Err(invalid(format!(
                "{field}[{index}] must be a non-empty string up to 512 characters"
            )));
        }
        refs.push(value.to_owned());
    }
    refs.sort_by(|left, right| compare_strings(left, right));
    if refs.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(invalid(format!(
            "{field} must not contain duplicate references"
        )));
    }
    Ok(refs)
}

fn nullable_number(
    value: Option<&Value>,
    field: &str,
    minimum: f64,
    maximum: f64,
) -> Result<Option<f64>, AggError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => {
            let number = value
                .as_f64()
                .ok_or_else(|| invalid(format!("{field} must be a finite number")))?;
            if !number.is_finite() || number < minimum || number > maximum {
                return Err(invalid(format!(
                    "{field} must be a finite number between {minimum} and {maximum}"
                )));
            }
            Ok(Some(number))
        }
        Some(_) => Err(invalid(format!(
            "{field} must be a finite number between {minimum} and {maximum}"
        ))),
    }
}

fn identifier(value: Option<&Value>, field: &str) -> Result<String, AggError> {
    let value = string(value, field)?;
    if !valid_slug(&value) {
        return Err(invalid(format!(
            "{field} must be a lowercase slug identifier"
        )));
    }
    Ok(value)
}

fn valid_slug(value: &str) -> bool {
    let mut previous_separator = false;
    for (index, byte) in value.bytes().enumerate() {
        if byte.is_ascii_lowercase() || (index > 0 && byte.is_ascii_digit()) {
            previous_separator = false;
        } else if byte == b'-' && index > 0 && !previous_separator {
            previous_separator = true;
        } else {
            return false;
        }
    }
    !value.is_empty() && !previous_separator
}

fn string(value: Option<&Value>, field: &str) -> Result<String, AggError> {
    value
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("{field} must be a string")))
}

fn number(value: Option<&Value>, field: &str) -> Result<f64, AggError> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| invalid(format!("{field} must be a finite number")))
}

fn array<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a Vec<Value>, AggError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(format!("{field} must be an array")))
}

fn object<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>, AggError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("{field} must be an object")))
}

fn exact_keys(value: &Map<String, Value>, allowed: &[&str], field: &str) -> Result<(), AggError> {
    let unsupported: Vec<&str> = value
        .keys()
        .map(String::as_str)
        .filter(|key| !allowed.contains(key))
        .collect();
    if !unsupported.is_empty() {
        return Err(invalid(format!(
            "{field} contains unsupported fields: {}",
            unsupported.join(", ")
        )));
    }
    Ok(())
}

fn compare_strings(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn node_kind(value: &str) -> Result<AggNodeKind, AggError> {
    match value {
        "goal" => Ok(AggNodeKind::Goal),
        "idea" => Ok(AggNodeKind::Idea),
        "hypothesis" => Ok(AggNodeKind::Hypothesis),
        "candidate" => Ok(AggNodeKind::Candidate),
        "experiment" => Ok(AggNodeKind::Experiment),
        "capability" => Ok(AggNodeKind::Capability),
        "evidence" => Ok(AggNodeKind::Evidence),
        "condition" => Ok(AggNodeKind::Condition),
        "task" => Ok(AggNodeKind::Task),
        _ => Err(invalid(format!("unsupported node type: {value}"))),
    }
}

fn edge_kind(value: &str) -> Result<AggEdgeKind, AggError> {
    match value {
        "next_step" => Ok(AggEdgeKind::NextStep),
        "requires_all" => Ok(AggEdgeKind::RequiresAll),
        "depends_on" => Ok(AggEdgeKind::DependsOn),
        "supports" => Ok(AggEdgeKind::Supports),
        "alternative_to" => Ok(AggEdgeKind::AlternativeTo),
        "enables" => Ok(AggEdgeKind::Enables),
        "tested_by" => Ok(AggEdgeKind::TestedBy),
        "contradicts" => Ok(AggEdgeKind::Contradicts),
        "recovers_to" => Ok(AggEdgeKind::RecoversTo),
        _ => Err(invalid(format!("unsupported edge type: {value}"))),
    }
}

fn canonical_graph_json(graph: &CanonicalGraph) -> Result<String, AggError> {
    fn quoted(output: &mut String, value: &str) -> Result<(), AggError> {
        output.push_str(&serde_json::to_string(value).map_err(|error| {
            invalid(format!(
                "canonical graph string serialization failed: {error}"
            ))
        })?);
        Ok(())
    }

    fn optional_number(output: &mut String, value: Option<f64>) {
        match value {
            Some(value) => output.push_str(
                &runalith_protocol::agg_checkpoint_v2::ecmascript_number_to_string(value),
            ),
            None => output.push_str("null"),
        }
    }

    fn string_array(output: &mut String, values: &[String]) -> Result<(), AggError> {
        output.push('[');
        for (index, value) in values.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }
            quoted(output, value)?;
        }
        output.push(']');
        Ok(())
    }

    fn metric(output: &mut String, value: &MetricProvenance) -> Result<(), AggError> {
        output.push('{');
        output.push_str("\"classification\":");
        quoted(
            output,
            match value.classification {
                MetricClassification::CallerEstimateUnverified => "caller_estimate_unverified",
                MetricClassification::Unknown => "unknown",
            },
        )?;
        output.push_str(",\"method\":");
        match &value.method {
            Some(method) => quoted(output, method)?,
            None => output.push_str("null"),
        }
        output.push_str(",\"sourceRefs\":");
        string_array(output, &value.source_refs)?;
        output.push_str(",\"confidence\":");
        optional_number(output, value.confidence);
        output.push_str(",\"provenanceVerified\":false}");
        Ok(())
    }

    fn metric_set(output: &mut String, value: &MetricProvenanceSet) -> Result<(), AggError> {
        output.push('{');
        for (index, (key, provenance)) in [
            ("estimatedCost", &value.estimated_cost),
            ("estimatedRisk", &value.estimated_risk),
            (
                "estimatedSuccessConfidence",
                &value.estimated_success_confidence,
            ),
            ("reusePotential", &value.reuse_potential),
            ("informationValue", &value.information_value),
        ]
        .into_iter()
        .enumerate()
        {
            if index > 0 {
                output.push(',');
            }
            quoted(output, key)?;
            output.push(':');
            metric(output, provenance)?;
        }
        output.push('}');
        Ok(())
    }

    fn node(output: &mut String, value: &CanonicalNode) -> Result<(), AggError> {
        output.push('{');
        output.push_str("\"id\":");
        quoted(output, &value.id)?;
        output.push_str(",\"type\":");
        quoted(output, &value.node_type)?;
        if let Some(label) = &value.label {
            output.push_str(",\"label\":");
            quoted(output, label)?;
        }
        output.push_str(",\"estimatedCost\":");
        optional_number(output, value.estimated_cost);
        output.push_str(",\"estimatedRisk\":");
        optional_number(output, value.estimated_risk);
        output.push_str(",\"estimatedSuccessConfidence\":");
        optional_number(output, value.estimated_success_confidence);
        output.push_str(",\"reusePotential\":");
        optional_number(output, value.reuse_potential);
        output.push_str(",\"informationValue\":");
        optional_number(output, value.information_value);
        output.push_str(",\"metricProvenance\":");
        metric_set(output, &value.metric_provenance)?;
        output.push_str(",\"evidenceRefs\":");
        string_array(output, &value.evidence_refs)?;
        output.push('}');
        Ok(())
    }

    fn edge(output: &mut String, value: &CanonicalEdge) -> Result<(), AggError> {
        output.push('{');
        output.push_str("\"from\":");
        quoted(output, &value.from)?;
        output.push_str(",\"to\":");
        quoted(output, &value.to)?;
        output.push_str(",\"type\":");
        quoted(output, &value.edge_type)?;
        if let Some(condition) = &value.condition {
            output.push_str(",\"condition\":{\"onOutcome\":");
            quoted(output, &condition.on_outcome)?;
            output.push_str(",\"requiresEvidenceNodeIds\":");
            string_array(output, &condition.requires_evidence_node_ids)?;
            output.push_str(",\"requiresAllNodeIds\":");
            string_array(output, &condition.requires_all_node_ids)?;
            output.push('}');
        }
        output.push('}');
        Ok(())
    }

    let mut output = String::new();
    output.push_str("{\"schemaVersion\":1,\"startNodeId\":");
    quoted(&mut output, &graph.start_node_id)?;
    output.push_str(",\"goalNodeId\":");
    quoted(&mut output, &graph.goal_node_id)?;
    output.push_str(",\"nodes\":[");
    for (index, value) in graph.nodes.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        node(&mut output, value)?;
    }
    output.push_str("],\"edges\":[");
    for (index, value) in graph.edges.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        edge(&mut output, value)?;
    }
    output.push_str("]}");
    Ok(output)
}

fn invalid(message: impl Into<String>) -> AggError {
    AggError::Invalid(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NODE_GRAPH: &str = r#"{
      "schemaVersion":1,
      "startNodeId":"start",
      "goalNodeId":"goal",
      "nodes":[
        {"id":"goal","type":"goal"},
        {"id":"start","type":"capability"},
        {"id":"step","type":"hypothesis","label":"  Hypothesis  ",
         "estimatedCost":333333333.33333329,"estimatedRisk":0.2,
         "metricProvenance":{"estimatedCost":{"method":"manual","sourceRefs":["z","a"],"confidence":0.7}},
         "evidenceRefs":["artifact://z","artifact://a"]}
      ],
      "edges":[
        {"from":"start","to":"step","type":"next_step"},
        {"from":"step","to":"goal","type":"next_step"}
      ]
    }"#;

    #[test]
    fn graph_hash_and_canonical_json_match_node_reference() {
        let graph = validate_graph_json(NODE_GRAPH.as_bytes()).unwrap();
        assert_eq!(
            graph.graph_hash,
            "f3855e23d5409253b3589ee210790b5a65e583cb0e9f372a857f37d3ba5bcfa8"
        );
        assert_eq!(
            graph.graph.nodes[2]
                .metric_provenance
                .estimated_cost
                .classification,
            MetricClassification::CallerEstimateUnverified
        );
        assert_eq!(
            graph.graph.nodes[2]
                .metric_provenance
                .estimated_risk
                .method
                .as_deref(),
            Some("unspecified caller estimate")
        );
        let search_graph = graph.search_graph().unwrap();
        assert_eq!(search_graph.graph_hash, graph.graph_hash);
        assert_eq!(search_graph.nodes[2].kind, AggNodeKind::Hypothesis);
    }

    #[test]
    fn checked_in_node_generated_fixture_matches_exact_canonical_bytes_and_hash() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/adaptive-goal-graph-v1-canonical.json"
        ))
        .unwrap();
        let input_json = fixture["input_json"].as_str().unwrap();
        let graph = validate_graph_json(input_json.as_bytes()).unwrap();
        assert_eq!(
            graph.canonical_json().unwrap(),
            fixture["canonical_json"].as_str().unwrap()
        );
        assert_eq!(graph.graph_hash, fixture["graph_hash"].as_str().unwrap());
        assert_eq!(graph.graph.nodes[3].estimated_risk, Some(0.0));
        assert_eq!(
            graph.graph.edges[0]
                .condition
                .as_ref()
                .unwrap()
                .requires_evidence_node_ids,
            vec!["evidence"]
        );
    }

    #[test]
    fn canonical_identity_is_independent_of_node_edge_and_reference_input_order() {
        let first = validate_graph_json(NODE_GRAPH.as_bytes()).unwrap();
        let reordered = NODE_GRAPH
            .replace(
                "\"artifact://z\",\"artifact://a\"",
                "\"artifact://a\",\"artifact://z\"",
            )
            .replace(
                "\"sourceRefs\":[\"z\",\"a\"]",
                "\"sourceRefs\":[\"a\",\"z\"]",
            );
        assert_eq!(
            first.graph_hash,
            validate_graph_json(reordered.as_bytes())
                .unwrap()
                .graph_hash
        );
    }

    #[test]
    fn recovery_edges_require_typed_outcome_and_resolvable_evidence_nodes() {
        let base = r#"{
          "schemaVersion":1,"startNodeId":"start","goalNodeId":"goal",
          "nodes":[
            {"id":"start","type":"task"},
            {"id":"evidence","type":"evidence","evidenceRefs":["artifact://proof"]},
            {"id":"goal","type":"goal"}
          ],
          "edges":[
            {"from":"start","to":"goal","type":"recovers_to",
             "condition":{"onOutcome":"failed","requiresEvidenceNodeIds":["evidence"],"requiresAllNodeIds":[]}}
          ]
        }"#;
        let graph = validate_graph_json(base.as_bytes()).unwrap();
        assert_eq!(
            graph.graph.edges[0].condition.as_ref().unwrap().on_outcome,
            "failed"
        );
        let mut missing_condition: Value = serde_json::from_str(base).unwrap();
        missing_condition["edges"][0]
            .as_object_mut()
            .unwrap()
            .remove("condition");
        assert!(validate_graph_value(&missing_condition).is_err());
        let mut wrong_evidence: Value = serde_json::from_str(base).unwrap();
        wrong_evidence["nodes"][1]["type"] = Value::String("task".into());
        assert!(validate_graph_value(&wrong_evidence).is_err());
        let invalid_outcome = base.replace("\"onOutcome\":\"failed\"", "\"onOutcome\":\"success\"");
        assert!(validate_graph_json(invalid_outcome.as_bytes()).is_err());
    }

    #[test]
    fn strict_boundary_rejects_duplicate_keys_unknown_fields_and_bad_metrics() {
        assert!(validate_graph_json(
            br#"{"schemaVersion":1,"schemaVersion":1,"startNodeId":"start","goalNodeId":"goal","nodes":[],"edges":[]}"#
        )
        .is_err());
        let unknown = NODE_GRAPH.replace("\"type\":\"goal\"", "\"type\":\"goal\",\"admin\":true");
        assert!(validate_graph_json(unknown.as_bytes()).is_err());
        let bad_metric = NODE_GRAPH.replace("333333333.33333329", "-1");
        assert!(validate_graph_json(bad_metric.as_bytes()).is_err());
    }

    #[test]
    fn graph_profile_normalizes_negative_zero_like_node_json_stringify() {
        let input = NODE_GRAPH.replace("333333333.33333329", "-0");
        let graph = validate_graph_json(input.as_bytes()).unwrap();
        assert_eq!(graph.graph.nodes[2].estimated_cost, Some(0.0));
        assert!(
            graph
                .canonical_json()
                .unwrap()
                .contains("\"estimatedCost\":0")
        );
    }
}

//! Bounded differential for the host-conversation DAG portion of Node's
//! built-in `compileWorkflowPlan` output.
//!
//! This does not claim full immutable execution-plan parity. Node additionally
//! compiles phases, job identity, success/policy contracts, batch routing,
//! validation profiles, scoped workspace writes, action intents, synthesis
//! and deterministic local execution metadata. The Rust projection checked
//! here covers only the shared built-in host-role DAG and role contracts.

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::{Value, json};

    use crate::workflow::{
        ArtifactType, CustomWorkflowDefinition, WorkflowTaskDefinition, builtin_role,
        builtin_roles, compile_workflow,
    };

    #[derive(Debug, Deserialize)]
    struct NodeBuiltinWorkflowOracle {
        schema_version: u32,
        generated_by_node: bool,
        source: String,
        scope: String,
        role_contracts: Vec<Value>,
        cases: Vec<NodeBuiltinWorkflowCase>,
    }

    #[derive(Debug, Deserialize)]
    struct NodeBuiltinWorkflowCase {
        name: String,
        workflow_id: String,
        workflow_version: u32,
        input_contract: Vec<ArtifactType>,
        tasks: Vec<NodeBuiltinTask>,
    }

    #[derive(Debug, Deserialize)]
    struct NodeBuiltinTask {
        task_id: String,
        role_id: String,
        role_version: u32,
        capability: String,
        input_contract: Vec<ArtifactType>,
        output_artifact_type: ArtifactType,
        depends_on: Vec<String>,
        execution_mode: String,
        deterministic: bool,
    }

    fn oracle() -> NodeBuiltinWorkflowOracle {
        serde_json::from_str(include_str!(
            "../fixtures/node-builtin-workflow-compiler-v1.json"
        ))
        .expect("Node built-in workflow compiler oracle must parse")
    }

    #[test]
    fn node_public_builtin_workflow_compiler_host_dag_matches_rust_catalog_and_compiler() {
        let fixture = oracle();
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.generated_by_node);
        assert!(fixture.source.contains("compileWorkflowPlan"));
        assert!(fixture.source.contains("listAgentContracts"));
        assert!(fixture.scope.contains("DAG projection only"));

        let roles = builtin_roles();
        assert_eq!(roles.len(), fixture.role_contracts.len());
        for (actual, expected) in roles.iter().zip(&fixture.role_contracts) {
            let actual_projection = json!({
                "role_id": actual.role_id,
                "version": actual.version,
                "capability": actual.capability,
                "inputs": actual.inputs,
                "outputs": [actual.output],
                "permissions": actual.permissions,
            });
            assert_eq!(
                actual_projection, *expected,
                "built-in role contract {} differs from Node public contract",
                actual.role_id
            );
        }

        assert_eq!(fixture.cases.len(), 3);
        for case in fixture.cases {
            assert_eq!(case.tasks.len(), 9, "{} task count", case.name);
            assert!(
                case.tasks.iter().all(|task| {
                    task.execution_mode == "host-conversation" && !task.deterministic
                }),
                "{} fixture escaped host-only scope",
                case.name
            );

            let definition = CustomWorkflowDefinition {
                workflow_id: case.workflow_id.clone(),
                version: case.workflow_version,
                name: case.workflow_id.clone(),
                description: format!("Node built-in compiler projection: {}", case.name),
                input_contract: case.input_contract,
                tasks: case
                    .tasks
                    .iter()
                    .map(|task| WorkflowTaskDefinition {
                        id: task.task_id.clone(),
                        role_id: task.role_id.clone(),
                        role_version: task.role_version,
                        depends_on: task.depends_on.clone(),
                        // Built-in roles resolve internally in compile_workflow;
                        // only custom contracts belong in its custom-role list.
                        input_contract: None,
                        output_artifact_type: None,
                    })
                    .collect(),
            };

            let plan = compile_workflow(&definition, &[])
                .unwrap_or_else(|error| panic!("{} Rust compile failed: {error}", case.name));
            assert_eq!(
                plan.workflow_id(),
                case.workflow_id,
                "{} workflow id",
                case.name
            );
            assert_eq!(
                plan.workflow_version(),
                case.workflow_version,
                "{} version",
                case.name
            );
            assert_eq!(
                plan.tasks().len(),
                case.tasks.len(),
                "{} task count",
                case.name
            );

            for (actual, expected) in plan.tasks().iter().zip(&case.tasks) {
                assert_eq!(actual.task_id, expected.task_id, "{} task id", case.name);
                assert_eq!(actual.role_id, expected.role_id, "{} role id", case.name);
                assert_eq!(
                    actual.role_version, expected.role_version,
                    "{} role version",
                    case.name
                );
                assert_eq!(
                    actual.input_contract, expected.input_contract,
                    "{} inputs for {}",
                    case.name, expected.task_id
                );
                assert_eq!(
                    actual.output_artifact_type, expected.output_artifact_type,
                    "{} output for {}",
                    case.name, expected.task_id
                );
                assert_eq!(
                    actual.depends_on, expected.depends_on,
                    "{} dependencies for {}",
                    case.name, expected.task_id
                );
                assert_eq!(
                    actual.execution_mode, expected.execution_mode,
                    "{} execution mode for {}",
                    case.name, expected.task_id
                );
                assert_eq!(
                    actual.deterministic, expected.deterministic,
                    "{} deterministic marker for {}",
                    case.name, expected.task_id
                );

                let role = builtin_role(&expected.role_id)
                    .expect("Node task role exists in Rust built-in catalog");
                assert_eq!(
                    serde_json::to_value(role.capability).expect("serialize Rust role capability"),
                    Value::String(expected.capability.clone()),
                    "{} capability for {}",
                    case.name,
                    expected.task_id
                );
            }
            plan.verify_digest().unwrap_or_else(|error| {
                panic!("{} Rust digest verification failed: {error}", case.name)
            });
        }
    }
}

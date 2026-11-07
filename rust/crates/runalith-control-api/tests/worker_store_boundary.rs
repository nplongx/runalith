//! Test-only integration of the public Worker Control HTTP routes with the
//! current Store lease/fence primitives. This is a contract harness, not a
//! production WorkerControlAuthority or a claim-signing implementation.

use std::collections::{BTreeMap, HashMap};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use runalith_control_api::{
    ControlApi, ControlApiError, ControlPrincipal, ControlPrincipalVerifier, HttpRequest,
    HttpResponse, WorkerControlAuthority, WorkerControlError,
};
use runalith_domain::{TaskOutcome, TaskSpec, TaskState, WorkflowProposal, content_hash};
use runalith_runtime::{
    ApprovalRequest, ApprovalVerificationMode, ApprovalVerifier, ClaimRequest,
    CoordinatorWorkerVerifier, Store, StoreError, TaskLeaseRenewalRequest, TaskResultEnvelope,
    TaskResultProducerVerifier, TaskResultRequest, Transaction, VerifiedApproval,
    VerifiedTaskResultProducer, WorkerExecutionFenceCompletion,
    WorkerExecutionFenceCompletionResult, WorkerExecutionFenceKind, WorkerExecutionFenceRecord,
    WorkerExecutionFenceRequest, WorkflowCancellationVerifier, WorkflowView,
};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use tempfile::TempDir;

const WORKER_ID: &str = "worker-store-boundary-01";
const WORKFLOW_ID: &str = "job_worker_store_boundary";
const TASK_ID: &str = "task_one";
const TEST_DIGEST_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_DIGEST_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

struct TestApprovalVerifier;

impl ApprovalVerifier for TestApprovalVerifier {
    fn verify(
        &self,
        _transaction: &Transaction<'_>,
        _proposal: &WorkflowProposal,
        _plan: &runalith_domain::WorkflowPlan,
        request: &ApprovalRequest,
        _mode: ApprovalVerificationMode,
    ) -> Result<VerifiedApproval, StoreError> {
        Ok(VerifiedApproval {
            actor: request.actor.clone(),
            evidence: request.evidence.clone(),
        })
    }
}

struct TestPrincipalVerifier;

impl ControlPrincipalVerifier for TestPrincipalVerifier {
    fn authenticate(&self, credential: &str) -> Result<ControlPrincipal, ControlApiError> {
        if credential != "worker-token" {
            return Err(ControlApiError::Authentication);
        }
        Ok(ControlPrincipal {
            subject: WORKER_ID.into(),
            issuer: "worker-store-boundary-test".into(),
            capabilities: vec![
                "worker.lease.renew".into(),
                "worker.result.publish".into(),
                "worker.execution_fence.reserve".into(),
                "worker.execution_fence.complete".into(),
            ],
        })
    }
}

struct RejectCoordinatorWorker;

impl CoordinatorWorkerVerifier for RejectCoordinatorWorker {
    fn authenticate_worker(
        &self,
        _transaction: &Transaction<'_>,
        _asserted_worker_id: &str,
    ) -> Result<String, StoreError> {
        Err(StoreError::ApprovalAuthorityUnavailable)
    }
}

struct RejectTaskResultProducer;

impl TaskResultProducerVerifier for RejectTaskResultProducer {
    fn authenticate_producer(
        &self,
        _transaction: &Transaction<'_>,
        _workflow_id: &str,
        _task_id: &str,
        _request: &runalith_runtime::TaskResultRequest,
    ) -> Result<String, StoreError> {
        Err(StoreError::ApprovalAuthorityUnavailable)
    }
}

/// Disposable host verifier for the result-inbox route tests. The real Store
/// still rechecks exact attempt/lease/worker and event digest in its transaction.
struct TestTaskResultProducerVerifier;

impl TaskResultProducerVerifier for TestTaskResultProducerVerifier {
    fn authenticate_producer(
        &self,
        _transaction: &Transaction<'_>,
        _workflow_id: &str,
        _task_id: &str,
        request: &TaskResultRequest,
    ) -> Result<String, StoreError> {
        if request.worker_id != WORKER_ID {
            return Err(StoreError::ApprovalAuthorityUnavailable);
        }
        Ok(WORKER_ID.into())
    }

    fn authenticate_envelope(
        &self,
        transaction: &Transaction<'_>,
        workflow_id: &str,
        task_id: &str,
        envelope: &TaskResultEnvelope,
    ) -> Result<VerifiedTaskResultProducer, StoreError> {
        if envelope.producer_id != "runner:worker-store-boundary-test"
            || envelope.request.worker_id != WORKER_ID
        {
            return Err(StoreError::ApprovalAuthorityUnavailable);
        }
        let attempt_owner: Option<(String, String)> = transaction
            .query_row(
                "SELECT lease_id,worker_id FROM task_attempts WHERE workflow_id=?1 AND task_id=?2 AND attempt=?3",
                rusqlite::params![workflow_id, task_id, envelope.request.attempt as i64],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if !attempt_owner.as_ref().is_some_and(|(lease_id, worker_id)| {
            lease_id == &envelope.request.lease_id && worker_id == &envelope.request.worker_id
        }) {
            return Err(StoreError::LeaseFenced);
        }
        Ok(VerifiedTaskResultProducer {
            worker_id: WORKER_ID.into(),
            producer_id: envelope.producer_id.clone(),
            provenance_sha256: TEST_DIGEST_B.into(),
        })
    }
}

struct RejectWorkflowCancellation;

impl WorkflowCancellationVerifier for RejectWorkflowCancellation {
    fn verify_cancel(
        &self,
        _transaction: &Transaction<'_>,
        _workflow: &WorkflowView,
        _asserted_actor: &str,
        _reason: &str,
    ) -> Result<String, StoreError> {
        Err(StoreError::ApprovalAuthorityUnavailable)
    }
}

/// Deliberately narrow test adapter. It translates public HTTP values into
/// the current typed Store DTOs and leaves cryptographic/host authority absent.
struct StoreContractHarness {
    store: Arc<Store>,
    calls: Arc<AtomicUsize>,
    /// Test-only projection cache. Production completion must read the exact
    /// persisted reservation, not rely on this process-local map.
    reservation_requests: Mutex<HashMap<String, WorkerExecutionFenceRequest>>,
}

impl StoreContractHarness {
    fn unavailable(operation: &str) -> WorkerControlError {
        WorkerControlError::Unavailable(format!("test harness does not implement {operation}"))
    }

    fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, WorkerControlError> {
        value
            .get(field)
            .and_then(Value::as_str)
            .filter(|item| !item.trim().is_empty() && item.trim() == *item)
            .ok_or_else(|| WorkerControlError::Invalid(format!("{field} is required")))
    }

    fn required_u64(value: &Value, field: &str) -> Result<u64, WorkerControlError> {
        value.get(field).and_then(Value::as_u64).ok_or_else(|| {
            WorkerControlError::Invalid(format!("{field} must be an unsigned integer"))
        })
    }

    fn store_error(error: StoreError) -> WorkerControlError {
        match error {
            StoreError::LeaseFenced
            | StoreError::LeaseRenewalConflict
            | StoreError::WorkerExecutionFenceConflict
            | StoreError::WorkerExecutionFenceFinalized
            | StoreError::ResultEnvelopeRejected(_) => {
                WorkerControlError::Conflict(error.to_string())
            }
            StoreError::Invariant(_) | StoreError::InvalidAttempt => {
                WorkerControlError::Invalid(error.to_string())
            }
            StoreError::WorkerExecutionFenceCompletionAuthorityUnavailable
            | StoreError::ApprovalAuthorityUnavailable => {
                WorkerControlError::Unavailable(error.to_string())
            }
            _ => WorkerControlError::Internal(error.to_string()),
        }
    }

    fn v2_reservation_receipt(record: &WorkerExecutionFenceRecord) -> Value {
        let request = &record.request;
        // The Store's `receipt.request_sha256` is an internal hash over the
        // complete typed request. It is intentionally not part of the public
        // ExecutionFenceV2 receipt draft; the public `request_sha256` below is
        // the producer's side-effect request digest only.
        debug_assert_ne!(request.request_sha256, record.receipt["request_sha256"]);
        json!({
            "schema_version":2,
            "receipt_id":format!("wfr-reservation:{}", record.fence_id),
            "fence_id":record.fence_id,
            "claim_id":request.claim_id,
            "workflow_id":request.workflow_id,
            "task_id":request.task_id,
            "attempt":request.attempt,
            "lease_id":request.lease_id,
            "worker_id":request.worker_id,
            "owner_epoch":request.owner_epoch,
            "plan_sha256":request.plan_sha256,
            "side_effect_id":request.side_effect_id,
            "kind":request.kind,
            "request_sha256":request.request_sha256,
            "idempotency_key":request.idempotency_key,
            "acl_sha256":request.acl_sha256,
            "state":record.state,
            "durable":record.receipt["durable"],
            "persisted_at":record.receipt["recorded_at"]
        })
    }

    fn v2_completion_receipt(result: &WorkerExecutionFenceCompletionResult) -> Value {
        let request = &result.fence.request;
        let completion = &result.completion;
        json!({
            "schema_version":2,
            "receipt_id":format!("wfr-observation:{}:{}", completion.fence_id, completion.event_id),
            "fence_id":completion.fence_id,
            "claim_id":completion.claim_id,
            "workflow_id":completion.workflow_id,
            "task_id":completion.task_id,
            "attempt":completion.attempt,
            "lease_id":completion.lease_id,
            "worker_id":completion.worker_id,
            "owner_epoch":completion.owner_epoch,
            "plan_sha256":completion.plan_sha256,
            "side_effect_id":completion.side_effect_id,
            "kind":completion.kind,
            "request_sha256":completion.request_sha256,
            "idempotency_key":request.idempotency_key,
            "acl_sha256":request.acl_sha256,
            "outcome":completion.outcome,
            "event_id":completion.event_id,
            "event_sha256":completion.event_sha256,
            "outcome_sha256":completion.outcome_sha256,
            "completion_sha256":result.completion_sha256,
            "durable":result.receipt["durable"],
            "terminal":result.terminal,
            "persisted_at":result.recorded_at
        })
    }
}

impl WorkerControlAuthority for StoreContractHarness {
    fn receive_claim(
        &self,
        _principal: &ControlPrincipal,
        _request: &Value,
    ) -> Result<Option<Value>, WorkerControlError> {
        Err(Self::unavailable("claim receive/signing"))
    }

    fn verify_claim(
        &self,
        _principal: &ControlPrincipal,
        _claim: &Value,
    ) -> Result<(), WorkerControlError> {
        Err(Self::unavailable("cryptographic claim verification"))
    }

    fn renew_lease(
        &self,
        principal: &ControlPrincipal,
        request: &Value,
    ) -> Result<Value, WorkerControlError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let claim = request
            .get("claim")
            .filter(|value| value.is_object())
            .ok_or_else(|| WorkerControlError::Invalid("claim object is required".into()))?;
        let worker_id = Self::required_string(claim, "worker_id")?;
        if worker_id != principal.subject || worker_id != WORKER_ID {
            return Err(WorkerControlError::Unauthorized(
                "claim worker differs from authenticated principal".into(),
            ));
        }
        let typed = TaskLeaseRenewalRequest {
            renewal_id: Self::required_string(request, "renewal_id")?.into(),
            workflow_id: Self::required_string(claim, "workflow_id")?.into(),
            task_id: Self::required_string(claim, "task_id")?.into(),
            lease_id: Self::required_string(claim, "lease_id")?.into(),
            worker_id: worker_id.into(),
            attempt: Self::required_u64(claim, "attempt")?,
            owner_epoch: Self::required_u64(claim, "owner_epoch")?,
            lease_ttl_seconds: Self::required_u64(request, "lease_seconds")?,
        };
        let receipt = self
            .store
            .renew_task_lease(typed)
            .map_err(Self::store_error)?;
        serde_json::to_value(receipt)
            .map_err(|error| WorkerControlError::Internal(error.to_string()))
    }

    fn publish_result(
        &self,
        principal: &ControlPrincipal,
        event: &Value,
    ) -> Result<Value, WorkerControlError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let worker_id = Self::required_string(event, "worker_id")?;
        if worker_id != principal.subject || worker_id != WORKER_ID {
            return Err(WorkerControlError::Unauthorized(
                "result worker differs from authenticated principal".into(),
            ));
        }
        let request_value = event
            .get("request")
            .filter(|value| value.is_object())
            .ok_or_else(|| WorkerControlError::Invalid("request object is required".into()))?;
        let request = TaskResultRequest {
            lease_id: Self::required_string(request_value, "lease_id")?.into(),
            worker_id: Self::required_string(request_value, "worker_id")?.into(),
            attempt: Self::required_u64(request_value, "attempt")?,
            outcome: serde_json::from_value(
                request_value
                    .get("outcome")
                    .cloned()
                    .ok_or_else(|| WorkerControlError::Invalid("outcome is required".into()))?,
            )
            .map_err(|error| WorkerControlError::Invalid(error.to_string()))?,
            evidence: serde_json::from_value(
                request_value
                    .get("evidence")
                    .cloned()
                    .ok_or_else(|| WorkerControlError::Invalid("evidence is required".into()))?,
            )
            .map_err(|error| WorkerControlError::Invalid(error.to_string()))?,
            error: request_value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned),
        };
        let envelope = TaskResultEnvelope {
            event_id: Self::required_string(event, "event_id")?.into(),
            producer_id: Self::required_string(event, "producer_id")?.into(),
            payload_sha256: Self::required_string(event, "payload_sha256")?.into(),
            request,
        };
        let workflow_id = Self::required_string(event, "workflow_id")?;
        let task_id = Self::required_string(event, "task_id")?;
        let view = self
            .store
            .record_task_result_envelope(
                workflow_id,
                task_id,
                envelope,
                &TestTaskResultProducerVerifier,
            )
            .map_err(Self::store_error)?;
        serde_json::to_value(view).map_err(|error| WorkerControlError::Internal(error.to_string()))
    }

    fn publish_provider_result(
        &self,
        _principal: &ControlPrincipal,
        _event: &Value,
    ) -> Result<Value, WorkerControlError> {
        Err(Self::unavailable("provider terminal-proof verification"))
    }

    fn deliver_session_message(
        &self,
        _principal: &ControlPrincipal,
        _message: &Value,
    ) -> Result<Value, WorkerControlError> {
        Err(Self::unavailable("session ACL verification"))
    }

    fn reserve_execution_fence(
        &self,
        _principal: &ControlPrincipal,
        request: &Value,
    ) -> Result<Value, WorkerControlError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if request.get("schema_version").and_then(Value::as_u64) != Some(2) {
            return Err(WorkerControlError::Invalid(
                "ExecutionFence reservation schema_version must equal 2".into(),
            ));
        }
        let mut store_request = request.clone();
        store_request
            .as_object_mut()
            .expect("HTTP route already requires an object")
            .remove("schema_version");
        let typed: WorkerExecutionFenceRequest = serde_json::from_value(store_request)
            .map_err(|error| WorkerControlError::Invalid(error.to_string()))?;
        let record: WorkerExecutionFenceRecord = self
            .store
            .reserve_worker_execution_fence(typed)
            .map_err(Self::store_error)?;
        self.reservation_requests
            .lock()
            .map_err(|_| WorkerControlError::Internal("reservation map is poisoned".into()))?
            .entry(record.fence_id.clone())
            .or_insert_with(|| record.request.clone());
        Ok(Self::v2_reservation_receipt(&record))
    }

    fn complete_execution_fence(
        &self,
        _principal: &ControlPrincipal,
        fence_id: &str,
        completion: &Value,
    ) -> Result<Value, WorkerControlError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if completion.get("schema_version").and_then(Value::as_u64) != Some(2) {
            return Err(WorkerControlError::Invalid(
                "ExecutionFence completion schema_version must equal 2".into(),
            ));
        }
        let idempotency_key = Self::required_string(completion, "idempotency_key")?;
        let acl_sha256 = Self::required_string(completion, "acl_sha256")?;
        let reserved = self
            .reservation_requests
            .lock()
            .map_err(|_| WorkerControlError::Internal("reservation map is poisoned".into()))?
            .get(fence_id)
            .cloned()
            .ok_or_else(|| WorkerControlError::Conflict("unknown fence ID".into()))?;
        if idempotency_key != reserved.idempotency_key || acl_sha256 != reserved.acl_sha256 {
            return Err(WorkerControlError::Conflict(
                "completion idempotency/ACL binding differs from reservation".into(),
            ));
        }
        let mut store_completion = completion.clone();
        let object = store_completion
            .as_object_mut()
            .expect("HTTP route already requires an object");
        object.remove("schema_version");
        object.remove("idempotency_key");
        object.remove("acl_sha256");
        let typed: WorkerExecutionFenceCompletion = serde_json::from_value(store_completion)
            .map_err(|error| WorkerControlError::Invalid(error.to_string()))?;
        if typed.fence_id != fence_id {
            return Err(WorkerControlError::Conflict(
                "completion fence ID differs from route path".into(),
            ));
        }
        let result: WorkerExecutionFenceCompletionResult = self
            .store
            .complete_worker_execution_fence(typed)
            .map_err(Self::store_error)?;
        Ok(Self::v2_completion_receipt(&result))
    }
}

struct Harness {
    api: ControlApi,
    calls: Arc<AtomicUsize>,
    store: Arc<Store>,
    lease: runalith_runtime::TaskLease,
    workflow: WorkflowView,
    _dir: TempDir,
}

fn harness() -> Harness {
    harness_with_lease_ttl(60)
}

fn harness_with_lease_ttl(lease_ttl_seconds: u64) -> Harness {
    let dir = tempfile::tempdir().expect("temporary Store directory");
    let database = dir.path().join("control.sqlite");
    let store = Arc::new(Store::create_new(&database).expect("create test Store"));
    let proposal = WorkflowProposal {
        workflow_id: WORKFLOW_ID.into(),
        title: "Worker route Store contract".into(),
        goal: "Exercise authenticated worker routes against Store CAS/idempotency".into(),
        tasks: vec![TaskSpec {
            task_id: TASK_ID.into(),
            role: "engineer".into(),
            description: "Exercise Store worker boundaries".into(),
            depends_on: Vec::new(),
            required_evidence: vec!["report".into()],
            inputs: BTreeMap::new(),
        }],
        metadata: BTreeMap::new(),
    };
    let created = store.create_proposal(proposal).expect("create proposal");
    let approval = ApprovalRequest {
        actor: "test-reviewer".into(),
        expected_proposal_hash: created.proposal_hash.clone(),
        expected_plan_hash: content_hash(&created.plan).expect("canonical plan digest"),
        evidence: json!({"test_fixture":true}),
    };
    let approval_verifier: Arc<dyn ApprovalVerifier> = Arc::new(TestApprovalVerifier);
    let workflow = store
        .approve(WORKFLOW_ID, approval, approval_verifier.as_ref())
        .expect("approve with test-only verifier");
    let lease = store
        .claim_task(
            WORKFLOW_ID,
            TASK_ID,
            ClaimRequest {
                worker_id: WORKER_ID.into(),
                lease_ttl_seconds,
            },
            approval_verifier.as_ref(),
        )
        .expect("claim test task");

    let calls = Arc::new(AtomicUsize::new(0));
    let authority: Arc<dyn WorkerControlAuthority> = Arc::new(StoreContractHarness {
        store: store.clone(),
        calls: calls.clone(),
        reservation_requests: Mutex::new(HashMap::new()),
    });
    let api = ControlApi::from_store(
        store.clone(),
        approval_verifier,
        Arc::new(TestPrincipalVerifier),
        Arc::new(RejectCoordinatorWorker),
        Arc::new(RejectTaskResultProducer),
        Arc::new(RejectWorkflowCancellation),
    )
    .with_worker_control_authority(authority);

    Harness {
        api,
        calls,
        store,
        lease,
        workflow,
        _dir: dir,
    }
}

fn call(api: &ControlApi, method: &str, path: &str, body: &[u8]) -> HttpResponse {
    let headers = [("authorization".into(), "Bearer worker-token".into())];
    api.handle(HttpRequest {
        method,
        path,
        query: "",
        headers: &headers,
        body,
    })
}

fn renew_body(harness: &Harness, renewal_id: &str, lease_seconds: u64) -> Value {
    json!({
        "renewal_id":renewal_id,
        "lease_seconds":lease_seconds,
        "claim":{
            "workflow_id":harness.lease.workflow_id,
            "task_id":harness.lease.task_id,
            "lease_id":harness.lease.lease_id,
            "worker_id":harness.lease.worker_id,
            "audience":WORKER_ID,
            "attempt":harness.lease.attempt,
            "owner_epoch":harness.lease.owner_epoch
        }
    })
}

fn json_response(response: &HttpResponse) -> Value {
    serde_json::from_slice(&response.body).expect("JSON HTTP response")
}

fn assert_exact_object_keys(value: &Value, expected: &[&str]) {
    let object = value.as_object().expect("receipt must be a JSON object");
    let mut actual = object.keys().map(String::as_str).collect::<Vec<_>>();
    let mut expected = expected.to_vec();
    actual.sort_unstable();
    expected.sort_unstable();
    assert_eq!(actual, expected, "public receipt key-set drifted");
}

fn fence_request(harness: &Harness) -> WorkerExecutionFenceRequest {
    WorkerExecutionFenceRequest {
        claim_id: "claim-store-boundary-01".into(),
        workflow_id: harness.lease.workflow_id.clone(),
        task_id: harness.lease.task_id.clone(),
        attempt: harness.lease.attempt,
        lease_id: harness.lease.lease_id.clone(),
        worker_id: harness.lease.worker_id.clone(),
        owner_epoch: harness.lease.owner_epoch,
        plan_sha256: harness
            .workflow
            .plan_hash
            .clone()
            .expect("approved workflow plan digest"),
        side_effect_id: "sandbox-start:store-boundary".into(),
        kind: WorkerExecutionFenceKind::SandboxStart,
        request_sha256: TEST_DIGEST_A.into(),
        idempotency_key: "fence-reservation-store-boundary-01".into(),
        acl_sha256: TEST_DIGEST_B.into(),
    }
}

fn result_event(harness: &Harness, event_id: &str, error: &str) -> Value {
    let request = TaskResultRequest {
        lease_id: harness.lease.lease_id.clone(),
        worker_id: harness.lease.worker_id.clone(),
        attempt: harness.lease.attempt,
        outcome: TaskOutcome::Unknown,
        evidence: Vec::new(),
        error: Some(error.into()),
    };
    let producer_id = "runner:worker-store-boundary-test";
    let payload = json!({
        "workflow_id":WORKFLOW_ID,
        "task_id":TASK_ID,
        "event_id":event_id,
        "producer_id":producer_id,
        "request":request
    });
    json!({
        "worker_id":WORKER_ID,
        "workflow_id":WORKFLOW_ID,
        "task_id":TASK_ID,
        "event_id":event_id,
        "producer_id":producer_id,
        "payload_sha256":content_hash(&payload).expect("canonical result envelope digest"),
        "request":request
    })
}

fn v2_fence_reservation_request(request: &WorkerExecutionFenceRequest) -> Value {
    let mut value = serde_json::to_value(request).expect("serialize reservation request");
    value
        .as_object_mut()
        .expect("reservation request is an object")
        .insert("schema_version".into(), json!(2));
    value
}

fn v2_fence_completion_request(
    completion: &WorkerExecutionFenceCompletion,
    reservation: &WorkerExecutionFenceRequest,
) -> Value {
    let mut value = serde_json::to_value(completion).expect("serialize completion request");
    let object = value
        .as_object_mut()
        .expect("completion request is an object");
    object.insert("schema_version".into(), json!(2));
    object.insert("idempotency_key".into(), json!(reservation.idempotency_key));
    object.insert("acl_sha256".into(), json!(reservation.acl_sha256));
    value
}

#[test]
fn public_renewal_route_reaches_store_idempotency_and_conflict_fences() {
    let harness = harness();
    let original = renew_body(&harness, "renewal-store-boundary-01", 120);
    let first = serde_json::to_vec(&original).unwrap();
    let response = call(&harness.api, "POST", "/v1/worker/leases/renew", &first);
    assert_eq!(response.status, 200);
    let first_receipt = json_response(&response);
    assert_eq!(first_receipt["renewal_id"], "renewal-store-boundary-01");
    assert_eq!(first_receipt["workflow_id"], WORKFLOW_ID);
    assert_eq!(first_receipt["task_id"], TASK_ID);
    assert_eq!(first_receipt["lease_id"], harness.lease.lease_id);
    assert_eq!(first_receipt["worker_id"], WORKER_ID);
    assert_eq!(first_receipt["attempt"], harness.lease.attempt);
    assert_eq!(first_receipt["owner_epoch"], harness.lease.owner_epoch);

    let exact_replay = call(&harness.api, "POST", "/v1/worker/leases/renew", &first);
    assert_eq!(exact_replay.status, 200);
    assert_eq!(exact_replay.body, response.body);
    assert_eq!(
        harness.calls.load(Ordering::SeqCst),
        2,
        "both exact requests reached the Store adapter; Store returned one receipt"
    );

    let changed =
        serde_json::to_vec(&renew_body(&harness, "renewal-store-boundary-01", 180)).unwrap();
    let conflict = call(&harness.api, "POST", "/v1/worker/leases/renew", &changed);
    assert_eq!(
        conflict.status, 409,
        "same renewal ID with changed TTL conflicts"
    );
    assert_eq!(
        harness.calls.load(Ordering::SeqCst),
        3,
        "the changed same-ID request reaches Store and is rejected there"
    );
}

#[test]
fn public_renewal_route_rejects_worker_and_ttl_mismatch_before_store() {
    let harness = harness();
    let mut wrong_worker = renew_body(&harness, "renewal-wrong-worker", 120);
    wrong_worker["claim"]["worker_id"] = json!("worker-other");
    let wrong_worker = serde_json::to_vec(&wrong_worker).unwrap();
    let response = call(
        &harness.api,
        "POST",
        "/v1/worker/leases/renew",
        &wrong_worker,
    );
    assert_eq!(response.status, 400);
    assert_eq!(harness.calls.load(Ordering::SeqCst), 0);

    let invalid_ttl =
        serde_json::to_vec(&renew_body(&harness, "renewal-invalid-ttl", 601)).unwrap();
    let response = call(
        &harness.api,
        "POST",
        "/v1/worker/leases/renew",
        &invalid_ttl,
    );
    assert_eq!(response.status, 400);
    assert_eq!(harness.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn public_result_route_reaches_store_inbox_exact_replay_and_same_event_conflict() {
    let harness = harness();
    let original = serde_json::to_vec(&result_event(
        &harness,
        "result-inbox-http-event-01",
        "worker result remains unknown",
    ))
    .unwrap();
    let accepted = call(&harness.api, "POST", "/v1/worker/results", &original);
    assert_eq!(accepted.status, 200);
    let first_view = json_response(&accepted);
    assert_eq!(first_view["state"], "EXECUTING");

    let exact_replay = call(&harness.api, "POST", "/v1/worker/results", &original);
    assert_eq!(exact_replay.status, 200);
    assert_eq!(exact_replay.body, accepted.body);
    assert_eq!(
        harness.calls.load(Ordering::SeqCst),
        2,
        "exact result replay reaches producer verification and Store inbox replay"
    );

    let changed = serde_json::to_vec(&result_event(
        &harness,
        "result-inbox-http-event-01",
        "same event ID with changed semantic body",
    ))
    .unwrap();
    let conflict = call(&harness.api, "POST", "/v1/worker/results", &changed);
    assert_eq!(conflict.status, 409);

    let mut stale_lease: Value = serde_json::from_slice(&original).unwrap();
    stale_lease["request"]["lease_id"] = json!("lease-rebound-to-another-owner");
    let stale_payload = json!({
        "workflow_id":WORKFLOW_ID,
        "task_id":TASK_ID,
        "event_id":"result-inbox-http-event-01",
        "producer_id":"runner:worker-store-boundary-test",
        "request":stale_lease["request"]
    });
    stale_lease["payload_sha256"] =
        json!(content_hash(&stale_payload).expect("canonical stale-lease result digest"));
    let stale_lease = serde_json::to_vec(&stale_lease).unwrap();
    let stale_fence = call(&harness.api, "POST", "/v1/worker/results", &stale_lease);
    assert_eq!(
        stale_fence.status, 409,
        "the same result event cannot be replayed with a different historical lease"
    );

    let second_event_same_attempt = serde_json::to_vec(&result_event(
        &harness,
        "result-inbox-http-event-02",
        "worker result remains unknown",
    ))
    .unwrap();
    let second_event = call(
        &harness.api,
        "POST",
        "/v1/worker/results",
        &second_event_same_attempt,
    );
    assert_eq!(
        second_event.status, 409,
        "one task attempt cannot be ingested under a second event identity"
    );

    let mut wrong_worker: Value = serde_json::from_slice(&original).unwrap();
    wrong_worker["worker_id"] = json!("worker-other");
    let wrong_worker = serde_json::to_vec(&wrong_worker).unwrap();
    let denied = call(&harness.api, "POST", "/v1/worker/results", &wrong_worker);
    assert_eq!(denied.status, 403);
    assert_eq!(
        harness.calls.load(Ordering::SeqCst),
        5,
        "HTTP subject rejection must not reach the Store adapter"
    );
}

#[test]
fn public_result_route_rejects_delayed_old_attempt_after_expiry_quarantine() {
    let harness = harness_with_lease_ttl(1);
    std::thread::sleep(std::time::Duration::from_millis(1_100));
    assert_eq!(
        harness.store.quarantine_expired_leases().unwrap(),
        1,
        "expired attempt must be quarantined before delayed result arrives"
    );

    let delayed = serde_json::to_vec(&result_event(
        &harness,
        "result-inbox-delayed-expired-attempt-01",
        "result arrived after its lease was expired and quarantined",
    ))
    .unwrap();
    let response = call(&harness.api, "POST", "/v1/worker/results", &delayed);
    assert_eq!(
        response.status, 409,
        "a delayed result cannot reopen a quarantined attempt"
    );
    let current = harness.store.get_workflow(WORKFLOW_ID).unwrap();
    assert_eq!(current.tasks[0].state, TaskState::Unknown);
    assert_eq!(current.tasks[0].attempts, 1);
    assert_eq!(harness.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn public_execution_fence_routes_bind_exact_store_reservation_and_unknown_observation() {
    let harness = harness();
    let reservation = fence_request(&harness);
    let public_reservation = v2_fence_reservation_request(&reservation);
    let bytes = serde_json::to_vec(&public_reservation).unwrap();
    let response = call(&harness.api, "POST", "/v1/worker/execution-fences", &bytes);
    assert_eq!(response.status, 200);
    let first = json_response(&response);
    assert_exact_object_keys(
        &first,
        &[
            "schema_version",
            "receipt_id",
            "fence_id",
            "claim_id",
            "workflow_id",
            "task_id",
            "attempt",
            "lease_id",
            "worker_id",
            "owner_epoch",
            "plan_sha256",
            "side_effect_id",
            "kind",
            "request_sha256",
            "idempotency_key",
            "acl_sha256",
            "state",
            "durable",
            "persisted_at",
        ],
    );
    assert_eq!(first["schema_version"], 2);
    assert_eq!(
        first["receipt_id"],
        format!("wfr-reservation:{}", first["fence_id"].as_str().unwrap())
    );
    assert_eq!(first["state"], "RESERVED");
    assert_eq!(first["attempt"], harness.lease.attempt);
    assert_eq!(first["owner_epoch"], harness.lease.owner_epoch);
    assert_eq!(first["lease_id"], harness.lease.lease_id);
    assert_eq!(first["worker_id"], WORKER_ID);
    assert_eq!(first["request_sha256"], TEST_DIGEST_A);
    assert!(first.get("control_store_request_sha256").is_none());
    let fence_id = first["fence_id"].as_str().expect("fence ID").to_owned();

    let replay = call(&harness.api, "POST", "/v1/worker/execution-fences", &bytes);
    assert_eq!(replay.status, 200);
    assert_eq!(json_response(&replay), first);

    let mut rebound = reservation.clone();
    rebound.request_sha256 = TEST_DIGEST_B.into();
    let rebound = serde_json::to_vec(&v2_fence_reservation_request(&rebound)).unwrap();
    let conflict = call(
        &harness.api,
        "POST",
        "/v1/worker/execution-fences",
        &rebound,
    );
    assert_eq!(conflict.status, 409);

    let observation = WorkerExecutionFenceCompletion {
        fence_id: fence_id.clone(),
        claim_id: reservation.claim_id.clone(),
        workflow_id: reservation.workflow_id.clone(),
        task_id: reservation.task_id.clone(),
        attempt: reservation.attempt,
        lease_id: reservation.lease_id.clone(),
        worker_id: reservation.worker_id.clone(),
        owner_epoch: reservation.owner_epoch,
        plan_sha256: reservation.plan_sha256.clone(),
        side_effect_id: reservation.side_effect_id.clone(),
        kind: reservation.kind,
        request_sha256: reservation.request_sha256.clone(),
        outcome: "UNKNOWN".into(),
        event_id: "sandbox-observation-unknown-01".into(),
        event_sha256: TEST_DIGEST_A.into(),
        outcome_sha256: TEST_DIGEST_B.into(),
    };
    let completion_bytes =
        serde_json::to_vec(&v2_fence_completion_request(&observation, &reservation)).unwrap();
    let completion_path = format!("/v1/worker/execution-fences/{fence_id}/complete");
    let completed = call(&harness.api, "POST", &completion_path, &completion_bytes);
    assert_eq!(completed.status, 200);
    let receipt = json_response(&completed);
    assert_exact_object_keys(
        &receipt,
        &[
            "schema_version",
            "receipt_id",
            "fence_id",
            "claim_id",
            "workflow_id",
            "task_id",
            "attempt",
            "lease_id",
            "worker_id",
            "owner_epoch",
            "plan_sha256",
            "side_effect_id",
            "kind",
            "request_sha256",
            "idempotency_key",
            "acl_sha256",
            "outcome",
            "event_id",
            "event_sha256",
            "outcome_sha256",
            "completion_sha256",
            "durable",
            "terminal",
            "persisted_at",
        ],
    );
    assert_eq!(receipt["schema_version"], 2);
    assert_eq!(
        receipt["receipt_id"],
        "wfr-observation:fence-unknown".replace(
            "fence-unknown",
            &format!("{}:{}", fence_id, observation.event_id)
        )
    );
    assert_eq!(receipt["attempt"], harness.lease.attempt);
    assert_eq!(receipt["owner_epoch"], harness.lease.owner_epoch);
    assert_eq!(receipt["request_sha256"], TEST_DIGEST_A);
    assert!(receipt.get("control_store_request_sha256").is_none());
    assert_eq!(receipt["idempotency_key"], reservation.idempotency_key);
    assert_eq!(receipt["acl_sha256"], reservation.acl_sha256);
    assert_eq!(receipt["completion_sha256"].as_str().unwrap().len(), 64);
    assert_eq!(receipt["terminal"], false);
    assert_eq!(receipt["durable"], true);

    let exact_observation_replay = call(&harness.api, "POST", &completion_path, &completion_bytes);
    assert_eq!(exact_observation_replay.status, 200);
    assert_eq!(json_response(&exact_observation_replay), receipt);

    let mut changed_acl = v2_fence_completion_request(&observation, &reservation);
    changed_acl["acl_sha256"] = json!(TEST_DIGEST_A);
    let changed_acl_bytes = serde_json::to_vec(&changed_acl).unwrap();
    let changed_acl_response = call(&harness.api, "POST", &completion_path, &changed_acl_bytes);
    assert_eq!(changed_acl_response.status, 409);

    let mut unverified_terminal_claim = observation.clone();
    unverified_terminal_claim.outcome = "SUCCEEDED".into();
    unverified_terminal_claim.event_id = "sandbox-unverified-success-01".into();
    let terminal_bytes = serde_json::to_vec(&v2_fence_completion_request(
        &unverified_terminal_claim,
        &reservation,
    ))
    .unwrap();
    let terminal_without_proof = call(&harness.api, "POST", &completion_path, &terminal_bytes);
    assert_eq!(
        terminal_without_proof.status, 503,
        "a worker-supplied SUCCEEDED label cannot release a fence without a host proof verifier"
    );

    let mut changed_observation = observation;
    changed_observation.outcome_sha256 = TEST_DIGEST_A.into();
    let changed_bytes = serde_json::to_vec(&v2_fence_completion_request(
        &changed_observation,
        &reservation,
    ))
    .unwrap();
    let changed = call(&harness.api, "POST", &completion_path, &changed_bytes);
    assert_eq!(changed.status, 409);
}

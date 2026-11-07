//! Authenticated HTTPS Control API client used by the standalone worker binary.

use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use chrono::DateTime;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    ControlPlane, ControlPlaneError, ExecutionFence, ExecutionFenceCompletion,
    ExecutionFenceCompletionReceipt, ExecutionFenceRequest, ExecutionFenceState, LeaseRenewal,
    ProviderResultEvent, PublishResult, SessionDeliveryControl, SessionDeliveryEnvelope,
    SessionDeliveryResult, TaskClaimEnvelope, TaskClaimVerifier, WorkerResultEvent,
};

/// HTTPS Control client. Credentials are passed through curl config stdin, never argv.
pub struct HttpControlPlane {
    base_url: String,
    bearer_token: String,
    curl_path: PathBuf,
    timeout_seconds: u32,
}

impl HttpControlPlane {
    /// Construct an HTTPS-only Control client with bounded curl execution.
    pub fn new(
        base_url: String,
        bearer_token: String,
        curl_path: PathBuf,
        timeout_seconds: u32,
    ) -> Result<Self, ControlPlaneError> {
        let authority = base_url
            .strip_prefix("https://")
            .and_then(|value| value.split('/').next())
            .unwrap_or_default();
        let origin_only = base_url.strip_prefix("https://").is_some_and(|value| {
            !value.is_empty()
                && !value.contains('/')
                && !value.contains('\\')
                && !value.chars().any(char::is_whitespace)
        });
        if !base_url.starts_with("https://")
            || base_url.len() > 2048
            || authority.is_empty()
            || authority.contains('@')
            || !origin_only
            || base_url.contains('?')
            || base_url.contains('#')
            || base_url.chars().any(char::is_control)
            || bearer_token.trim().is_empty()
            || bearer_token.len() > 8192
            || bearer_token.chars().any(char::is_control)
            || !(1..=60).contains(&timeout_seconds)
        {
            return Err(ControlPlaneError::NotSent(
                "Control URL, credential or timeout configuration is invalid".into(),
            ));
        }
        if !curl_path.is_absolute() {
            return Err(ControlPlaneError::NotSent(
                "curl executable path must be absolute".into(),
            ));
        }
        for component in curl_path.ancestors().filter(|component| component.exists()) {
            let metadata = std::fs::symlink_metadata(component).map_err(|error| {
                ControlPlaneError::NotSent(format!(
                    "curl executable path cannot be inspected: {error}"
                ))
            })?;
            if metadata.file_type().is_symlink() {
                return Err(ControlPlaneError::NotSent(
                    "curl executable path contains a symlink".into(),
                ));
            }
        }
        let metadata = std::fs::symlink_metadata(&curl_path).map_err(|error| {
            ControlPlaneError::NotSent(format!("curl executable unavailable: {error}"))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(ControlPlaneError::NotSent(
                "curl executable must be a regular non-symlink file".into(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err(ControlPlaneError::NotSent(
                    "curl executable is not executable".into(),
                ));
            }
        }
        Ok(Self {
            base_url: base_url.trim_end_matches('/').into(),
            bearer_token,
            curl_path,
            timeout_seconds,
        })
    }

    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<(u16, Vec<u8>), ControlPlaneError> {
        if !path.starts_with("/v1/worker/") || path.contains("..") {
            return Err(ControlPlaneError::NotSent(
                "Control API path is outside worker v1 namespace".into(),
            ));
        }
        let url = format!("{}{}", self.base_url, path);
        let mut config = String::new();
        for (key, value) in [
            ("url", url),
            ("request", method.to_owned()),
            ("max-time", self.timeout_seconds.to_string()),
            ("connect-timeout", "5".into()),
            ("max-filesize", "2097152".into()),
            ("proto", "=https".into()),
            ("header", "Accept: application/json".into()),
            ("header", "Content-Type: application/json".into()),
            (
                "header",
                format!("Authorization: Bearer {}", self.bearer_token),
            ),
            ("write-out", "\\n%{http_code}".into()),
        ] {
            config.push_str(key);
            config.push_str(" = ");
            config.push_str(&quote(&value)?);
            config.push('\n');
        }
        if let Some(body) = body {
            let body = serde_json::to_string(body)
                .map_err(|error| ControlPlaneError::NotSent(error.to_string()))?;
            config.push_str("data = ");
            config.push_str(&quote(&body)?);
            config.push('\n');
        }
        let mut child = Command::new(&self.curl_path)
            .args(["--disable", "--config", "-", "--silent", "--show-error"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                ControlPlaneError::NotSent(format!("curl could not start: {error}"))
            })?;
        let Some(mut stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ControlPlaneError::Unknown(
                "curl stdin unavailable after process start".into(),
            ));
        };
        let write = stdin.write_all(config.as_bytes());
        drop(stdin);
        if write.is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ControlPlaneError::Unknown(
                "curl request configuration write failed after process start".into(),
            ));
        }
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ControlPlaneError::Unknown(
                "curl stdout unavailable after process start".into(),
            ));
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ControlPlaneError::Unknown(
                "curl stderr unavailable after process start".into(),
            ));
        };
        let stdout_exceeded = Arc::new(AtomicBool::new(false));
        let stderr_exceeded = Arc::new(AtomicBool::new(false));
        let stdout_thread = spawn_bounded_reader(stdout, 2_097_152, stdout_exceeded.clone());
        let stderr_thread = spawn_bounded_reader(stderr, 8_192, stderr_exceeded.clone());
        let deadline = Instant::now() + Duration::from_secs(self.timeout_seconds as u64 + 2);
        let exit_status = loop {
            if stdout_exceeded.load(Ordering::Acquire) || stderr_exceeded.load(Ordering::Acquire) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(ControlPlaneError::Unknown(
                    "Control HTTPS response exceeded bounded output".into(),
                ));
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {}
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    let _ = stderr_thread.join();
                    return Err(ControlPlaneError::Unknown(format!(
                        "curl wait failed: {error}"
                    )));
                }
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(ControlPlaneError::Unknown(
                    "Control HTTPS request exceeded worker transport deadline".into(),
                ));
            }
            thread::sleep(Duration::from_millis(10));
        };
        let stdout = stdout_thread
            .join()
            .map_err(|_| ControlPlaneError::Unknown("curl stdout reader panicked".into()))?
            .map_err(|error| {
                ControlPlaneError::Unknown(format!("curl stdout read failed: {error}"))
            })?;
        let stderr = stderr_thread
            .join()
            .map_err(|_| ControlPlaneError::Unknown("curl stderr reader panicked".into()))?
            .map_err(|error| {
                ControlPlaneError::Unknown(format!("curl stderr read failed: {error}"))
            })?;
        if !exit_status.success() {
            let diagnostic = String::from_utf8_lossy(&stderr);
            return Err(ControlPlaneError::Unknown(format!(
                "Control HTTPS transport failed: {}",
                diagnostic.chars().take(512).collect::<String>()
            )));
        }
        let split = stdout
            .iter()
            .rposition(|byte| *byte == b'\n')
            .ok_or_else(|| {
                ControlPlaneError::Unknown("Control response omitted HTTP status trailer".into())
            })?;
        let status = std::str::from_utf8(&stdout[split + 1..])
            .ok()
            .and_then(|value| value.trim().parse::<u16>().ok())
            .ok_or_else(|| {
                ControlPlaneError::Unknown("Control response HTTP status is malformed".into())
            })?;
        Ok((status, stdout[..split].to_vec()))
    }

    fn decode<T: DeserializeOwned>(status: u16, body: &[u8]) -> Result<T, ControlPlaneError> {
        if status != 200 {
            return Err(classify_status(status, body));
        }
        serde_json::from_slice(body).map_err(|error| {
            ControlPlaneError::Unknown(format!("Control JSON response invalid: {error}"))
        })
    }
}

impl TaskClaimVerifier for HttpControlPlane {
    fn verify(&self, claim: &TaskClaimEnvelope) -> Result<(), String> {
        let (status, body) = self
            .request(
                "POST",
                "/v1/worker/claims/verify",
                Some(&json!({"claim":claim})),
            )
            .map_err(|error| error.to_string())?;
        if status == 401 || status == 403 {
            return Err("Control rejected worker claim authentication".into());
        }
        let response: Value = Self::decode(status, &body).map_err(|error| error.to_string())?;
        if response.get("valid").and_then(Value::as_bool) == Some(true) {
            Ok(())
        } else {
            Err("Control did not authorize exact claim".into())
        }
    }
}

impl ControlPlane for HttpControlPlane {
    fn receive_claim(
        &self,
        worker_id: &str,
    ) -> Result<Option<TaskClaimEnvelope>, ControlPlaneError> {
        let (status, body) = self.request(
            "POST",
            "/v1/worker/claims/receive",
            Some(&json!({"worker_id":worker_id})),
        )?;
        if status == 204 {
            if !body.is_empty() {
                return Err(ControlPlaneError::Unknown(
                    "empty claim response included a body".into(),
                ));
            }
            return Ok(None);
        }
        if status != 200 {
            return Err(classify_status(status, &body));
        }
        let response: Value = serde_json::from_slice(&body).map_err(|error| {
            ControlPlaneError::Unknown(format!("Control claim response JSON invalid: {error}"))
        })?;
        let claim = response
            .get("claim")
            .filter(|claim| claim.is_object())
            .cloned()
            .ok_or_else(|| {
                ControlPlaneError::Unknown(
                    "Control claim response omitted an object-valued claim".into(),
                )
            })?;
        serde_json::from_value(claim).map(Some).map_err(|error| {
            ControlPlaneError::Unknown(format!("Control claim payload invalid: {error}"))
        })
    }

    fn renew_lease(
        &self,
        claim: &TaskClaimEnvelope,
        lease_seconds: u64,
    ) -> Result<LeaseRenewal, ControlPlaneError> {
        let renewal_id = format!("lrn_{}", Uuid::new_v4().simple());
        let (status, body) = self.request(
            "POST",
            "/v1/worker/leases/renew",
            Some(&json!({
                "renewal_id":renewal_id,
                "claim":claim,
                "lease_seconds":lease_seconds
            })),
        )?;
        if status == 401 || status == 403 || status == 409 {
            return Err(ControlPlaneError::Unauthorized(
                "Control lease renewal rejected current ownership".into(),
            ));
        }
        let response: Value = Self::decode(status, &body)?;
        let expires_at = response
            .get("expires_at")
            .and_then(Value::as_str)
            .ok_or_else(|| ControlPlaneError::Unknown("lease renewal omitted expires_at".into()))?;
        Ok(LeaseRenewal {
            lease_id: response
                .get("lease_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            owner_epoch: response
                .get("owner_epoch")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            worker_id: response
                .get("worker_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            expires_at: DateTime::parse_from_rfc3339(expires_at)
                .map_err(|error| {
                    ControlPlaneError::Unknown(format!("lease renewal expiry invalid: {error}"))
                })?
                .with_timezone(&chrono::Utc),
        })
    }

    fn publish_result(
        &self,
        event: &WorkerResultEvent,
    ) -> Result<PublishResult, ControlPlaneError> {
        let payload = serde_json::to_value(event)
            .map_err(|error| ControlPlaneError::NotSent(error.to_string()))?;
        let event_sha256 = runalith_domain::content_hash(&payload)
            .map_err(|error| ControlPlaneError::NotSent(error.to_string()))?;
        let (status, body) = self.request("POST", "/v1/worker/results", Some(&payload))?;
        classify_publish(status, &body, &event.event_id, &event_sha256)
    }

    fn publish_provider_result(
        &self,
        event: &ProviderResultEvent,
    ) -> Result<PublishResult, ControlPlaneError> {
        let payload = serde_json::to_value(event)
            .map_err(|error| ControlPlaneError::NotSent(error.to_string()))?;
        let event_sha256 = runalith_domain::content_hash(&payload)
            .map_err(|error| ControlPlaneError::NotSent(error.to_string()))?;
        let (status, body) = self.request("POST", "/v1/worker/provider-results", Some(&payload))?;
        classify_publish(status, &body, &event.event_id, &event_sha256)
    }

    fn reserve_execution_fence(
        &self,
        request: &ExecutionFenceRequest,
    ) -> Result<ExecutionFence, ControlPlaneError> {
        validate_fence_request(request)?;
        let payload = serde_json::to_value(request)
            .map_err(|error| ControlPlaneError::NotSent(error.to_string()))?;
        let (status, body) = self.request("POST", "/v1/worker/execution-fences", Some(&payload))?;
        if !matches!(status, 200 | 201 | 208) {
            return Err(classify_status(status, &body));
        }
        let response: ExecutionFence = serde_json::from_slice(&body).map_err(|error| {
            ControlPlaneError::Unknown(format!("execution fence response invalid: {error}"))
        })?;
        if !valid_fence_id(&response.fence_id)
            || response.state != ExecutionFenceState::Reserved
            || !response.receipt.is_object()
            || response.claim_id != request.claim_id
            || response.lease_id != request.lease_id
            || response.worker_id != request.worker_id
            || response.owner_epoch != request.owner_epoch
            || response.plan_sha256 != request.plan_sha256
            || response.side_effect_id != request.side_effect_id
            || response.kind != request.kind
            || response.request_sha256 != request.request_sha256
            || response.idempotency_key != request.idempotency_key
        {
            return Err(ControlPlaneError::Unknown(
                "execution fence response omitted exact reservation binding or durable receipt"
                    .into(),
            ));
        }
        Ok(response)
    }

    fn complete_execution_fence(
        &self,
        fence: &ExecutionFence,
        completion: &ExecutionFenceCompletion,
    ) -> Result<ExecutionFenceCompletionReceipt, ControlPlaneError> {
        validate_fence_completion(fence, completion)?;
        let payload = serde_json::to_value(completion)
            .map_err(|error| ControlPlaneError::NotSent(error.to_string()))?;
        let path = format!("/v1/worker/execution-fences/{}/complete", fence.fence_id);
        let (status, body) = self.request("POST", &path, Some(&payload))?;
        if !matches!(status, 200 | 201 | 208) {
            return Err(classify_status(status, &body));
        }
        let response: ExecutionFenceCompletionReceipt =
            serde_json::from_slice(&body).map_err(|error| {
                ControlPlaneError::Unknown(format!(
                    "execution fence completion receipt invalid: {error}"
                ))
            })?;
        if !response.receipt.is_object()
            || response.fence_id != completion.fence_id
            || response.claim_id != completion.claim_id
            || response.lease_id != completion.lease_id
            || response.worker_id != completion.worker_id
            || response.owner_epoch != completion.owner_epoch
            || response.plan_sha256 != completion.plan_sha256
            || response.side_effect_id != completion.side_effect_id
            || response.request_sha256 != completion.request_sha256
            || response.event_id != completion.event_id
            || response.event_sha256 != completion.event_sha256
            || response.outcome_sha256 != completion.outcome_sha256
        {
            return Err(ControlPlaneError::Unknown(
                "execution fence completion omitted exact binding or durable receipt".into(),
            ));
        }
        Ok(response)
    }
}

fn validate_fence_request(request: &ExecutionFenceRequest) -> Result<(), ControlPlaneError> {
    let digest = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if request.claim_id.trim().is_empty()
        || request.lease_id.trim().is_empty()
        || request.worker_id.trim().is_empty()
        || request.owner_epoch == 0
        || request.side_effect_id.trim().is_empty()
        || request.idempotency_key.trim().is_empty()
        || !digest(&request.plan_sha256)
        || !digest(&request.request_sha256)
        || !digest(&request.acl_sha256)
    {
        return Err(ControlPlaneError::NotSent(
            "execution fence request identity or SHA-256 binding is invalid".into(),
        ));
    }
    Ok(())
}

fn valid_fence_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_fence_completion(
    fence: &ExecutionFence,
    completion: &ExecutionFenceCompletion,
) -> Result<(), ControlPlaneError> {
    let digest = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if completion.fence_id != fence.fence_id
        || !valid_fence_id(&fence.fence_id)
        || completion.claim_id != fence.claim_id
        || completion.lease_id != fence.lease_id
        || completion.worker_id != fence.worker_id
        || completion.owner_epoch != fence.owner_epoch
        || completion.plan_sha256 != fence.plan_sha256
        || completion.side_effect_id != fence.side_effect_id
        || completion.request_sha256 != fence.request_sha256
        || !digest(&completion.event_sha256)
        || !digest(&completion.outcome_sha256)
        || completion.event_id.trim().is_empty()
    {
        return Err(ControlPlaneError::NotSent(
            "execution fence completion does not bind exact reservation and outcome".into(),
        ));
    }
    Ok(())
}

impl SessionDeliveryControl for HttpControlPlane {
    fn deliver(&self, message: &SessionDeliveryEnvelope) -> Result<SessionDeliveryResult, String> {
        let (status, body) = self
            .request(
                "POST",
                "/v1/worker/sessions/deliver",
                Some(
                    &serde_json::to_value(message)
                        .map_err(|error| ControlPlaneError::NotSent(error.to_string()))
                        .map_err(|error| error.to_string())?,
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(classify_session_delivery(status, &body, message))
    }
}

fn spawn_bounded_reader<R: Read + Send + 'static>(
    mut reader: R,
    limit: usize,
    exceeded: Arc<AtomicBool>,
) -> thread::JoinHandle<std::io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut captured = Vec::with_capacity(limit.min(8192));
        let mut buffer = [0_u8; 8192];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            let remaining = limit.saturating_sub(captured.len());
            captured.extend_from_slice(&buffer[..read.min(remaining)]);
            if read > remaining {
                exceeded.store(true, Ordering::Release);
            }
        }
        Ok(captured)
    })
}

fn classify_publish(
    status: u16,
    body: &[u8],
    event_id: &str,
    event_sha256: &str,
) -> Result<PublishResult, ControlPlaneError> {
    let response: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let exact_binding = response.get("event_id").and_then(Value::as_str) == Some(event_id)
        && response.get("event_sha256").and_then(Value::as_str) == Some(event_sha256);
    match status {
        200 | 201 | 208
            if exact_binding && response.get("receipt").is_some_and(Value::is_object) =>
        {
            if status == 208 {
                Ok(PublishResult::AlreadyAccepted)
            } else {
                Ok(PublishResult::Accepted)
            }
        }
        409 => match response.get("code").and_then(Value::as_str) {
            Some("STALE_OWNER")
                if exact_binding && response.get("receipt").is_some_and(Value::is_object) =>
            {
                Ok(PublishResult::StaleOwner)
            }
            Some("ALREADY_ACCEPTED")
                if exact_binding && response.get("receipt").is_some_and(Value::is_object) =>
            {
                Ok(PublishResult::AlreadyAccepted)
            }
            Some("STALE_OWNER" | "ALREADY_ACCEPTED") => Err(ControlPlaneError::Unknown(
                "Control 409 response did not bind the exact event digest and durable receipt"
                    .into(),
            )),
            _ => Err(ControlPlaneError::Rejected(
                "Control permanently rejected result event with HTTP 409".into(),
            )),
        },
        200 | 201 | 208 => Err(ControlPlaneError::Unknown(
            "Control result acknowledgement omitted exact event identity or durable receipt".into(),
        )),
        _ => Err(classify_status(status, body)),
    }
}

fn classify_session_delivery(
    status: u16,
    body: &[u8],
    message: &SessionDeliveryEnvelope,
) -> SessionDeliveryResult {
    let response: Value = match serde_json::from_slice(body) {
        Ok(response) => response,
        Err(_) => {
            return SessionDeliveryResult::Unknown {
                diagnostic: format!(
                    "Control session delivery returned HTTP {status} without a valid receipt"
                ),
            };
        }
    };
    match status {
        200 | 201 | 208 => {
            let exact_binding = response.get("message_id").and_then(Value::as_str)
                == Some(message.message_id.as_str())
                && response.get("session_id").and_then(Value::as_str)
                    == Some(message.session_id.as_str())
                && response.get("lease_id").and_then(Value::as_str)
                    == Some(message.lease_id.as_str())
                && response.get("owner_epoch").and_then(Value::as_u64) == Some(message.owner_epoch)
                && response.get("receipt").is_some_and(Value::is_object);
            if exact_binding {
                SessionDeliveryResult::Delivered {
                    receipt: response.get("receipt").cloned().unwrap_or(Value::Null),
                }
            } else {
                SessionDeliveryResult::Unknown { diagnostic: "Control session receipt did not bind exact message, session, lease and owner epoch".into() }
            }
        }
        409 if matches!(
            response.get("code").and_then(Value::as_str),
            Some("STALE_OWNER" | "STALE_SESSION" | "ACL_REVOKED")
        ) =>
        {
            SessionDeliveryResult::RejectedStale
        }
        422 => SessionDeliveryResult::Unknown {
            diagnostic: "Control returned HTTP 422; session delivery is not classified as a pre-send transport failure".into(),
        },
        _ => SessionDeliveryResult::Unknown {
            diagnostic: format!("Control session delivery returned unclassified HTTP {status}"),
        },
    }
}

fn classify_status(status: u16, body: &[u8]) -> ControlPlaneError {
    let diagnostic = String::from_utf8_lossy(body)
        .chars()
        .take(512)
        .collect::<String>();
    match status {
        401 | 403 => ControlPlaneError::Unauthorized(format!("HTTP {status}: {diagnostic}")),
        400 | 404 | 409 | 410 | 422 => {
            ControlPlaneError::Rejected(format!("HTTP {status}: {diagnostic}"))
        }
        _ => ControlPlaneError::Unknown(format!("HTTP {status}: {diagnostic}")),
    }
}

fn quote(value: &str) -> Result<String, ControlPlaneError> {
    if value.chars().any(|character| character.is_control()) {
        return Err(ControlPlaneError::NotSent(
            "curl config value contains control characters".into(),
        ));
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ExecutionFenceKind, TaskClaimEnvelope, WorkerOutcome};
    use runalith_sandbox::CommandRequest;
    use std::{fs, os::unix::fs::PermissionsExt};

    fn fake_curl(directory: &std::path::Path, script_body: &str) -> PathBuf {
        let path = directory.join(format!("curl-fixture-{}", uuid::Uuid::new_v4()));
        fs::write(&path, format!("#!/bin/sh\n{script_body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn claim() -> TaskClaimEnvelope {
        let command = CommandRequest {
            executable: PathBuf::from("/usr/bin/true"),
            arguments: vec![],
            working_directory: PathBuf::from("."),
            environment: Default::default(),
            stdin: vec![],
        };
        TaskClaimEnvelope {
            schema_version: crate::TASK_CLAIM_SCHEMA_VERSION,
            claim_id: "claim-renewal-test".into(),
            issuer: "control-test".into(),
            audience: "worker-1".into(),
            issued_at: "2026-11-02T10:00:00Z".into(),
            expires_at: "2099-11-02T10:00:00Z".into(),
            workflow_id: "workflow-1".into(),
            task_id: "task-1".into(),
            attempt: 1,
            owner_epoch: 7,
            lease_id: "lease-1".into(),
            worker_id: "worker-1".into(),
            plan_sha256: "a".repeat(64),
            command_sha256: "b".repeat(64),
            idempotency_key: "claim-idempotency-1".into(),
            authenticator: json!({"fixture":true}),
            command,
            provider_dispatch: None,
            session_messages: vec![],
        }
    }

    #[test]
    fn lease_renewal_http_calls_carry_distinct_idempotency_ids_in_request_body() {
        let directory = tempfile::tempdir().unwrap();
        let captured = directory.path().join("renewal-requests.txt");
        let response = json!({
            "lease_id":"lease-1",
            "worker_id":"worker-1",
            "owner_epoch":7,
            "expires_at":"2099-11-02T10:02:00Z"
        });
        let curl = fake_curl(
            directory.path(),
            &format!(
                "cat >> '{}'; printf '%s\\n200' '{}'",
                captured.display(),
                response
            ),
        );
        let control = HttpControlPlane::new(
            "https://control.example".into(),
            "fixture-token".into(),
            curl,
            2,
        )
        .unwrap();
        let claim = claim();
        control.renew_lease(&claim, 120).unwrap();
        control.renew_lease(&claim, 120).unwrap();

        let requests = fs::read_to_string(captured).unwrap();
        let renewal_ids = requests
            .match_indices("lrn_")
            .filter_map(|(start, _)| {
                let suffix = &requests[start..];
                let end = suffix.find("\\\"")?;
                Some(suffix[..end].to_owned())
            })
            .collect::<Vec<_>>();
        assert_eq!(renewal_ids.len(), 2, "{requests}");
        assert_ne!(renewal_ids[0], renewal_ids[1]);
        assert!(requests.contains("lease_seconds"));
        assert!(requests.contains("claim-renewal-test"));
    }

    fn message() -> SessionDeliveryEnvelope {
        SessionDeliveryEnvelope {
            message_id: "message-1".into(),
            idempotency_key: "dedupe-1".into(),
            workflow_id: "workflow-1".into(),
            task_id: "task-1".into(),
            attempt: 2,
            owner_epoch: 9,
            lease_id: "lease-1".into(),
            worker_id: "worker-1".into(),
            session_id: "session-1".into(),
            recipient_role: "qa".into(),
            message_type: "session.message".into(),
            payload: json!({"text":"hello"}),
            expires_at: "2026-12-01T00:00:00Z".into(),
        }
    }

    fn fence_request() -> ExecutionFenceRequest {
        ExecutionFenceRequest {
            claim_id: "claim-1".into(),
            lease_id: "lease-1".into(),
            worker_id: "worker-1".into(),
            owner_epoch: 7,
            plan_sha256: "a".repeat(64),
            side_effect_id: "sandbox-start-1".into(),
            kind: ExecutionFenceKind::SandboxStart,
            request_sha256: "b".repeat(64),
            idempotency_key: "fence-idem-1".into(),
            acl_sha256: "c".repeat(64),
        }
    }

    fn fence_response(request: &ExecutionFenceRequest) -> Value {
        json!({
            "fence_id":"fence-1", "claim_id":request.claim_id,
            "lease_id":request.lease_id, "worker_id":request.worker_id,
            "owner_epoch":request.owner_epoch, "plan_sha256":request.plan_sha256,
            "side_effect_id":request.side_effect_id, "kind":"sandbox_start",
            "request_sha256":request.request_sha256,
            "idempotency_key":request.idempotency_key, "state":"RESERVED",
            "receipt":{"reservation_id":"receipt-1"}
        })
    }

    #[test]
    fn execution_fence_reservation_requires_exact_binding_and_durable_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let request = fence_request();
        let response = fence_response(&request);
        let curl = fake_curl(
            directory.path(),
            &format!("cat >/dev/null; printf '%s\\n201' '{}'", response),
        );
        let control = HttpControlPlane::new(
            "https://control.example".into(),
            "fixture-token".into(),
            curl,
            2,
        )
        .unwrap();
        let fence = control.reserve_execution_fence(&request).unwrap();
        assert_eq!(fence.fence_id, "fence-1");

        let mut mismatched = response;
        mismatched["owner_epoch"] = json!(8);
        let curl = fake_curl(
            directory.path(),
            &format!("cat >/dev/null; printf '%s\\n201' '{}'", mismatched),
        );
        let control = HttpControlPlane::new(
            "https://control.example".into(),
            "fixture-token".into(),
            curl,
            2,
        )
        .unwrap();
        assert!(matches!(
            control.reserve_execution_fence(&request),
            Err(ControlPlaneError::Unknown(_))
        ));

        let mut unsafe_id = fence_response(&request);
        unsafe_id["fence_id"] = json!("../results");
        let curl = fake_curl(
            directory.path(),
            &format!("cat >/dev/null; printf '%s\\n201' '{}'", unsafe_id),
        );
        let control = HttpControlPlane::new(
            "https://control.example".into(),
            "fixture-token".into(),
            curl,
            2,
        )
        .unwrap();
        assert!(matches!(
            control.reserve_execution_fence(&request),
            Err(ControlPlaneError::Unknown(_))
        ));
    }

    #[test]
    fn execution_fence_completion_binds_exact_outcome_and_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let request = fence_request();
        let fence: ExecutionFence = serde_json::from_value(fence_response(&request)).unwrap();
        let completion = ExecutionFenceCompletion {
            fence_id: fence.fence_id.clone(),
            claim_id: request.claim_id.clone(),
            lease_id: request.lease_id.clone(),
            worker_id: request.worker_id.clone(),
            owner_epoch: request.owner_epoch,
            plan_sha256: request.plan_sha256.clone(),
            side_effect_id: request.side_effect_id.clone(),
            request_sha256: request.request_sha256.clone(),
            outcome: WorkerOutcome::Succeeded,
            event_id: "event-1".into(),
            event_sha256: "d".repeat(64),
            outcome_sha256: "e".repeat(64),
        };
        let receipt = json!({
            "fence_id":"fence-1", "claim_id":"claim-1", "worker_id":"worker-1",
            "lease_id":"lease-1",
            "owner_epoch":7, "plan_sha256":"a".repeat(64),
            "side_effect_id":"sandbox-start-1", "request_sha256":"b".repeat(64),
            "event_id":"event-1", "event_sha256":"d".repeat(64),
            "outcome_sha256":"e".repeat(64), "receipt":{"completion_id":"done-1"}
        });
        let curl = fake_curl(
            directory.path(),
            &format!("cat >/dev/null; printf '%s\\n200' '{}'", receipt),
        );
        let control = HttpControlPlane::new(
            "https://control.example".into(),
            "fixture-token".into(),
            curl,
            2,
        )
        .unwrap();
        control
            .complete_execution_fence(&fence, &completion)
            .unwrap_or_else(|error| panic!("exact execution-fence completion failed: {error:?}"));

        let mut wrong = completion.clone();
        wrong.owner_epoch += 1;
        assert!(matches!(
            control.complete_execution_fence(&fence, &wrong),
            Err(ControlPlaneError::NotSent(_))
        ));
    }

    #[test]
    fn execution_fence_rejects_invalid_digests_before_network_send() {
        let directory = tempfile::tempdir().unwrap();
        let curl = fake_curl(directory.path(), "exit 99");
        let control = HttpControlPlane::new(
            "https://control.example".into(),
            "fixture-token".into(),
            curl,
            2,
        )
        .unwrap();
        let mut request = fence_request();
        request.acl_sha256 = "NOT-A-DIGEST".into();
        assert!(matches!(
            control.reserve_execution_fence(&request),
            Err(ControlPlaneError::NotSent(_))
        ));
    }

    #[test]
    fn session_delivery_requires_exact_durable_receipt_before_ack() {
        let message = message();
        let receipt = json!({"message_id":"message-1","session_id":"session-1","lease_id":"lease-1","owner_epoch":9,"receipt":{"delivery_id":"delivery-1"}});
        assert!(matches!(
            classify_session_delivery(200, &serde_json::to_vec(&receipt).unwrap(), &message),
            SessionDeliveryResult::Delivered { .. }
        ));
        let mut stale = receipt.clone();
        stale["owner_epoch"] = json!(8);
        assert!(matches!(
            classify_session_delivery(200, &serde_json::to_vec(&stale).unwrap(), &message),
            SessionDeliveryResult::Unknown { .. }
        ));
        assert!(matches!(
            classify_session_delivery(200, b"not-json", &message),
            SessionDeliveryResult::Unknown { .. }
        ));
    }

    #[test]
    fn session_delivery_does_not_treat_http_422_as_not_sent() {
        let message = message();
        let not_sent = json!({"code":"NOT_SENT","transport_started":false});
        assert!(matches!(
            classify_session_delivery(422, &serde_json::to_vec(&not_sent).unwrap(), &message),
            SessionDeliveryResult::Unknown { .. }
        ));
        let ambiguous = json!({"code":"NOT_SENT","transport_started":true});
        assert!(matches!(
            classify_session_delivery(422, &serde_json::to_vec(&ambiguous).unwrap(), &message),
            SessionDeliveryResult::Unknown { .. }
        ));
        let stale = json!({"code":"STALE_OWNER"});
        assert_eq!(
            classify_session_delivery(409, &serde_json::to_vec(&stale).unwrap(), &message),
            SessionDeliveryResult::RejectedStale
        );
        assert!(matches!(
            classify_session_delivery(409, b"{}", &message),
            SessionDeliveryResult::Unknown { .. }
        ));
    }

    #[test]
    fn curl_config_is_stdin_only_and_disables_account_curlrc() {
        let directory = tempfile::tempdir().unwrap();
        let args = directory.path().join("args.txt");
        let config_path = directory.path().join("config.txt");
        let script = format!(
            "printf '%s\\n' \"$@\" > '{}'; cat > '{}'; printf '{{\"ok\":true}}\\n200'",
            args.display(),
            config_path.display()
        );
        let curl = fake_curl(directory.path(), &script);
        let control = HttpControlPlane::new(
            "https://control.example".into(),
            "fixture-secret".into(),
            curl,
            2,
        )
        .unwrap();
        let (status, body) = control
            .request("POST", "/v1/worker/test", Some(&json!({"task":"t"})))
            .unwrap();
        assert_eq!(status, 200);
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"ok":true})
        );
        let args = fs::read_to_string(args).unwrap();
        assert_eq!(args.lines().next(), Some("--disable"));
        assert!(!args.contains("fixture-secret"));
        let config = fs::read_to_string(config_path).unwrap();
        assert!(config.contains("Authorization: Bearer fixture-secret"));
        assert!(config.contains("https://control.example/v1/worker/test"));
        assert!(config.contains("\\\"task\\\":\\\"t\\\""));
    }

    #[test]
    fn curl_transport_kills_process_when_output_exceeds_hard_limit() {
        let directory = tempfile::tempdir().unwrap();
        let curl = fake_curl(directory.path(), "head -c 2200000 /dev/zero");
        let control = HttpControlPlane::new(
            "https://control.example".into(),
            "fixture-secret".into(),
            curl,
            2,
        )
        .unwrap();
        let result = control.request("GET", "/v1/worker/test", None);
        assert!(
            matches!(result, Err(ControlPlaneError::Unknown(message)) if message.contains("bounded output"))
        );
    }

    #[test]
    fn claim_receive_accepts_only_empty_204_or_200_object_envelope() {
        let cases = [
            (204, "", true),
            (204, "{\"claim\":null}", false),
            (200, "null", false),
            (200, "{\"claim\":null}", false),
            (200, "{\"valid\":true}", false),
            (201, "{\"claim\":null}", false),
            (202, "{\"claim\":null}", false),
        ];
        for (status, body, accepted) in cases {
            let directory = tempfile::tempdir().unwrap();
            let script = if body.is_empty() {
                format!("cat >/dev/null; printf '\\n{status}'")
            } else {
                format!("cat >/dev/null; printf '%s\\n%s' '{}' '{}'", body, status)
            };
            let curl = fake_curl(directory.path(), &script);
            let control = HttpControlPlane::new(
                "https://control.example".into(),
                "fixture-token".into(),
                curl,
                2,
            )
            .unwrap();
            let result = control.receive_claim("worker-1");
            assert_eq!(
                result.is_ok() && result.unwrap().is_none(),
                accepted,
                "status={status}, body={body:?}"
            );
        }
    }

    #[test]
    fn result_acknowledgement_requires_exact_event_digest_and_durable_receipt() {
        let event_id = "event-1";
        let event_sha256 = "ab".repeat(32);
        let exact = json!({"event_id":event_id,"event_sha256":event_sha256,"receipt":{"event_id":event_id}});
        assert_eq!(
            classify_publish(
                201,
                &serde_json::to_vec(&exact).unwrap(),
                event_id,
                &event_sha256
            )
            .unwrap(),
            PublishResult::Accepted
        );
        assert_eq!(
            classify_publish(
                208,
                &serde_json::to_vec(&exact).unwrap(),
                event_id,
                &event_sha256
            )
            .unwrap(),
            PublishResult::AlreadyAccepted
        );
        let stale = json!({"code":"STALE_OWNER","event_id":event_id,"event_sha256":event_sha256,"receipt":{"rejection_id":"reject-1"}});
        assert_eq!(
            classify_publish(
                409,
                &serde_json::to_vec(&stale).unwrap(),
                event_id,
                &event_sha256
            )
            .unwrap(),
            PublishResult::StaleOwner
        );
        let wrong_event =
            json!({"event_id":"other","event_sha256":event_sha256,"receipt":{"event_id":"other"}});
        assert!(matches!(
            classify_publish(
                201,
                &serde_json::to_vec(&wrong_event).unwrap(),
                event_id,
                &event_sha256
            ),
            Err(ControlPlaneError::Unknown(_))
        ));
        let missing_receipt = json!({"event_id":event_id,"event_sha256":event_sha256});
        assert!(matches!(
            classify_publish(
                200,
                &serde_json::to_vec(&missing_receipt).unwrap(),
                event_id,
                &event_sha256
            ),
            Err(ControlPlaneError::Unknown(_))
        ));
        let unbound_stale = json!({"code":"STALE_OWNER","event_id":event_id,"event_sha256":"cd".repeat(32),"receipt":{"rejection_id":"reject-1"}});
        assert!(matches!(
            classify_publish(
                409,
                &serde_json::to_vec(&unbound_stale).unwrap(),
                event_id,
                &event_sha256
            ),
            Err(ControlPlaneError::Unknown(_))
        ));
        let stale_without_receipt =
            json!({"code":"STALE_OWNER","event_id":event_id,"event_sha256":event_sha256});
        assert!(matches!(
            classify_publish(
                409,
                &serde_json::to_vec(&stale_without_receipt).unwrap(),
                event_id,
                &event_sha256
            ),
            Err(ControlPlaneError::Unknown(_))
        ));
        assert!(matches!(
            classify_publish(
                409,
                br#"{"code":"EVENT_CONFLICT"}"#,
                event_id,
                &event_sha256
            ),
            Err(ControlPlaneError::Rejected(_))
        ));
    }

    #[test]
    fn http_statuses_distinguish_permanent_rejection_auth_and_unknown_outcomes() {
        for status in [400, 404, 409, 410, 422] {
            assert!(matches!(
                classify_status(status, b"{\"error\":\"rejected\"}"),
                ControlPlaneError::Rejected(message) if message.contains(&format!("HTTP {status}"))
            ));
        }
        for status in [401, 403] {
            assert!(matches!(
                classify_status(status, b"{}"),
                ControlPlaneError::Unauthorized(message) if message.contains(&format!("HTTP {status}"))
            ));
        }
        for status in [408, 425, 429, 500, 502, 503, 504] {
            assert!(matches!(
                classify_status(status, b"{}"),
                ControlPlaneError::Unknown(message) if message.contains(&format!("HTTP {status}"))
            ));
        }
    }

    #[test]
    fn control_client_rejects_http_userinfo_query_and_relative_curl_paths() {
        let directory = tempfile::tempdir().unwrap();
        let curl = fake_curl(directory.path(), "cat >/dev/null");
        assert!(
            HttpControlPlane::new(
                "http://control.example".into(),
                "token".into(),
                curl.clone(),
                2
            )
            .is_err()
        );
        assert!(
            HttpControlPlane::new(
                "https://user@control.example".into(),
                "token".into(),
                curl.clone(),
                2
            )
            .is_err()
        );
        assert!(
            HttpControlPlane::new(
                "https://control.example?debug=1".into(),
                "token".into(),
                curl.clone(),
                2
            )
            .is_err()
        );
        assert!(
            HttpControlPlane::new(
                "https://control.example".into(),
                "token".into(),
                PathBuf::from("curl"),
                2
            )
            .is_err()
        );
    }
}

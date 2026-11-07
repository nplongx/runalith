//! GitHub Actions workflow-dispatch adapter contract.
//!
//! The adapter contains provider-specific idempotency and lookup semantics.
//! HTTP/authentication is injected through [`GitHubActionsTransport`], keeping
//! credentials outside immutable provider payloads. The default MCP host does
//! not register this adapter.

use runalith_execution_persistence::ProviderIntentRecord;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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

use crate::{
    ProviderAdapter, ProviderAdapterError, ProviderAdapterV1, ProviderDispatchObservationV1,
    ProviderDispatchOutcomeV1, ProviderDispatchRequest, ProviderDispatchRequestV1,
    ProviderDispatchResponse, ProviderEffectSubjectV1, ProviderLookupResponse,
    ProviderNotSentEvidenceV1, ProviderRunRefV1, ProviderTerminalProofV1, validate_payload,
};
use runalith_execution_persistence::{ProviderDispatchState, ProviderIntentRequest};

/// Exact GitHub Actions target parsed from the immutable provider payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitHubActionsTarget {
    /// GitHub owner or organization.
    pub owner: String,
    /// Repository name.
    pub repo: String,
    /// Workflow file path or workflow ID.
    pub workflow: String,
    /// Git reference passed to `workflow_dispatch`.
    #[serde(rename = "ref")]
    pub git_ref: String,
    /// Exact workflow inputs, including the stable Runalith intent ID.
    pub inputs: Value,
}

/// Result of a complete or incomplete provider lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitHubActionsLookup {
    /// One exact run was found for this intent ID.
    Found {
        /// GitHub run database ID.
        run_id: String,
        /// GitHub run status (queued, in_progress, completed, etc.).
        status: String,
        /// GitHub conclusion, when completed.
        conclusion: Option<String>,
        /// Browser URL for the run.
        run_url: Option<String>,
    },
    /// No run matched. `complete` is true only after all pages in the exact
    /// repository/workflow/ref search scope have been examined.
    NotFound {
        /// Number of pages searched.
        pages_scanned: u32,
        /// Whether the search covered the entire requested scope.
        complete: bool,
    },
    /// Provider cannot establish a complete result.
    Unknown {
        /// Bounded diagnostic.
        diagnostic: String,
    },
}

/// Provider's workflow-dispatch response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitHubActionsDispatch {
    /// Provider accepted the request; workflow run ID may appear after lookup.
    Accepted,
    /// Provider authoritatively rejected before creating a run.
    Rejected {
        /// Stable provider rejection code.
        reason_code: String,
        /// Bounded diagnostic.
        diagnostic: String,
    },
}

/// Injected GitHub API transport. Implementations own authentication and must
/// distinguish proven pre-send failures from ambiguous post-send outcomes.
pub trait GitHubActionsTransport: Send + Sync {
    /// Stable account/installation identity bound by the host credential
    /// configuration. Legacy transports may omit it; v1 dispatch fails closed.
    fn provider_account_id(&self) -> Option<&str> {
        None
    }

    /// Search all or part of the exact target scope for `runalith_intent_id`.
    fn lookup_run(
        &self,
        target: &GitHubActionsTarget,
        runalith_intent_id: &str,
    ) -> Result<GitHubActionsLookup, ProviderAdapterError>;

    /// Invoke one workflow-dispatch request. Never retry inside transport.
    fn dispatch_workflow(
        &self,
        target: &GitHubActionsTarget,
    ) -> Result<GitHubActionsDispatch, ProviderAdapterError>;

    /// Fetch exact completed run metadata for immutable terminal evidence.
    fn collect_run_details(
        &self,
        _target: &GitHubActionsTarget,
        _intent_id: &str,
        _run_id: &str,
    ) -> Result<Option<Vec<u8>>, ProviderAdapterError> {
        Ok(None)
    }
}

const GITHUB_API_BASE: &str = "https://api.github.com";
const GITHUB_API_VERSION: &str = "2022-11-28";
const MAX_HTTP_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_HTTP_STDERR_BYTES: usize = 64 * 1024;
const MAX_LOOKUP_PAGES: u32 = 10;

/// Bounded HTTP response returned by the concrete executor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubHttpResponse {
    /// HTTP status code.
    pub status: u16,
    /// Exact response body bytes.
    pub body: Vec<u8>,
}

/// HTTP executor seam. Production uses curl with credentials passed only on stdin;
/// tests inject a deterministic executor without contacting GitHub.
pub trait GitHubHttpExecutor: Send + Sync {
    /// Execute one HTTP request without automatic retries.
    fn execute(
        &self,
        method: &str,
        url: &str,
        bearer_token: &str,
        body: Option<&[u8]>,
    ) -> Result<GitHubHttpResponse, ProviderAdapterError>;
}

/// Concrete curl executor. No token or request body appears in process argv.
pub struct CurlGitHubHttpExecutor {
    curl_path: PathBuf,
    timeout_seconds: u32,
}

impl CurlGitHubHttpExecutor {
    /// Construct a bounded curl executor with an explicit binary path.
    pub fn new(
        curl_path: impl Into<PathBuf>,
        timeout_seconds: u32,
    ) -> Result<Self, ProviderAdapterError> {
        let curl_path = curl_path.into();
        if timeout_seconds == 0 || timeout_seconds > 300 {
            return Err(ProviderAdapterError::NotSent(
                "GitHub HTTP timeout must be between 1 and 300 seconds".into(),
            ));
        }
        if !curl_path.is_absolute() {
            return Err(ProviderAdapterError::NotSent(
                "GitHub HTTP executor path must be absolute".into(),
            ));
        }
        for component in curl_path.ancestors().filter(|component| component.exists()) {
            let metadata = std::fs::symlink_metadata(component).map_err(|error| {
                ProviderAdapterError::NotSent(format!(
                    "GitHub HTTP executor path cannot be inspected: {error}"
                ))
            })?;
            if metadata.file_type().is_symlink() {
                return Err(ProviderAdapterError::NotSent(
                    "GitHub HTTP executor path contains a symlink".into(),
                ));
            }
        }
        let metadata = std::fs::symlink_metadata(&curl_path).map_err(|error| {
            ProviderAdapterError::NotSent(format!("GitHub HTTP executor is unavailable: {error}"))
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ProviderAdapterError::NotSent(
                "GitHub HTTP executor path is not a regular file".into(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err(ProviderAdapterError::NotSent(
                    "GitHub HTTP executor is not executable".into(),
                ));
            }
        }
        Ok(Self {
            curl_path,
            timeout_seconds,
        })
    }
}

impl GitHubHttpExecutor for CurlGitHubHttpExecutor {
    fn execute(
        &self,
        method: &str,
        url: &str,
        bearer_token: &str,
        body: Option<&[u8]>,
    ) -> Result<GitHubHttpResponse, ProviderAdapterError> {
        let mut config = String::new();
        for (key, value) in [
            ("url", url.to_owned()),
            ("request", method.to_owned()),
            ("max-time", self.timeout_seconds.to_string()),
            ("connect-timeout", "10".to_owned()),
            ("header", "Accept: application/vnd.github+json".to_owned()),
            ("header", format!("Authorization: Bearer {bearer_token}")),
            (
                "header",
                format!("X-GitHub-Api-Version: {GITHUB_API_VERSION}"),
            ),
            (
                "header",
                "User-Agent: runalith-rust-github-actions".to_owned(),
            ),
            ("write-out", "\\n%{http_code}".to_owned()),
        ] {
            config.push_str(key);
            config.push_str(" = ");
            config.push_str(&curl_config_quote(&value)?);
            config.push('\n');
        }
        if let Some(body) = body {
            let body = std::str::from_utf8(body).map_err(|_| {
                ProviderAdapterError::NotSent("GitHub request body must be UTF-8 JSON".into())
            })?;
            config.push_str("data = ");
            config.push_str(&curl_config_quote(body)?);
            config.push('\n');
        }

        let mut child = Command::new(&self.curl_path)
            .args(["--disable", "--config", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                ProviderAdapterError::NotSent(format!(
                    "could not start GitHub HTTP executor: {error}"
                ))
            })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ProviderAdapterError::Ambiguous("GitHub HTTP stdout pipe unavailable".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ProviderAdapterError::Ambiguous("GitHub HTTP stderr pipe unavailable".into())
        })?;
        let stdout_exceeded = Arc::new(AtomicBool::new(false));
        let stderr_exceeded = Arc::new(AtomicBool::new(false));
        let stdout_reader = spawn_bounded_reader(
            stdout,
            MAX_HTTP_RESPONSE_BYTES + 64,
            stdout_exceeded.clone(),
        );
        let stderr_reader =
            spawn_bounded_reader(stderr, MAX_HTTP_STDERR_BYTES, stderr_exceeded.clone());
        let write_result = child
            .stdin
            .take()
            .ok_or_else(|| {
                ProviderAdapterError::Ambiguous("GitHub HTTP stdin pipe unavailable".into())
            })?
            .write_all(config.as_bytes());
        if write_result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return if method == "GET" {
                Err(ProviderAdapterError::NotSent(
                    "GitHub read request config could not be delivered to curl".into(),
                ))
            } else {
                Err(ProviderAdapterError::Ambiguous(
                    "GitHub dispatch request config write failed after executor start".into(),
                ))
            };
        }
        let deadline = Instant::now() + Duration::from_secs(self.timeout_seconds as u64 + 2);
        let status = loop {
            if stdout_exceeded.load(Ordering::Acquire) || stderr_exceeded.load(Ordering::Acquire) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(if method == "GET" {
                    ProviderAdapterError::NotSent(
                        "GitHub HTTP response exceeded bounded output".into(),
                    )
                } else {
                    ProviderAdapterError::Ambiguous(
                        "GitHub dispatch response exceeded bounded output".into(),
                    )
                });
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(if method == "GET" {
                        ProviderAdapterError::NotSent(
                            "GitHub HTTP request exceeded transport deadline".into(),
                        )
                    } else {
                        ProviderAdapterError::Ambiguous(
                            "GitHub dispatch request exceeded transport deadline".into(),
                        )
                    });
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(ProviderAdapterError::Ambiguous(format!(
                        "GitHub HTTP process wait failed: {error}"
                    )));
                }
            }
        };
        let mut output = stdout_reader
            .join()
            .map_err(|_| {
                ProviderAdapterError::Ambiguous("GitHub HTTP stdout reader panicked".into())
            })?
            .map_err(|error| {
                ProviderAdapterError::Ambiguous(format!(
                    "GitHub HTTP response read failed: {error}"
                ))
            })?;
        let stderr_bytes = stderr_reader
            .join()
            .map_err(|_| {
                ProviderAdapterError::Ambiguous("GitHub HTTP stderr reader panicked".into())
            })?
            .map_err(|error| {
                ProviderAdapterError::Ambiguous(format!(
                    "GitHub HTTP diagnostic read failed: {error}"
                ))
            })?;
        if !status.success() {
            let diagnostic = String::from_utf8_lossy(&stderr_bytes)
                .chars()
                .take(500)
                .collect::<String>();
            return if method == "GET" {
                Err(ProviderAdapterError::NotSent(format!(
                    "GitHub read request failed: {diagnostic}"
                )))
            } else {
                Err(ProviderAdapterError::Ambiguous(format!(
                    "GitHub dispatch transport failed: {diagnostic}"
                )))
            };
        }
        let status_start = output
            .iter()
            .rposition(|byte| *byte == b'\n')
            .ok_or_else(|| {
                ProviderAdapterError::Ambiguous(
                    "GitHub curl response omitted HTTP status trailer".into(),
                )
            })?;
        let status_text = std::str::from_utf8(&output[status_start + 1..])
            .map_err(|_| {
                ProviderAdapterError::Ambiguous("GitHub HTTP status trailer is not UTF-8".into())
            })?
            .trim();
        let http_status = status_text.parse::<u16>().map_err(|_| {
            ProviderAdapterError::Ambiguous("GitHub HTTP status trailer is malformed".into())
        })?;
        output.truncate(status_start);
        if output.len() > MAX_HTTP_RESPONSE_BYTES {
            return Err(ProviderAdapterError::Ambiguous(
                "GitHub HTTP response body exceeded the bounded response limit".into(),
            ));
        }
        Ok(GitHubHttpResponse {
            status: http_status,
            body: output,
        })
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

fn curl_config_quote(value: &str) -> Result<String, ProviderAdapterError> {
    if value
        .chars()
        .any(|character| character == '\0' || character == '\r' || character == '\n')
    {
        return Err(ProviderAdapterError::NotSent(
            "GitHub HTTP config contains a forbidden control character".into(),
        ));
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

/// Authenticated GitHub REST transport. It is explicit opt-in and is not
/// registered by the default MCP host.
pub struct GitHubActionsHttpTransport<E = CurlGitHubHttpExecutor> {
    bearer_token: String,
    executor: E,
    account_id: Option<String>,
}

impl GitHubActionsHttpTransport<CurlGitHubHttpExecutor> {
    /// Construct the production transport for github.com using GITHUB_TOKEN
    /// or GITHUB_ACTIONS_TOKEN supplied by the host.
    pub fn from_env() -> Result<Self, ProviderAdapterError> {
        let token = std::env::var("GITHUB_ACTIONS_TOKEN")
            .or_else(|_| std::env::var("GITHUB_TOKEN"))
            .map_err(|_| {
                ProviderAdapterError::NotSent(
                    "GITHUB_ACTIONS_TOKEN or GITHUB_TOKEN is required".into(),
                )
            })?;
        let executor = CurlGitHubHttpExecutor::new("/usr/bin/curl", 30)?;
        match std::env::var("GITHUB_ACTIONS_ACCOUNT_ID") {
            Ok(account_id) => Self::with_executor_for_account(token, account_id, executor),
            Err(_) => Self::with_executor(token, executor),
        }
    }
}

impl<E> GitHubActionsHttpTransport<E> {
    /// Construct with an explicit token and executor. The token is never
    /// included in Debug output, immutable payloads, or request arguments.
    pub fn with_executor(token: String, executor: E) -> Result<Self, ProviderAdapterError> {
        if token.trim().is_empty() || token.trim() != token || token.chars().any(char::is_control) {
            return Err(ProviderAdapterError::NotSent(
                "GitHub bearer token is malformed".into(),
            ));
        }
        Ok(Self {
            bearer_token: token,
            executor,
            account_id: None,
        })
    }

    /// Construct a v1-capable transport with an explicit non-secret GitHub
    /// account/installation identity. The identity is configuration, not a
    /// claim discovered from the repository payload.
    pub fn with_executor_for_account(
        token: String,
        account_id: impl Into<String>,
        executor: E,
    ) -> Result<Self, ProviderAdapterError> {
        let mut transport = Self::with_executor(token, executor)?;
        let account_id = account_id.into();
        if account_id.trim().is_empty()
            || account_id.trim() != account_id
            || account_id.len() > 256
            || account_id.chars().any(char::is_control)
        {
            return Err(ProviderAdapterError::NotSent(
                "GitHub provider account ID is malformed".into(),
            ));
        }
        transport.account_id = Some(account_id);
        Ok(transport)
    }
}

impl<E: GitHubHttpExecutor> GitHubActionsHttpTransport<E> {
    fn request(
        &self,
        method: &str,
        url: &str,
        body: Option<&Value>,
    ) -> Result<GitHubHttpResponse, ProviderAdapterError> {
        let body_bytes = body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|error| ProviderAdapterError::NotSent(error.to_string()))?;
        self.executor
            .execute(method, url, &self.bearer_token, body_bytes.as_deref())
    }

    fn lookup_scope(
        &self,
        target: &GitHubActionsTarget,
        intent_id: &str,
    ) -> Result<GitHubActionsLookup, ProviderAdapterError> {
        let workflow = percent_encode_path(&target.workflow);
        let mut matches = Vec::new();
        let mut marker_conflict = false;
        let expected_title = format!("P3 worker {intent_id}");
        for page in 1..=MAX_LOOKUP_PAGES {
            let filter = if target.git_ref.len() == 40
                && target.git_ref.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                format!("head_sha={}", percent_encode_query(&target.git_ref))
            } else {
                format!(
                    "branch={}",
                    percent_encode_query(
                        target
                            .git_ref
                            .strip_prefix("refs/heads/")
                            .unwrap_or(&target.git_ref)
                    )
                )
            };
            let url = format!(
                "{GITHUB_API_BASE}/repos/{}/{}/actions/workflows/{workflow}/runs?{filter}&event=workflow_dispatch&per_page=100&page={page}",
                target.owner, target.repo
            );
            let response = self.request("GET", &url, None)?;
            if !(200..300).contains(&response.status) {
                return Ok(GitHubActionsLookup::Unknown {
                    diagnostic: format!(
                        "GitHub workflow-run lookup returned HTTP {}",
                        response.status
                    ),
                });
            }
            let data: Value = serde_json::from_slice(&response.body).map_err(|error| {
                ProviderAdapterError::NotSent(format!(
                    "GitHub workflow-run response JSON is invalid: {error}"
                ))
            })?;
            let Some(runs) = data.get("workflow_runs").and_then(Value::as_array) else {
                return Ok(GitHubActionsLookup::Unknown {
                    diagnostic: "GitHub workflow-run response omitted workflow_runs array".into(),
                });
            };
            let Some(total) = data.get("total_count").and_then(Value::as_u64) else {
                return Ok(GitHubActionsLookup::Unknown {
                    diagnostic: "GitHub workflow-run response omitted total_count".into(),
                });
            };
            let pages_scanned = page;
            for run in runs {
                if run.get("display_title").and_then(Value::as_str) == Some(expected_title.as_str())
                {
                    if exact_run_match(run, target, intent_id) {
                        matches.push(run.clone());
                    } else {
                        // A conflicting run with the exact durable marker is not absence.
                        marker_conflict = true;
                    }
                }
            }
            let scanned = (page as u64).saturating_mul(100);
            if runs.len() < 100 && scanned < total {
                return Ok(GitHubActionsLookup::Unknown {
                    diagnostic: "GitHub short page did not cover the reported total_count".into(),
                });
            }
            if runs.len() < 100 || scanned >= total {
                if marker_conflict {
                    return Ok(GitHubActionsLookup::Unknown {
                        diagnostic: "GitHub returned the exact durable intent marker with conflicting immutable run identity".into(),
                    });
                }
                if matches.len() > 1 {
                    return Ok(GitHubActionsLookup::Unknown {
                        diagnostic:
                            "multiple GitHub workflow runs matched the same durable intent ID"
                                .into(),
                    });
                }
                if let Some(run) = matches.pop() {
                    let run_id = run
                        .get("id")
                        .and_then(Value::as_u64)
                        .map(|value| value.to_string());
                    let Some(run_id) = run_id.filter(|value| valid_run_id(value)) else {
                        return Ok(GitHubActionsLookup::Unknown {
                            diagnostic: "GitHub run returned malformed database ID".into(),
                        });
                    };
                    let status = run
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let conclusion = run
                        .get("conclusion")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let run_url = run
                        .get("html_url")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    return Ok(GitHubActionsLookup::Found {
                        run_id,
                        status,
                        conclusion,
                        run_url,
                    });
                }
                return Ok(GitHubActionsLookup::NotFound {
                    pages_scanned,
                    complete: true,
                });
            }
            if page == MAX_LOOKUP_PAGES {
                return Ok(GitHubActionsLookup::Unknown {
                    diagnostic: format!(
                        "GitHub lookup pagination exceeded {MAX_LOOKUP_PAGES} pages; total_count={total}"
                    ),
                });
            }
        }
        Ok(GitHubActionsLookup::Unknown {
            diagnostic: "GitHub lookup pagination ended without a completeness proof".into(),
        })
    }
}

impl<E: GitHubHttpExecutor> GitHubActionsTransport for GitHubActionsHttpTransport<E> {
    fn provider_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }

    fn lookup_run(
        &self,
        target: &GitHubActionsTarget,
        runalith_intent_id: &str,
    ) -> Result<GitHubActionsLookup, ProviderAdapterError> {
        self.lookup_scope(target, runalith_intent_id)
    }

    fn dispatch_workflow(
        &self,
        target: &GitHubActionsTarget,
    ) -> Result<GitHubActionsDispatch, ProviderAdapterError> {
        let workflow = percent_encode_path(&target.workflow);
        let url = format!(
            "{GITHUB_API_BASE}/repos/{}/{}/actions/workflows/{workflow}/dispatches",
            target.owner, target.repo
        );
        let body = serde_json::json!({"ref":target.git_ref,"inputs":target.inputs});
        let response = self.request("POST", &url, Some(&body))?;
        match response.status {
            204 => Ok(GitHubActionsDispatch::Accepted),
            status if matches!(status, 400 | 401 | 403 | 404 | 405 | 410 | 413 | 415 | 422) => {
                Ok(GitHubActionsDispatch::Rejected {
                    reason_code: format!("HTTP_{status}"),
                    diagnostic: format!("GitHub rejected workflow_dispatch with HTTP {status}"),
                })
            }
            status => Err(ProviderAdapterError::Ambiguous(format!(
                "GitHub workflow_dispatch returned HTTP {status}; remote outcome is not authoritative"
            ))),
        }
    }

    fn collect_run_details(
        &self,
        target: &GitHubActionsTarget,
        intent_id: &str,
        run_id: &str,
    ) -> Result<Option<Vec<u8>>, ProviderAdapterError> {
        if !valid_run_id(run_id) {
            return Err(ProviderAdapterError::NotSent(
                "provider run ID is malformed".into(),
            ));
        }
        let url = format!(
            "{GITHUB_API_BASE}/repos/{}/{}/actions/runs/{run_id}",
            target.owner, target.repo
        );
        let response = self.request("GET", &url, None)?;
        if response.status != 200 {
            return Err(ProviderAdapterError::Ambiguous(format!(
                "GitHub run evidence lookup returned HTTP {}",
                response.status
            )));
        }
        let run: Value = serde_json::from_slice(&response.body).map_err(|error| {
            ProviderAdapterError::Ambiguous(format!("GitHub run evidence JSON invalid: {error}"))
        })?;
        if run
            .get("id")
            .map(|value| value.to_string().trim_matches('"').to_owned())
            .as_deref()
            != Some(run_id)
            || !exact_run_match(&run, target, intent_id)
            || run.get("status").and_then(Value::as_str) != Some("completed")
            || run.get("conclusion").and_then(Value::as_str).is_none()
        {
            return Err(ProviderAdapterError::Ambiguous(
                "GitHub run evidence does not match exact immutable intent and terminal state"
                    .into(),
            ));
        }
        Ok(Some(response.body))
    }
}

impl<E: GitHubActionsTransport> GitHubActionsAdapter<E> {
    fn require_v1_account(
        &self,
        subject: &ProviderEffectSubjectV1,
    ) -> Result<(), ProviderAdapterError> {
        if subject.provider_id != "github-actions"
            || self.transport.provider_account_id() != Some(subject.provider_account_id.as_str())
        {
            return Err(ProviderAdapterError::NotSent(
                "GitHub v1 request does not match the configured provider account identity".into(),
            ));
        }
        Ok(())
    }

    fn v1_intent(
        request: &ProviderDispatchRequestV1,
    ) -> Result<ProviderIntentRecord, ProviderAdapterError> {
        request
            .validate()
            .map_err(|error| ProviderAdapterError::NotSent(error.to_string()))?;
        let payload = request
            .payload_value()
            .map_err(|error| ProviderAdapterError::NotSent(error.to_string()))?;
        Ok(ProviderIntentRecord {
            intent_id: request.message_id.clone(),
            request: ProviderIntentRequest {
                workflow_id: request.subject.workflow_id.clone(),
                task_id: request.subject.task_id.clone(),
                attempt: request.subject.attempt,
                provider_id: request.subject.provider_id.clone(),
                idempotency_key: request.subject.idempotency_key.clone(),
                lease_id: request.subject.lease_id.clone(),
                worker_id: request.subject.worker_id.clone(),
                plan_sha256: request.subject.plan_sha256.clone(),
                request_sha256: request.subject.payload_sha256.clone(),
                payload: Some(payload),
            },
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: request.created_at.clone(),
            updated_at: request.created_at.clone(),
        })
    }

    fn v1_observation(
        observation_id: &str,
        intent_id: &str,
        subject: &ProviderEffectSubjectV1,
        outcome: ProviderDispatchOutcomeV1,
        observed_at: &str,
        evidence: Value,
    ) -> Result<ProviderDispatchObservationV1, ProviderAdapterError> {
        let evidence_bytes = serde_json::to_vec(&evidence)
            .map_err(|error| ProviderAdapterError::Ambiguous(error.to_string()))?;
        ProviderDispatchObservationV1::new(
            observation_id,
            intent_id,
            subject.clone(),
            outcome,
            observed_at,
            evidence_bytes,
        )
        .map_err(|error| ProviderAdapterError::Ambiguous(error.to_string()))
    }

    fn v1_run_ref(
        &self,
        subject: &ProviderEffectSubjectV1,
        run_id: String,
        run_url: Option<String>,
    ) -> ProviderRunRefV1 {
        ProviderRunRefV1 {
            provider_id: subject.provider_id.clone(),
            provider_account_id: subject.provider_account_id.clone(),
            provider_run_id: run_id,
            provider_run_url: run_url,
        }
    }
}

impl<E: GitHubActionsTransport> ProviderAdapterV1 for GitHubActionsAdapter<E> {
    fn provider_id_v1(&self) -> &'static str {
        "github-actions"
    }

    fn dispatch_v1(
        &self,
        request: &ProviderDispatchRequestV1,
        observation_id: &str,
        observed_at: &str,
    ) -> Result<ProviderDispatchObservationV1, ProviderAdapterError> {
        request
            .validate()
            .map_err(|error| ProviderAdapterError::NotSent(error.to_string()))?;
        self.require_v1_account(&request.subject)?;
        let payload = request
            .payload_value()
            .map_err(|error| ProviderAdapterError::NotSent(error.to_string()))?;
        if contains_secret_material(&payload) {
            return Err(ProviderAdapterError::NotSent(
                "GitHub provider payload must not embed credentials or secret material".into(),
            ));
        }
        let target = parse_target(&payload, &request.subject.idempotency_key)?;

        // Preflight lookup must prove exact absence before the single POST.
        let preflight = match self
            .transport
            .lookup_run(&target, &request.subject.idempotency_key)
        {
            Ok(value) => value,
            Err(error) => {
                return Self::v1_observation(
                    observation_id,
                    &request.message_id,
                    &request.subject,
                    ProviderDispatchOutcomeV1::NotSent {
                        reason: error.to_string(),
                        evidence: ProviderNotSentEvidenceV1::PreSend {
                            boundary: "github-actions preflight lookup failed before POST".into(),
                        },
                    },
                    observed_at,
                    serde_json::json!({"phase":"preflight","error":error.to_string()}),
                );
            }
        };
        match preflight {
            GitHubActionsLookup::Found {
                run_id, run_url, ..
            } if valid_run_id(&run_id) => {
                let run = self.v1_run_ref(&request.subject, run_id, run_url);
                return Self::v1_observation(
                    observation_id,
                    &request.message_id,
                    &request.subject,
                    ProviderDispatchOutcomeV1::Accepted { run },
                    observed_at,
                    serde_json::json!({"phase":"preflight","status":"exact_run_already_exists"}),
                );
            }
            GitHubActionsLookup::NotFound {
                complete: true,
                pages_scanned,
            } if pages_scanned > 0 => {}
            GitHubActionsLookup::Found { .. } => {
                return Self::v1_observation(
                    observation_id,
                    &request.message_id,
                    &request.subject,
                    ProviderDispatchOutcomeV1::Unknown {
                        diagnostic: "GitHub preflight returned a malformed run identity".into(),
                    },
                    observed_at,
                    serde_json::json!({"phase":"preflight","status":"malformed_run"}),
                );
            }
            other => {
                return Self::v1_observation(
                    observation_id,
                    &request.message_id,
                    &request.subject,
                    ProviderDispatchOutcomeV1::NotSent {
                        reason: "GitHub preflight did not establish complete absence; POST was not attempted".into(),
                        evidence: ProviderNotSentEvidenceV1::PreSend {
                            boundary: "github-actions preflight did not prove absence".into(),
                        },
                    },
                    observed_at,
                    serde_json::json!({"phase":"preflight","result":format!("{other:?}")}),
                );
            }
        }

        let dispatch = self.transport.dispatch_workflow(&target);
        let (outcome, phase_evidence) = match dispatch {
            Ok(GitHubActionsDispatch::Rejected {
                reason_code,
                diagnostic,
            }) => (
                ProviderDispatchOutcomeV1::Rejected {
                    reason_code,
                    diagnostic,
                },
                serde_json::json!({"phase":"dispatch","status":"rejected"}),
            ),
            Err(ProviderAdapterError::NotSent(diagnostic)) => (
                ProviderDispatchOutcomeV1::NotSent {
                    reason: diagnostic.clone(),
                    evidence: ProviderNotSentEvidenceV1::PreSend {
                        boundary: "github-actions transport proved POST was not sent".into(),
                    },
                },
                serde_json::json!({"phase":"dispatch","status":"not_sent","diagnostic":diagnostic}),
            ),
            Err(ProviderAdapterError::Ambiguous(diagnostic)) => (
                ProviderDispatchOutcomeV1::Unknown {
                    diagnostic: diagnostic.clone(),
                },
                serde_json::json!({"phase":"dispatch","status":"unknown","diagnostic":diagnostic}),
            ),
            Ok(GitHubActionsDispatch::Accepted) => {
                // One postflight lookup is observation only. Never send a second POST.
                let postflight = self
                    .transport
                    .lookup_run(&target, &request.subject.idempotency_key);
                match postflight {
                    Ok(GitHubActionsLookup::Found {
                        run_id,
                        run_url,
                        ..
                    }) if valid_run_id(&run_id) => (
                        ProviderDispatchOutcomeV1::Accepted {
                            run: self.v1_run_ref(&request.subject, run_id, run_url),
                        },
                        serde_json::json!({"phase":"postflight","status":"exact_run_found"}),
                    ),
                    Ok(other) => (
                        ProviderDispatchOutcomeV1::Unknown {
                            diagnostic: "GitHub accepted workflow_dispatch but exact run identity is not yet observable; replay is forbidden".into(),
                        },
                        serde_json::json!({"phase":"postflight","result":format!("{other:?}")}),
                    ),
                    Err(error) => (
                        ProviderDispatchOutcomeV1::Unknown {
                            diagnostic: format!("GitHub accepted workflow_dispatch; postflight lookup failed: {error}"),
                        },
                        serde_json::json!({"phase":"postflight","error":error.to_string()}),
                    ),
                }
            }
        };
        Self::v1_observation(
            observation_id,
            &request.message_id,
            &request.subject,
            outcome,
            observed_at,
            serde_json::json!({"provider":"github-actions","dispatch":phase_evidence}),
        )
    }

    fn lookup_v1(
        &self,
        request: &ProviderDispatchRequestV1,
        observation_id: &str,
        observed_at: &str,
    ) -> Result<ProviderDispatchObservationV1, ProviderAdapterError> {
        request
            .validate()
            .map_err(|error| ProviderAdapterError::NotSent(error.to_string()))?;
        self.require_v1_account(&request.subject)?;
        let intent = Self::v1_intent(request)?;
        let lookup = ProviderAdapter::lookup(self, &intent)?;
        let outcome = match &lookup {
            ProviderLookupResponse::Found {
                outcome: ProviderDispatchResponse::Accepted { provider_run_id },
                run_url,
                ..
            } => ProviderDispatchOutcomeV1::Accepted {
                run: self.v1_run_ref(&request.subject, provider_run_id.clone(), run_url.clone()),
            },
            ProviderLookupResponse::Found {
                outcome:
                    ProviderDispatchResponse::Rejected {
                        reason_code,
                        diagnostic,
                    },
                ..
            } => ProviderDispatchOutcomeV1::Rejected {
                reason_code: reason_code.clone(),
                diagnostic: diagnostic.clone(),
            },
            ProviderLookupResponse::NotFound {
                authoritative: true,
                pages_scanned,
                query_scope,
            } if *pages_scanned > 0 => ProviderDispatchOutcomeV1::NotSent {
                reason: "complete exact-account lookup established no provider run".into(),
                evidence: ProviderNotSentEvidenceV1::AuthoritativeAbsence {
                    query_scope: query_scope.clone(),
                    pages_scanned: *pages_scanned,
                },
            },
            ProviderLookupResponse::NotFound { .. } => ProviderDispatchOutcomeV1::Unknown {
                diagnostic: "provider lookup did not prove complete authoritative absence".into(),
            },
            ProviderLookupResponse::Found {
                outcome: ProviderDispatchResponse::Unknown { diagnostic },
                ..
            }
            | ProviderLookupResponse::Unknown { diagnostic } => {
                ProviderDispatchOutcomeV1::Unknown {
                    diagnostic: diagnostic.clone(),
                }
            }
        };
        let evidence = serde_json::to_value(&lookup)
            .map_err(|error| ProviderAdapterError::Ambiguous(error.to_string()))?;
        Self::v1_observation(
            observation_id,
            &request.message_id,
            &request.subject,
            outcome,
            observed_at,
            evidence,
        )
    }

    fn collect_terminal_proof_v1(
        &self,
        request: &ProviderDispatchRequestV1,
        run: &ProviderRunRefV1,
        proof_id: &str,
        observed_at: &str,
    ) -> Result<Option<ProviderTerminalProofV1>, ProviderAdapterError> {
        request
            .validate()
            .map_err(|error| ProviderAdapterError::NotSent(error.to_string()))?;
        self.require_v1_account(&request.subject)?;
        run.validate_against(&request.subject)
            .map_err(|error| ProviderAdapterError::NotSent(error.to_string()))?;
        let intent = Self::v1_intent(request)?;
        let Some(artifact) =
            ProviderAdapter::collect_terminal_result(self, &intent, &run.provider_run_id)?
        else {
            return Ok(None);
        };
        if artifact.provider_run_id != run.provider_run_id {
            return Err(ProviderAdapterError::Ambiguous(
                "GitHub terminal artifact is not bound to the requested provider run".into(),
            ));
        }
        let completed_at = serde_json::from_slice::<Value>(&artifact.bytes)
            .ok()
            .and_then(|value| {
                value
                    .get("completed_at")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        let proof = ProviderTerminalProofV1 {
            schema_version: crate::PROVIDER_EFFECT_CONTRACT_V1,
            proof_id: proof_id.into(),
            subject: request.subject.clone(),
            run: run.clone(),
            provider_status: artifact.status,
            provider_conclusion: artifact.conclusion,
            completed_at,
            observed_at: observed_at.into(),
            media_type: artifact.media_type,
            response_sha256: sha256_raw(&artifact.bytes),
            response_bytes: artifact.bytes,
        };
        proof
            .validate_against(request, run)
            .map_err(|error| ProviderAdapterError::Ambiguous(error.to_string()))?;
        Ok(Some(proof))
    }
}

fn sha256_raw(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

fn exact_run_match(run: &Value, target: &GitHubActionsTarget, intent_id: &str) -> bool {
    let expected_path = if target.workflow.starts_with(".github/workflows/") {
        target.workflow.clone()
    } else {
        format!(".github/workflows/{}", target.workflow)
    };
    let expected_branch = target
        .git_ref
        .strip_prefix("refs/heads/")
        .unwrap_or(&target.git_ref);
    let repository = run
        .get("repository")
        .and_then(|value| value.get("full_name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let path = run
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split('@')
        .next()
        .unwrap_or_default();
    let branch = run
        .get("head_branch")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let head_sha = run
        .get("head_sha")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let expected_title = format!("P3 worker {intent_id}");
    let expected_commit = target
        .inputs
        .get("input_commit")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let run_attempt = run
        .get("run_attempt")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let status = run
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let conclusion = run.get("conclusion");
    let valid_status = matches!(
        status,
        "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending"
    );
    let valid_conclusion = match (status, conclusion) {
        ("completed", Some(value)) => value.as_str().is_some_and(|value| {
            matches!(
                value,
                "success"
                    | "failure"
                    | "neutral"
                    | "cancelled"
                    | "skipped"
                    | "timed_out"
                    | "action_required"
                    | "stale"
                    | "startup_failure"
            )
        }),
        ("completed", None) => false,
        (_, Some(value)) => value.is_null(),
        (_, None) => true,
    };
    repository.eq_ignore_ascii_case(&format!("{}/{}", target.owner, target.repo))
        && path == expected_path
        && run.get("event").and_then(Value::as_str) == Some("workflow_dispatch")
        && run.get("display_title").and_then(Value::as_str) == Some(expected_title.as_str())
        && valid_status
        && valid_conclusion
        && run_attempt > 0
        && ((target.git_ref.len() == 40
            && target.git_ref.bytes().all(|byte| byte.is_ascii_hexdigit())
            && head_sha.eq_ignore_ascii_case(&target.git_ref))
            || branch == expected_branch)
        && expected_commit.len() == 40
        && expected_commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        && head_sha.eq_ignore_ascii_case(expected_commit)
}

fn percent_encode_query(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn percent_encode_path(value: &str) -> String {
    value
        .split('/')
        .map(percent_encode_query)
        .collect::<Vec<_>>()
        .join("/")
}

/// GitHub Actions adapter with preflight idempotency lookup and post-dispatch reconciliation.
pub struct GitHubActionsAdapter<T> {
    transport: T,
}

impl<T> GitHubActionsAdapter<T> {
    /// Construct adapter with an explicitly injected transport.
    #[must_use]
    pub fn new(transport: T) -> Self {
        Self { transport }
    }
}

impl<T: GitHubActionsTransport> ProviderAdapter for GitHubActionsAdapter<T> {
    fn provider_id(&self) -> &'static str {
        "github-actions"
    }

    fn dispatch(
        &self,
        request: &ProviderDispatchRequest,
    ) -> Result<ProviderDispatchResponse, ProviderAdapterError> {
        if request.provider_id != self.provider_id() {
            return Err(ProviderAdapterError::NotSent(
                "provider_id does not match GitHub Actions adapter".into(),
            ));
        }
        validate_payload(&request.payload, &request.request_sha256)?;
        if contains_secret_material(&request.payload) {
            return Err(ProviderAdapterError::NotSent(
                "provider payload must not embed credentials or secret material".into(),
            ));
        }
        let target = parse_target(&request.payload, &request.idempotency_key)?;

        // Never dispatch unless the exact idempotency lookup proves absence.
        match self
            .transport
            .lookup_run(&target, &request.idempotency_key)?
        {
            GitHubActionsLookup::Found { run_id, .. } if valid_run_id(&run_id) => {
                return Ok(ProviderDispatchResponse::Accepted {
                    provider_run_id: run_id,
                });
            }
            GitHubActionsLookup::Found { .. } => {
                return Ok(ProviderDispatchResponse::Unknown {
                    diagnostic: "GitHub preflight lookup returned malformed run ID".into(),
                });
            }
            GitHubActionsLookup::NotFound {
                complete: false, ..
            }
            | GitHubActionsLookup::Unknown { .. } => {
                return Ok(ProviderDispatchResponse::Unknown {
                    diagnostic: "pre-dispatch lookup did not establish authoritative absence; no dispatch sent".into(),
                });
            }
            GitHubActionsLookup::NotFound {
                complete: true,
                pages_scanned: 0,
            } => {
                return Ok(ProviderDispatchResponse::Unknown {
                    diagnostic: "provider claimed complete absence without scanning any pages; no dispatch sent".into(),
                });
            }
            GitHubActionsLookup::NotFound { complete: true, .. } => {}
        }

        match self.transport.dispatch_workflow(&target) {
            Ok(GitHubActionsDispatch::Rejected {
                reason_code,
                diagnostic,
            }) => Ok(ProviderDispatchResponse::Rejected {
                reason_code,
                diagnostic,
            }),
            Err(ProviderAdapterError::NotSent(diagnostic)) => {
                Ok(ProviderDispatchResponse::Rejected {
                    reason_code: "NOT_SENT".into(),
                    diagnostic,
                })
            }
            Err(ProviderAdapterError::Ambiguous(diagnostic)) => {
                Ok(ProviderDispatchResponse::Unknown { diagnostic })
            }
            Ok(GitHubActionsDispatch::Accepted) => {
                // GitHub's dispatch endpoint may acknowledge before a run is
                // visible. One lookup is evidence collection, never a replay.
                match self
                    .transport
                    .lookup_run(&target, &request.idempotency_key)
                {
                    Ok(GitHubActionsLookup::Found { run_id, .. }) if valid_run_id(&run_id) => {
                        Ok(ProviderDispatchResponse::Accepted {
                            provider_run_id: run_id,
                        })
                    }
                    Ok(GitHubActionsLookup::Found { .. }) => {
                        Ok(ProviderDispatchResponse::Unknown {
                            diagnostic: "GitHub postflight lookup returned malformed run ID".into(),
                        })
                    }
                    Ok(GitHubActionsLookup::NotFound { .. })
                    | Ok(GitHubActionsLookup::Unknown { .. })
                    | Err(ProviderAdapterError::NotSent(_))
                    | Err(ProviderAdapterError::Ambiguous(_)) => {
                        Ok(ProviderDispatchResponse::Unknown {
                            diagnostic: "GitHub accepted workflow_dispatch but no exact run identity is yet observable; no replay attempted".into(),
                        })
                    }
                }
            }
        }
    }

    fn lookup(
        &self,
        intent: &ProviderIntentRecord,
    ) -> Result<ProviderLookupResponse, ProviderAdapterError> {
        if intent.request.provider_id != self.provider_id() {
            return Ok(ProviderLookupResponse::Unknown {
                diagnostic: "persisted provider_id does not match GitHub Actions adapter".into(),
            });
        }
        let Some(payload) = intent.request.payload.as_ref() else {
            return Ok(ProviderLookupResponse::Unknown {
                diagnostic: "legacy provider intent has no exact persisted payload".into(),
            });
        };
        validate_payload(payload, &intent.request.request_sha256)?;
        if contains_secret_material(payload) {
            return Ok(ProviderLookupResponse::Unknown {
                diagnostic: "persisted provider payload contains disallowed secret material".into(),
            });
        }
        let target = match parse_target(payload, &intent.request.idempotency_key) {
            Ok(target) => target,
            Err(error) => {
                return Ok(ProviderLookupResponse::Unknown {
                    diagnostic: error.to_string(),
                });
            }
        };
        match self
            .transport
            .lookup_run(&target, &intent.request.idempotency_key)?
        {
            GitHubActionsLookup::Found {
                run_id,
                status,
                conclusion,
                run_url,
            } => {
                if !valid_run_id(&run_id)
                    || !valid_status(&status)
                    || conclusion
                        .as_deref()
                        .is_some_and(|value| !valid_status(value))
                    || run_url
                        .as_deref()
                        .is_some_and(|value| !valid_https_url(value))
                {
                    return Ok(ProviderLookupResponse::Unknown {
                        diagnostic: "GitHub returned malformed run identity or status".into(),
                    });
                }
                Ok(ProviderLookupResponse::Found {
                    outcome: ProviderDispatchResponse::Accepted {
                        provider_run_id: run_id,
                    },
                    provider_status: Some(status),
                    conclusion,
                    run_url,
                })
            }
            GitHubActionsLookup::NotFound {
                pages_scanned,
                complete: true,
            } if pages_scanned > 0 => Ok(ProviderLookupResponse::NotFound {
                authoritative: true,
                pages_scanned,
                query_scope: query_scope(&target),
            }),
            GitHubActionsLookup::NotFound { .. } => Ok(ProviderLookupResponse::Unknown {
                diagnostic: "GitHub lookup did not exhaust the exact repository/workflow/ref scope"
                    .into(),
            }),
            GitHubActionsLookup::Unknown { diagnostic } => {
                Ok(ProviderLookupResponse::Unknown { diagnostic })
            }
        }
    }

    fn collect_terminal_result(
        &self,
        intent: &ProviderIntentRecord,
        provider_run_id: &str,
    ) -> Result<Option<crate::ProviderTerminalArtifact>, ProviderAdapterError> {
        if intent.request.provider_id != self.provider_id() {
            return Err(ProviderAdapterError::NotSent(
                "provider intent does not belong to GitHub Actions".into(),
            ));
        }
        let Some(payload) = intent.request.payload.as_ref() else {
            return Ok(None);
        };
        validate_payload(payload, &intent.request.request_sha256)?;
        let target = parse_target(payload, &intent.request.idempotency_key)?;
        let Some(bytes) = self.transport.collect_run_details(
            &target,
            &intent.request.idempotency_key,
            provider_run_id,
        )?
        else {
            return Ok(None);
        };
        let run: Value = serde_json::from_slice(&bytes).map_err(|error| {
            ProviderAdapterError::Ambiguous(format!("terminal run evidence JSON invalid: {error}"))
        })?;
        let status = run
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let conclusion = run
            .get("conclusion")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        Ok(Some(crate::ProviderTerminalArtifact {
            provider_run_id: provider_run_id.into(),
            status,
            conclusion,
            bytes,
            media_type: "application/json".into(),
        }))
    }
}

fn parse_target(
    payload: &Value,
    idempotency_key: &str,
) -> Result<GitHubActionsTarget, ProviderAdapterError> {
    let target: GitHubActionsTarget = serde_json::from_value(payload.clone())
        .map_err(|error| ProviderAdapterError::NotSent(error.to_string()))?;
    if !valid_slug(&target.owner, 100)
        || !valid_slug(&target.repo, 100)
        || !valid_workflow_path(&target.workflow)
        || !valid_ref(&target.git_ref)
        || !target.inputs.is_object()
        || target
            .inputs
            .get("runalith_intent_id")
            .and_then(Value::as_str)
            != Some(idempotency_key)
        || target
            .inputs
            .get("input_commit")
            .and_then(Value::as_str)
            .is_none_or(|commit| {
                commit.len() != 40 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
    {
        return Err(ProviderAdapterError::NotSent(
            "GitHub payload must bind owner/repo/workflow/ref and inputs.runalith_intent_id to the exact intent".into(),
        ));
    }
    Ok(target)
}

fn query_scope(target: &GitHubActionsTarget) -> String {
    format!(
        "{}/{}/{}@{}",
        target.owner, target.repo, target.workflow, target.git_ref
    )
}

fn valid_slug(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && value != "."
        && value != ".."
}

fn valid_workflow_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.starts_with('/')
        && !value.contains('\\')
        && value.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
}

fn valid_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.starts_with('-')
        && !value.ends_with('/')
        && !value.contains("..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
}

fn valid_run_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_status(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
}

fn valid_https_url(value: &str) -> bool {
    value.starts_with("https://") && value.len() <= 2_048 && !value.chars().any(char::is_whitespace)
}

fn contains_secret_material(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
            [
                "token",
                "secret",
                "password",
                "credential",
                "privatekey",
                "authorization",
            ]
            .iter()
            .any(|needle| normalized.contains(needle))
                || contains_secret_material(value)
        }),
        Value::Array(values) => values.iter().any(contains_secret_material),
        Value::String(text) => ["ghp_", "ghs_", "github_pat_", "xoxb-", "xoxp-", "Bearer "]
            .iter()
            .any(|prefix| text.contains(prefix)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::Mutex,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use runalith_domain::content_hash;
    use runalith_execution_persistence::{
        ProviderDispatchState, ProviderIntentOutcome, ProviderIntentRequest,
    };
    use serde_json::json;

    use super::*;

    type RecordedHttpRequest = (String, String, Option<Vec<u8>>);

    struct MockTransport {
        lookups: Mutex<VecDeque<GitHubActionsLookup>>,
        dispatch_result: Mutex<Result<GitHubActionsDispatch, ProviderAdapterError>>,
        dispatch_count: AtomicUsize,
    }

    struct MockHttpExecutor {
        responses: Mutex<VecDeque<Result<GitHubHttpResponse, ProviderAdapterError>>>,
        requests: Mutex<Vec<RecordedHttpRequest>>,
    }

    impl MockHttpExecutor {
        fn new(
            responses: impl IntoIterator<Item = Result<GitHubHttpResponse, ProviderAdapterError>>,
        ) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl GitHubHttpExecutor for MockHttpExecutor {
        fn execute(
            &self,
            method: &str,
            url: &str,
            _bearer_token: &str,
            body: Option<&[u8]>,
        ) -> Result<GitHubHttpResponse, ProviderAdapterError> {
            self.requests.lock().unwrap().push((
                method.into(),
                url.into(),
                body.map(ToOwned::to_owned),
            ));
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| {
                    Err(ProviderAdapterError::Ambiguous(
                        "mock HTTP response queue exhausted".into(),
                    ))
                })
        }
    }

    impl MockTransport {
        fn new(
            lookups: impl IntoIterator<Item = GitHubActionsLookup>,
            dispatch_result: Result<GitHubActionsDispatch, ProviderAdapterError>,
        ) -> Self {
            Self {
                lookups: Mutex::new(lookups.into_iter().collect()),
                dispatch_result: Mutex::new(dispatch_result),
                dispatch_count: AtomicUsize::new(0),
            }
        }
    }

    impl GitHubActionsTransport for MockTransport {
        fn provider_account_id(&self) -> Option<&str> {
            Some("gha-installation:test")
        }

        fn lookup_run(
            &self,
            _target: &GitHubActionsTarget,
            _runalith_intent_id: &str,
        ) -> Result<GitHubActionsLookup, ProviderAdapterError> {
            Ok(self.lookups.lock().unwrap().pop_front().unwrap_or_else(|| {
                GitHubActionsLookup::Unknown {
                    diagnostic: "no scripted lookup result".into(),
                }
            }))
        }

        fn dispatch_workflow(
            &self,
            _target: &GitHubActionsTarget,
        ) -> Result<GitHubActionsDispatch, ProviderAdapterError> {
            self.dispatch_count.fetch_add(1, Ordering::SeqCst);
            match &*self.dispatch_result.lock().unwrap() {
                Ok(result) => Ok(result.clone()),
                Err(ProviderAdapterError::NotSent(message)) => {
                    Err(ProviderAdapterError::NotSent(message.clone()))
                }
                Err(ProviderAdapterError::Ambiguous(message)) => {
                    Err(ProviderAdapterError::Ambiguous(message.clone()))
                }
            }
        }
    }

    fn request() -> ProviderDispatchRequest {
        let idempotency_key = "runalith-intent-1".to_owned();
        let payload = json!({
            "owner":"openai",
            "repo":"runalith-worker",
            "workflow":".github/workflows/worker.yml",
            "ref":"main",
            "inputs":{"runalith_intent_id":idempotency_key,"task_id":"task-1","input_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        });
        ProviderDispatchRequest {
            provider_id: "github-actions".into(),
            idempotency_key,
            workflow_id: "workflow-1".into(),
            task_id: "task-1".into(),
            attempt: 1,
            lease_id: "lease-1".into(),
            worker_id: "worker-1".into(),
            plan_sha256: "a".repeat(64),
            request_sha256: content_hash(&payload).unwrap(),
            payload,
        }
    }

    fn request_v1() -> ProviderDispatchRequestV1 {
        let legacy = request();
        let payload_bytes = serde_json::to_vec(&legacy.payload).unwrap();
        let side_effect_id = "intent-1";
        let control_identity = json!({
            "claim_id":"claim-1",
            "lease_id":legacy.lease_id,
            "owner_epoch":3,
            "kind":"provider_dispatch",
            "side_effect_id":side_effect_id
        });
        let control_fence = crate::ProviderControlFenceV1::from_reservation(
            "provider-fence-1",
            "claim-1",
            legacy.lease_id.clone(),
            legacy.worker_id.clone(),
            3,
            legacy.plan_sha256.clone(),
            side_effect_id,
            content_hash(&legacy).unwrap(),
            format!("worker-fence:{}", content_hash(&control_identity).unwrap()),
            "b".repeat(64),
            &json!({"reservation_id":"provider-fence-1"}),
        )
        .unwrap();
        let request = ProviderDispatchRequestV1 {
            schema_version: crate::PROVIDER_EFFECT_CONTRACT_V1,
            message_id: "intent-1".into(),
            producer_id: "worker-service".into(),
            correlation_id: legacy.workflow_id.clone(),
            created_at: "2026-11-03T10:00:00Z".into(),
            subject: crate::ProviderEffectSubjectV1 {
                provider_id: legacy.provider_id,
                provider_account_id: "gha-installation:test".into(),
                workflow_id: legacy.workflow_id,
                task_id: legacy.task_id,
                claim_id: "claim-1".into(),
                owner_epoch: 3,
                attempt: legacy.attempt,
                lease_id: legacy.lease_id,
                worker_id: legacy.worker_id,
                plan_sha256: legacy.plan_sha256,
                idempotency_key: legacy.idempotency_key,
                payload_sha256: legacy.request_sha256,
                control_fence,
            },
            payload_bytes,
        };
        request.validate().unwrap();
        request
    }

    fn intent(payload: Option<Value>) -> ProviderIntentRecord {
        let request = request();
        ProviderIntentRecord {
            intent_id: "intent-1".into(),
            request: ProviderIntentRequest {
                workflow_id: request.workflow_id,
                task_id: request.task_id,
                attempt: request.attempt,
                provider_id: request.provider_id,
                idempotency_key: request.idempotency_key,
                lease_id: request.lease_id,
                worker_id: request.worker_id,
                plan_sha256: request.plan_sha256,
                request_sha256: request.request_sha256,
                payload,
            },
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None::<ProviderIntentOutcome>,
            created_at: "2026-11-01T00:00:00Z".into(),
            updated_at: "2026-11-01T00:00:00Z".into(),
        }
    }

    fn found() -> GitHubActionsLookup {
        GitHubActionsLookup::Found {
            run_id: "123456".into(),
            status: "queued".into(),
            conclusion: None,
            run_url: Some("https://github.com/openai/runalith-worker/actions/runs/123456".into()),
        }
    }

    fn http_response(
        status: u16,
        value: Value,
    ) -> Result<GitHubHttpResponse, ProviderAdapterError> {
        Ok(GitHubHttpResponse {
            status,
            body: serde_json::to_vec(&value).unwrap(),
        })
    }

    #[test]
    fn v1_dispatch_classifies_preflight_incompleteness_as_not_sent_without_post() {
        let transport = MockTransport::new(
            [GitHubActionsLookup::NotFound {
                pages_scanned: 1,
                complete: false,
            }],
            Ok(GitHubActionsDispatch::Accepted),
        );
        let adapter = GitHubActionsAdapter::new(transport);
        let observation = adapter
            .dispatch_v1(
                &request_v1(),
                "observation-preflight",
                "2026-11-03T10:01:00Z",
            )
            .unwrap();
        assert!(matches!(
            observation.outcome,
            crate::ProviderDispatchOutcomeV1::NotSent {
                evidence: crate::ProviderNotSentEvidenceV1::PreSend { .. },
                ..
            }
        ));
        assert_eq!(adapter.transport.dispatch_count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn v1_dispatch_keeps_ambiguous_post_unknown_and_never_replays() {
        let transport = MockTransport::new(
            [GitHubActionsLookup::NotFound {
                pages_scanned: 2,
                complete: true,
            }],
            Err(ProviderAdapterError::Ambiguous(
                "connection reset after request write".into(),
            )),
        );
        let adapter = GitHubActionsAdapter::new(transport);
        let observation = adapter
            .dispatch_v1(&request_v1(), "observation-unknown", "2026-11-03T10:02:00Z")
            .unwrap();
        assert!(matches!(
            observation.outcome,
            crate::ProviderDispatchOutcomeV1::Unknown { .. }
        ));
        assert_eq!(adapter.transport.dispatch_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn v1_dispatch_fails_closed_when_configured_account_identity_differs() {
        let transport = MockTransport::new(
            [GitHubActionsLookup::NotFound {
                pages_scanned: 2,
                complete: true,
            }],
            Ok(GitHubActionsDispatch::Accepted),
        );
        let adapter = GitHubActionsAdapter::new(transport);
        let mut request = request_v1();
        request.subject.provider_account_id = "gha-installation:another".into();
        assert!(matches!(
            adapter.dispatch_v1(
                &request,
                "observation-account-mismatch",
                "2026-11-03T10:03:00Z"
            ),
            Err(ProviderAdapterError::NotSent(_))
        ));
        assert_eq!(adapter.transport.dispatch_count.load(Ordering::SeqCst), 0);
        assert_eq!(adapter.transport.lookups.lock().unwrap().len(), 1);
    }

    #[test]
    fn v1_lookup_emits_not_sent_only_after_complete_authoritative_absence() {
        let transport = MockTransport::new(
            [GitHubActionsLookup::NotFound {
                pages_scanned: 3,
                complete: true,
            }],
            Ok(GitHubActionsDispatch::Accepted),
        );
        let adapter = GitHubActionsAdapter::new(transport);
        let request = request_v1();
        let observation = adapter
            .lookup_v1(
                &request,
                "observation-authoritative-absence",
                "2026-11-03T10:03:30Z",
            )
            .unwrap();
        assert!(matches!(
            observation.outcome,
            crate::ProviderDispatchOutcomeV1::NotSent {
                evidence: crate::ProviderNotSentEvidenceV1::AuthoritativeAbsence {
                    pages_scanned: 3,
                    ..
                },
                ..
            }
        ));
        assert_eq!(adapter.transport.dispatch_count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn v1_dispatch_without_host_account_identity_fails_before_provider_lookup() {
        let executor = MockHttpExecutor::new(std::iter::empty());
        let adapter = GitHubActionsAdapter::new(
            GitHubActionsHttpTransport::with_executor("ghs_test_token".into(), executor).unwrap(),
        );
        assert!(matches!(
            adapter.dispatch_v1(
                &request_v1(),
                "observation-no-account",
                "2026-11-03T10:03:45Z"
            ),
            Err(ProviderAdapterError::NotSent(_))
        ));
        assert!(
            adapter
                .transport
                .executor
                .requests
                .lock()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn v1_terminal_proof_contains_exact_authenticated_run_response_bytes() {
        let mut terminal_run = exact_http_run();
        terminal_run["status"] = json!("completed");
        terminal_run["conclusion"] = json!("success");
        terminal_run["completed_at"] = json!("2026-11-03T10:04:00Z");
        let executor = MockHttpExecutor::new([http_response(200, terminal_run)]);
        let adapter = GitHubActionsAdapter::new(
            GitHubActionsHttpTransport::with_executor_for_account(
                "ghs_test_token".into(),
                "gha-installation:test",
                executor,
            )
            .unwrap(),
        );
        let request = request_v1();
        let run = ProviderRunRefV1 {
            provider_id: "github-actions".into(),
            provider_account_id: "gha-installation:test".into(),
            provider_run_id: "123456".into(),
            provider_run_url: Some(
                "https://github.com/openai/runalith-worker/actions/runs/123456".into(),
            ),
        };
        let proof = adapter
            .collect_terminal_proof_v1(&request, &run, "proof-terminal-1", "2026-11-03T10:05:00Z")
            .unwrap()
            .unwrap();
        proof.validate_against(&request, &run).unwrap();
        assert_eq!(proof.provider_status, "completed");
        assert_eq!(proof.provider_conclusion, "success");
        assert_eq!(proof.completed_at.as_deref(), Some("2026-11-03T10:04:00Z"));
        assert_eq!(proof.response_sha256, sha256_raw(&proof.response_bytes));
        assert_eq!(adapter.transport.executor.requests.lock().unwrap().len(), 1);
    }

    fn exact_http_run() -> Value {
        json!({
            "id":123456,"status":"queued","conclusion":null,
            "html_url":"https://github.com/openai/runalith-worker/actions/runs/123456",
            "display_title":"P3 worker runalith-intent-1",
            "repository":{"full_name":"openai/runalith-worker"},
            "path":".github/workflows/worker.yml@refs/heads/main",
            "event":"workflow_dispatch","head_branch":"main","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","run_attempt":1
        })
    }

    fn empty_workflow_runs(total_count: u64, runs: Vec<Value>) -> Value {
        json!({"total_count":total_count,"workflow_runs":runs})
    }

    #[test]
    fn authenticated_http_transport_scans_every_page_and_matches_exact_intent_scope() {
        let first = (0..100)
            .map(|index| json!({"id":index+1,"display_title":"other run"}))
            .collect::<Vec<_>>();
        let executor = MockHttpExecutor::new([
            http_response(200, empty_workflow_runs(101, first)),
            http_response(200, empty_workflow_runs(101, vec![exact_http_run()])),
        ]);
        let transport =
            GitHubActionsHttpTransport::with_executor("ghs_test_token".into(), executor).unwrap();
        let result = transport
            .lookup_run(
                &parse_target(&request().payload, &request().idempotency_key).unwrap(),
                "runalith-intent-1",
            )
            .unwrap();
        assert_eq!(
            result,
            GitHubActionsLookup::Found {
                run_id: "123456".into(),
                status: "queued".into(),
                conclusion: None,
                run_url: Some(
                    "https://github.com/openai/runalith-worker/actions/runs/123456".into()
                )
            }
        );
        let requests = transport.executor.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].1.contains("page=1"));
        assert!(requests[1].1.contains("page=2"));
        assert!(
            requests
                .iter()
                .all(|request| request.0 == "GET" && request.2.is_none())
        );
    }

    #[test]
    fn authenticated_http_dispatch_is_one_post_with_exact_postflight_lookup() {
        let executor = MockHttpExecutor::new([
            http_response(200, empty_workflow_runs(0, vec![])),
            http_response(204, Value::Null),
            http_response(200, empty_workflow_runs(1, vec![exact_http_run()])),
        ]);
        let transport =
            GitHubActionsHttpTransport::with_executor("ghs_test_token".into(), executor).unwrap();
        let adapter = GitHubActionsAdapter::new(transport);
        assert_eq!(
            adapter.dispatch(&request()).unwrap(),
            ProviderDispatchResponse::Accepted {
                provider_run_id: "123456".into()
            }
        );
        let requests = &adapter.transport.executor.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .map(|request| request.0.as_str())
                .collect::<Vec<_>>(),
            vec!["GET", "POST", "GET"]
        );
        let body: Value = serde_json::from_slice(requests[1].2.as_deref().unwrap()).unwrap();
        assert_eq!(body["ref"], "main");
        assert_eq!(body["inputs"]["runalith_intent_id"], "runalith-intent-1");
    }

    #[test]
    fn incomplete_pagination_and_ambiguous_http_dispatch_never_trigger_a_second_post() {
        let full_page = (0..100)
            .map(|index| json!({"id":index+1,"display_title":"not-the-intent"}))
            .collect::<Vec<_>>();
        let executor = MockHttpExecutor::new(
            (0..MAX_LOOKUP_PAGES)
                .map(|_| http_response(200, empty_workflow_runs(1500, full_page.clone()))),
        );
        let adapter = GitHubActionsAdapter::new(
            GitHubActionsHttpTransport::with_executor("ghs_test_token".into(), executor).unwrap(),
        );
        assert!(matches!(
            adapter.dispatch(&request()).unwrap(),
            ProviderDispatchResponse::Unknown { .. }
        ));
        assert_eq!(
            adapter.transport.executor.requests.lock().unwrap().len(),
            MAX_LOOKUP_PAGES as usize
        );

        let executor = MockHttpExecutor::new([
            http_response(200, empty_workflow_runs(0, vec![])),
            Err(ProviderAdapterError::Ambiguous(
                "connection reset after request write".into(),
            )),
        ]);
        let adapter = GitHubActionsAdapter::new(
            GitHubActionsHttpTransport::with_executor("ghs_test_token".into(), executor).unwrap(),
        );
        assert!(matches!(
            adapter.dispatch(&request()).unwrap(),
            ProviderDispatchResponse::Unknown { .. }
        ));
        let requests = adapter.transport.executor.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.0 == "POST")
                .count(),
            1
        );
    }

    #[test]
    fn conflicting_run_with_same_intent_marker_is_not_treated_as_absence() {
        let mut conflict = exact_http_run();
        conflict["head_sha"] = json!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        let executor =
            MockHttpExecutor::new([http_response(200, empty_workflow_runs(1, vec![conflict]))]);
        let adapter = GitHubActionsAdapter::new(
            GitHubActionsHttpTransport::with_executor("ghs_test_token".into(), executor).unwrap(),
        );
        assert!(matches!(
            adapter.dispatch(&request()).unwrap(),
            ProviderDispatchResponse::Unknown { .. }
        ));
        let requests = adapter.transport.executor.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests.iter().all(|request| request.0 == "GET"));
    }

    #[test]
    fn concrete_transport_rejects_bad_token_and_http_rejections_are_classified() {
        assert!(matches!(
            GitHubActionsHttpTransport::with_executor(
                "bad\ntoken".into(),
                MockHttpExecutor::new(std::iter::empty())
            ),
            Err(ProviderAdapterError::NotSent(_))
        ));
        let executor = MockHttpExecutor::new([
            http_response(200, empty_workflow_runs(0, vec![])),
            http_response(422, json!({"message":"workflow input rejected"})),
        ]);
        let adapter = GitHubActionsAdapter::new(
            GitHubActionsHttpTransport::with_executor("ghs_test_token".into(), executor).unwrap(),
        );
        assert!(
            matches!(adapter.dispatch(&request()).unwrap(),ProviderDispatchResponse::Rejected{reason_code,..} if reason_code=="HTTP_422")
        );
    }

    #[cfg(unix)]
    #[test]
    fn curl_executor_keeps_credentials_out_of_argv_and_bounds_config_to_stdin() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let args_path = directory.path().join("argv.txt");
        let config_path = directory.path().join("config.txt");
        let script_path = directory.path().join("curl-fixture");
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\ncat > '{}'\nprintf '{{\"ok\":true}}\\n200'\n",
            args_path.display(),
            config_path.display()
        );
        std::fs::write(&script_path, script).unwrap();
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let executor = CurlGitHubHttpExecutor::new(&script_path, 15).unwrap();
        let response = executor
            .execute(
                "POST",
                "https://api.github.com/repos/acme/worker/actions/workflows/worker.yml/dispatches",
                "ghs_test_secret_token",
                Some(br#"{"ref":"main"}"#),
            )
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, br#"{"ok":true}"#);
        let args = std::fs::read_to_string(args_path).unwrap();
        assert_eq!(args, "--disable\n--config\n-\n");
        assert!(!args.contains("ghs_test_secret_token"));
        let config = std::fs::read_to_string(config_path).unwrap();
        assert!(config.contains("Authorization: Bearer ghs_test_secret_token"));
        assert!(config.contains("https://api.github.com/repos/acme/worker"));
        assert!(config.contains("{\\\"ref\\\":\\\"main\\\"}"));
    }

    #[cfg(unix)]
    #[test]
    fn curl_executor_terminates_oversized_and_timed_out_processes() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let oversized = directory.path().join("curl-oversized");
        std::fs::write(&oversized, "#!/bin/sh\nhead -c 17000000 /dev/zero\n").unwrap();
        std::fs::set_permissions(&oversized, std::fs::Permissions::from_mode(0o700)).unwrap();
        let executor = CurlGitHubHttpExecutor::new(&oversized, 2).unwrap();
        assert!(
            matches!(executor.execute("POST", "https://api.github.com/test", "token", None), Err(ProviderAdapterError::Ambiguous(message)) if message.contains("bounded output"))
        );

        let timeout = directory.path().join("curl-timeout");
        std::fs::write(&timeout, "#!/bin/sh\nsleep 10\n").unwrap();
        std::fs::set_permissions(&timeout, std::fs::Permissions::from_mode(0o700)).unwrap();
        let executor = CurlGitHubHttpExecutor::new(&timeout, 1).unwrap();
        assert!(
            matches!(executor.execute("POST", "https://api.github.com/test", "token", None), Err(ProviderAdapterError::Ambiguous(message)) if message.contains("transport deadline"))
        );
    }

    #[test]
    fn dispatch_returns_existing_exact_run_without_sending_again() {
        let transport = MockTransport::new([found()], Ok(GitHubActionsDispatch::Accepted));
        let adapter = GitHubActionsAdapter::new(transport);
        assert_eq!(
            adapter.dispatch(&request()).unwrap(),
            ProviderDispatchResponse::Accepted {
                provider_run_id: "123456".into()
            }
        );
        assert_eq!(adapter.transport.dispatch_count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn dispatch_requires_authoritative_complete_absence_and_never_replays_ambiguity() {
        let incomplete = MockTransport::new(
            [GitHubActionsLookup::NotFound {
                pages_scanned: 1,
                complete: false,
            }],
            Ok(GitHubActionsDispatch::Accepted),
        );
        let adapter = GitHubActionsAdapter::new(incomplete);
        assert!(matches!(
            adapter.dispatch(&request()).unwrap(),
            ProviderDispatchResponse::Unknown { .. }
        ));
        assert_eq!(adapter.transport.dispatch_count.load(Ordering::SeqCst), 0);

        let ambiguous = MockTransport::new(
            [GitHubActionsLookup::NotFound {
                pages_scanned: 4,
                complete: true,
            }],
            Err(ProviderAdapterError::Ambiguous(
                "socket closed after send".into(),
            )),
        );
        let adapter = GitHubActionsAdapter::new(ambiguous);
        assert!(matches!(
            adapter.dispatch(&request()).unwrap(),
            ProviderDispatchResponse::Unknown { .. }
        ));
        assert_eq!(adapter.transport.dispatch_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dispatch_uses_one_postflight_lookup_after_provider_acceptance() {
        let transport = MockTransport::new(
            [
                GitHubActionsLookup::NotFound {
                    pages_scanned: 2,
                    complete: true,
                },
                found(),
            ],
            Ok(GitHubActionsDispatch::Accepted),
        );
        let adapter = GitHubActionsAdapter::new(transport);
        assert_eq!(
            adapter.dispatch(&request()).unwrap(),
            ProviderDispatchResponse::Accepted {
                provider_run_id: "123456".into()
            }
        );
        assert_eq!(adapter.transport.dispatch_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn lookup_only_reports_authoritative_absence_after_complete_scope_search() {
        let complete = MockTransport::new(
            [GitHubActionsLookup::NotFound {
                pages_scanned: 5,
                complete: true,
            }],
            Ok(GitHubActionsDispatch::Accepted),
        );
        let adapter = GitHubActionsAdapter::new(complete);
        assert_eq!(
            adapter.lookup(&intent(request().payload.into())).unwrap(),
            ProviderLookupResponse::NotFound {
                authoritative: true,
                pages_scanned: 5,
                query_scope: "openai/runalith-worker/.github/workflows/worker.yml@main".into()
            }
        );

        let incomplete = MockTransport::new(
            [GitHubActionsLookup::NotFound {
                pages_scanned: 1,
                complete: false,
            }],
            Ok(GitHubActionsDispatch::Accepted),
        );
        let adapter = GitHubActionsAdapter::new(incomplete);
        assert!(matches!(
            adapter.lookup(&intent(request().payload.into())).unwrap(),
            ProviderLookupResponse::Unknown { .. }
        ));
    }

    #[test]
    fn legacy_payloadless_intent_never_calls_provider_transport() {
        let transport = MockTransport::new([], Ok(GitHubActionsDispatch::Accepted));
        let adapter = GitHubActionsAdapter::new(transport);
        assert!(matches!(
            adapter.lookup(&intent(None)).unwrap(),
            ProviderLookupResponse::Unknown { .. }
        ));
        assert_eq!(adapter.transport.dispatch_count.load(Ordering::SeqCst), 0);
        assert!(adapter.transport.lookups.lock().unwrap().is_empty());
    }

    #[test]
    fn rejects_wrong_intent_marker_and_embedded_secret_before_transport() {
        let mut invalid = request();
        invalid.payload["inputs"]["runalith_intent_id"] = json!("another-intent");
        invalid.request_sha256 = content_hash(&invalid.payload).unwrap();
        let transport = MockTransport::new([], Ok(GitHubActionsDispatch::Accepted));
        let adapter = GitHubActionsAdapter::new(transport);
        assert!(matches!(
            adapter.dispatch(&invalid).unwrap_err(),
            ProviderAdapterError::NotSent(_)
        ));

        let mut secret = request();
        secret.payload["inputs"]["access_token"] = json!("not-allowed");
        secret.request_sha256 = content_hash(&secret.payload).unwrap();
        assert!(matches!(
            adapter.dispatch(&secret).unwrap_err(),
            ProviderAdapterError::NotSent(_)
        ));
        assert_eq!(adapter.transport.dispatch_count.load(Ordering::SeqCst), 0);
        assert!(adapter.transport.lookups.lock().unwrap().is_empty());
    }
}

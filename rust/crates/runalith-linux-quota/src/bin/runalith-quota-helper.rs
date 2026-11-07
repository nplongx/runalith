//! Systemd socket-activated, narrowly-scoped privileged project quota helper.

use std::{env, path::PathBuf, process::ExitCode};

use runalith_linux_quota::{ProjectQuotaLimits, serve_systemd_quota_helper};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("runalith-quota-helper: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(required("RUNALITH_QUOTA_HELPER_ROOT")?);
    let registry = PathBuf::from(required("RUNALITH_QUOTA_HELPER_REGISTRY")?);
    let worker_uid = required("RUNALITH_QUOTA_HELPER_WORKER_UID")?.parse::<u32>()?;
    let maximum_limits = ProjectQuotaLimits {
        bytes: required("RUNALITH_QUOTA_HELPER_MAX_BYTES")?.parse::<u64>()?,
        inodes: required("RUNALITH_QUOTA_HELPER_MAX_INODES")?.parse::<u64>()?,
    };
    if maximum_limits.bytes < 4096 || maximum_limits.inodes == 0 {
        return Err("helper maximum quota limits are invalid".into());
    }
    serve_systemd_quota_helper(root, registry, worker_uid, maximum_limits)?;
    Ok(())
}

fn required(name: &'static str) -> Result<String, Box<dyn std::error::Error>> {
    env::var(name).map_err(|_| format!("missing required setting {name}").into())
}

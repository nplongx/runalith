//! Private, immutable, content-addressed artifact storage.

/// Versioned public contracts for Execution-owned sessions and artifacts.
pub mod contracts;
/// Versioned read-only artifact observation port; transport authentication is host-owned.
pub mod read_port;
/// Durable session registry, ACL and delivery-receipt adapter.
pub mod sessions;

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const MAX_ARTIFACT_BYTES: usize = 32 * 1024 * 1024;

/// Immutable artifact identity returned by the store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredArtifact {
    /// Content-addressed ID (`sha256:<digest>`).
    pub artifact_id: String,
    /// SHA-256 of exact stored bytes.
    pub sha256: String,
    /// Exact byte count.
    pub byte_len: u64,
    /// Caller-declared media type; not trusted as evidence semantics.
    pub media_type: String,
}

/// Artifact storage or integrity error.
#[derive(Debug, Error)]
pub enum ArtifactError {
    /// Filesystem operation failed.
    #[error("artifact filesystem error: {0}")]
    Io(#[from] std::io::Error),
    /// Invalid path, reference, media type, or size.
    #[error("artifact policy rejected operation: {0}")]
    Policy(String),
    /// Existing content-addressed path did not match its digest.
    #[error("artifact integrity check failed: {0}")]
    Integrity(String),
}

/// Private append-only artifact directory.
pub struct ArtifactStore {
    root: PathBuf,
}

impl ArtifactStore {
    /// Create or open a private non-symlink artifact root.
    pub fn open_or_create(root: impl AsRef<Path>) -> Result<Self, ArtifactError> {
        let root = root.as_ref();
        reject_symlink_components(root)?;
        if !root.exists() {
            fs::create_dir_all(root)?;
        }
        reject_symlink_components(root)?;
        let metadata = fs::symlink_metadata(root)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(ArtifactError::Policy(
                "artifact root must be a regular non-symlink directory".into(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
            if fs::metadata(root)?.permissions().mode() & 0o077 != 0 {
                return Err(ArtifactError::Policy("artifact root is not private".into()));
            }
        }
        Ok(Self {
            root: fs::canonicalize(root)?,
        })
    }

    /// Canonical private artifact-store directory. Callers may place durable
    /// recovery metadata beneath this directory; task sandboxes must never
    /// receive this host path as a writable mount.
    pub fn root_path(&self) -> &Path {
        &self.root
    }

    /// Store bytes once. Repeated writes of identical bytes are idempotent.
    pub fn put(&self, media_type: &str, bytes: &[u8]) -> Result<StoredArtifact, ArtifactError> {
        if bytes.len() > MAX_ARTIFACT_BYTES || !valid_media_type(media_type) {
            return Err(ArtifactError::Policy(
                "artifact size or media type invalid".into(),
            ));
        }
        let sha256 = digest(bytes);
        let directory = self.root.join(&sha256[..2]);
        match fs::create_dir(&directory) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata = fs::symlink_metadata(&directory)?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(ArtifactError::Policy(
                        "artifact shard is not a regular directory".into(),
                    ));
                }
            }
            Err(error) => return Err(ArtifactError::Io(error)),
        }
        let path = directory.join(&sha256);
        let temporary = directory.join(format!(
            ".runalith-artifact-{}.tmp",
            Uuid::new_v4().simple()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temporary) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
                    drop(file);
                    let _ = fs::remove_file(&temporary);
                    return Err(ArtifactError::Io(error));
                }
                drop(file);
                match fs::hard_link(&temporary, &path) {
                    Ok(()) => {
                        sync_directory(&directory)?;
                        fs::remove_file(&temporary)?;
                        sync_directory(&directory)?;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        let existing = self.read_bytes_by_digest(&sha256)?;
                        if existing != bytes {
                            let _ = fs::remove_file(&temporary);
                            return Err(ArtifactError::Integrity(sha256));
                        }
                        fs::remove_file(&temporary)?;
                        sync_directory(&directory)?;
                    }
                    Err(error) => {
                        let _ = fs::remove_file(&temporary);
                        return Err(ArtifactError::Io(error));
                    }
                }
            }
            Err(error) => return Err(ArtifactError::Io(error)),
        }
        Ok(StoredArtifact {
            artifact_id: format!("sha256:{sha256}"),
            sha256,
            byte_len: bytes.len() as u64,
            media_type: media_type.into(),
        })
    }

    /// Read an artifact only after path, size, and digest revalidation.
    pub fn read(&self, artifact: &StoredArtifact) -> Result<Vec<u8>, ArtifactError> {
        if artifact.artifact_id != format!("sha256:{}", artifact.sha256)
            || !valid_digest(&artifact.sha256)
            || artifact.byte_len > MAX_ARTIFACT_BYTES as u64
        {
            return Err(ArtifactError::Policy(
                "artifact reference is malformed".into(),
            ));
        }
        let bytes = self.read_bytes_by_digest(&artifact.sha256)?;
        if bytes.len() as u64 != artifact.byte_len || digest(&bytes) != artifact.sha256 {
            return Err(ArtifactError::Integrity(artifact.artifact_id.clone()));
        }
        Ok(bytes)
    }

    /// Resolve an artifact ID without trusting caller-supplied size or digest metadata.
    pub fn read_by_id(
        &self,
        artifact_id: &str,
        media_type: &str,
    ) -> Result<(StoredArtifact, Vec<u8>), ArtifactError> {
        let sha256 = artifact_id
            .strip_prefix("sha256:")
            .ok_or_else(|| ArtifactError::Policy("artifact ID must use sha256 scheme".into()))?;
        if !valid_digest(sha256) || !valid_media_type(media_type) {
            return Err(ArtifactError::Policy(
                "artifact ID or media type invalid".into(),
            ));
        }
        let bytes = self.read_bytes_by_digest(sha256)?;
        let artifact = StoredArtifact {
            artifact_id: artifact_id.into(),
            sha256: sha256.into(),
            byte_len: bytes.len() as u64,
            media_type: media_type.into(),
        };
        Ok((artifact, bytes))
    }

    /// Read exact artifact bytes through a typed, provenance-bound reference.
    pub fn read_ref(&self, reference: &contracts::ArtifactRefV1) -> Result<Vec<u8>, ArtifactError> {
        reference.validate().map_err(ArtifactError::Policy)?;
        self.read(&StoredArtifact {
            artifact_id: reference.artifact_id.clone(),
            sha256: reference.sha256.clone(),
            byte_len: reference.byte_len,
            media_type: reference.media_type.clone(),
        })
    }

    /// Verify every output and parent byte object referenced by a manifest.
    ///
    /// This checks local byte integrity only. It does not authenticate the
    /// declared producer or decide whether the content is trusted evidence.
    pub fn verify_manifest(
        &self,
        manifest: &contracts::ArtifactManifestV1,
    ) -> Result<(), ArtifactError> {
        manifest.validate().map_err(ArtifactError::Policy)?;
        for reference in manifest
            .artifacts
            .iter()
            .chain(manifest.lineage.parent_artifacts.iter())
        {
            self.read_ref(reference)?;
        }
        Ok(())
    }

    /// Persist an immutable canonical manifest after verifying all referenced bytes.
    ///
    /// The returned object ID is the SHA-256 of the exact canonical manifest
    /// bytes. The manifest is itself content-addressed and cannot overwrite an
    /// existing ID with different bytes.
    pub fn put_manifest(
        &self,
        manifest: &contracts::ArtifactManifestV1,
    ) -> Result<StoredArtifact, ArtifactError> {
        self.verify_manifest(manifest)?;
        let bytes = manifest
            .canonical_json_bytes()
            .map_err(ArtifactError::Policy)?;
        self.put(contracts::ARTIFACT_MANIFEST_MEDIA_TYPE, &bytes)
    }

    /// Read and integrity-check canonical manifest bytes by their stored reference.
    ///
    /// The caller must deserialize using a strict `ArtifactManifestV1` schema
    /// and call `validate`; this method does not confer evidence trust.
    pub fn read_manifest_bytes(&self, manifest: &StoredArtifact) -> Result<Vec<u8>, ArtifactError> {
        if manifest.media_type != contracts::ARTIFACT_MANIFEST_MEDIA_TYPE {
            return Err(ArtifactError::Policy(
                "manifest media type is invalid".into(),
            ));
        }
        self.read(manifest)
    }

    fn read_bytes_by_digest(&self, sha256: &str) -> Result<Vec<u8>, ArtifactError> {
        if !valid_digest(sha256) {
            return Err(ArtifactError::Policy("invalid artifact digest".into()));
        }
        let path = self.root.join(&sha256[..2]).join(sha256);
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_ARTIFACT_BYTES as u64
        {
            return Err(ArtifactError::Policy(
                "artifact path is not a bounded regular file".into(),
            ));
        }
        let canonical = fs::canonicalize(&path)?;
        if !canonical.starts_with(&self.root) {
            return Err(ArtifactError::Policy(
                "artifact path escapes configured root".into(),
            ));
        }
        let file = File::open(canonical)?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take((MAX_ARTIFACT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_ARTIFACT_BYTES || digest(&bytes) != sha256 {
            return Err(ArtifactError::Integrity(sha256.into()));
        }
        Ok(bytes)
    }
}

fn reject_symlink_components(path: &Path) -> Result<(), ArtifactError> {
    for component in path.ancestors() {
        match fs::symlink_metadata(component) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ArtifactError::Policy(format!(
                    "artifact path contains a symlink: {}",
                    component.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(ArtifactError::Io(error)),
        }
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), ArtifactError> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    Ok(())
}

fn valid_media_type(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut parts = value.split('/');
    let Some(media_type) = parts.next() else {
        return false;
    };
    let Some(subtype) = parts.next() else {
        return false;
    };
    let valid_token = |token: &str| {
        !token.is_empty()
            && token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte))
    };
    valid_token(media_type) && valid_token(subtype) && parts.next().is_none()
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_addressed_put_is_idempotent_and_read_verifies_exact_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let store = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let first = store.put("text/plain", b"immutable evidence").unwrap();
        let second = store.put("text/plain", b"immutable evidence").unwrap();
        assert_eq!(first, second);
        assert_eq!(store.read(&first).unwrap(), b"immutable evidence");
    }

    #[test]
    fn rejects_forged_reference_size_and_media_type() {
        let directory = tempfile::tempdir().unwrap();
        let store = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let mut reference = store.put("application/json", b"{} ").unwrap();
        reference.byte_len += 1;
        assert!(matches!(
            store.read(&reference),
            Err(ArtifactError::Integrity(_))
        ));
        assert!(matches!(
            store.put("not-a-media-type", b"x"),
            Err(ArtifactError::Policy(_))
        ));
        for malformed in [
            "application//json",
            "application/*",
            "*/json",
            "application/json; charset=utf-8",
        ] {
            assert!(
                matches!(store.put(malformed, b"x"), Err(ArtifactError::Policy(_))),
                "accepted malformed media type: {malformed}"
            );
        }
    }

    #[test]
    fn artifact_root_symlinks_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real");
        fs::create_dir(&real).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = directory.path().join("link");
            symlink(&real, &link).unwrap();
            assert!(matches!(
                ArtifactStore::open_or_create(link),
                Err(ArtifactError::Policy(_))
            ));
        }
    }

    #[test]
    fn orphaned_staging_file_never_poisoned_content_addressed_destination() {
        let directory = tempfile::tempdir().unwrap();
        let store = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let bytes = b"complete evidence after interrupted writer";
        let sha256 = digest(bytes);
        let shard = store.root.join(&sha256[..2]);
        fs::create_dir(&shard).unwrap();
        fs::write(shard.join(".runalith-artifact-crashed.tmp"), b"partial").unwrap();
        let artifact = store.put("text/plain", bytes).unwrap();
        assert_eq!(store.read(&artifact).unwrap(), bytes);
        assert!(shard.join(".runalith-artifact-crashed.tmp").exists());
    }

    #[test]
    fn concurrent_identical_puts_publish_one_complete_immutable_object() {
        let directory = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(
            ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap(),
        );
        let bytes = b"parallel artifact publication".to_vec();
        let writers = (0..8)
            .map(|_| {
                let store = store.clone();
                let bytes = bytes.clone();
                std::thread::spawn(move || store.put("application/octet-stream", &bytes).unwrap())
            })
            .collect::<Vec<_>>();
        let artifacts = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .collect::<Vec<_>>();
        assert!(artifacts.iter().all(|artifact| artifact == &artifacts[0]));
        assert_eq!(store.read(&artifacts[0]).unwrap(), bytes);
    }

    #[test]
    fn typed_manifest_persists_and_reads_back_exact_immutable_bytes() {
        use contracts::{
            ARTIFACT_MANIFEST_MEDIA_TYPE, ArtifactLineageV1, ArtifactManifestV1, ArtifactRefV1,
            ArtifactSourceV1, CONTRACT_VERSION_V1,
        };

        let directory = tempfile::tempdir().unwrap();
        let artifact_root = directory.path().join("artifacts");
        let store = ArtifactStore::open_or_create(&artifact_root).unwrap();
        let bytes = br#"{"result":"ok"}"#;
        let stored = store.put("application/json", bytes).unwrap();
        let source = ArtifactSourceV1 {
            producer_id: "worker.exec-1".into(),
            workflow_id: "wf-1".into(),
            task_id: "task-1".into(),
            attempt: 1,
            correlation_id: "corr-1".into(),
            created_at: "2026-11-03T03:00:00Z".into(),
        };
        let reference = ArtifactRefV1 {
            contract_version: CONTRACT_VERSION_V1.into(),
            artifact_id: stored.artifact_id.clone(),
            sha256: stored.sha256.clone(),
            byte_len: stored.byte_len,
            media_type: stored.media_type.clone(),
            content_schema_id: Some("runalith.execution-result".into()),
            content_schema_version: Some("1.0".into()),
            source: source.clone(),
        };
        let manifest = ArtifactManifestV1 {
            contract_version: CONTRACT_VERSION_V1.into(),
            created_at: "2026-11-03T03:01:00Z".into(),
            artifacts: vec![reference],
            lineage: ArtifactLineageV1 {
                contract_version: CONTRACT_VERSION_V1.into(),
                producer_id: source.producer_id,
                workflow_id: source.workflow_id,
                task_id: source.task_id,
                attempt: source.attempt,
                correlation_id: source.correlation_id,
                created_at: source.created_at,
                parent_artifacts: vec![],
            },
        };

        let expected_bytes = manifest.canonical_json_bytes().unwrap();
        let manifest_ref = store.put_manifest(&manifest).unwrap();
        assert_eq!(manifest_ref.media_type, ARTIFACT_MANIFEST_MEDIA_TYPE);
        drop(store);
        let reopened = ArtifactStore::open_or_create(&artifact_root).unwrap();
        assert_eq!(
            reopened.read_manifest_bytes(&manifest_ref).unwrap(),
            expected_bytes
        );
        reopened.verify_manifest(&manifest).unwrap();
    }

    #[test]
    fn typed_manifest_refuses_to_publish_when_content_is_missing() {
        use contracts::{
            ArtifactLineageV1, ArtifactManifestV1, ArtifactRefV1, ArtifactSourceV1,
            CONTRACT_VERSION_V1,
        };

        let directory = tempfile::tempdir().unwrap();
        let store = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let source = ArtifactSourceV1 {
            producer_id: "worker.exec-1".into(),
            workflow_id: "wf-1".into(),
            task_id: "task-1".into(),
            attempt: 1,
            correlation_id: "corr-1".into(),
            created_at: "2026-11-03T03:00:00Z".into(),
        };
        let sha256 = "a".repeat(64);
        let reference = ArtifactRefV1 {
            contract_version: CONTRACT_VERSION_V1.into(),
            artifact_id: format!("sha256:{sha256}"),
            sha256,
            byte_len: 1,
            media_type: "application/json".into(),
            content_schema_id: None,
            content_schema_version: None,
            source: source.clone(),
        };
        let manifest = ArtifactManifestV1 {
            contract_version: CONTRACT_VERSION_V1.into(),
            created_at: "2026-11-03T03:01:00Z".into(),
            artifacts: vec![reference],
            lineage: ArtifactLineageV1 {
                contract_version: CONTRACT_VERSION_V1.into(),
                producer_id: source.producer_id,
                workflow_id: source.workflow_id,
                task_id: source.task_id,
                attempt: source.attempt,
                correlation_id: source.correlation_id,
                created_at: source.created_at,
                parent_artifacts: vec![],
            },
        };
        assert!(matches!(
            store.put_manifest(&manifest),
            Err(ArtifactError::Io(_))
        ));
    }

    #[test]
    fn put_never_overwrites_an_existing_content_address_even_if_corrupt() {
        let directory = tempfile::tempdir().unwrap();
        let store = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let original = b"content-addressed immutable bytes";
        let reference = store.put("text/plain", original).unwrap();
        let object_path = store
            .root
            .join(&reference.sha256[..2])
            .join(&reference.sha256);
        fs::write(&object_path, b"tampered").unwrap();

        assert!(matches!(
            store.put("text/plain", original),
            Err(ArtifactError::Integrity(_))
        ));
        assert_eq!(fs::read(object_path).unwrap(), b"tampered");
    }
}

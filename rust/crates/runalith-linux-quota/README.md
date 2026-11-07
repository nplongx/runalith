# Linux project-quota helper and integration harness

`runalith-quota-helper` is the privileged systemd socket-activated quota broker.
The unprivileged worker communicates with it over the configured Unix socket;
the helper checks `SO_PEERCRED`, constrains operations to one configured mount,
records project-ID/device/inode ownership in a root-owned SQLite registry, and
reads the kernel quota values back before acknowledging an allocation.

## Kernel integration test (destructive)

`runalith-quota-integration` is a separate root-only test harness. It writes
real files and inodes on the supplied mount, intentionally exhausts project
quotas, removes each workspace, waits for kernel usage to reach zero, clears
the quota, and retains every test project ID in a separate append-only registry.
It does not use userspace accounting and does not touch `/srv/runalith/workspace`
unless that exact location is explicitly supplied as the test root.

Provision a **dedicated disposable ext4 or XFS filesystem** mounted with
`prjquota`/`pquota`; do not use `/`, a subdirectory of a production filesystem,
or a production workspace mount. The destructive modes now enforce that the
configured root is the exact mount point (not merely a directory on a quota
filesystem), that its root is owned by root with exact mode `0700`, and that it
contains only the marker and the harness-owned `.runalith-quota-integration`
directory. The marker must be root-owned with exact mode `0600` and contain exactly
`RUNALITH_DISPOSABLE_PROJECT_QUOTA_TEST_MOUNT_V1` followed by a newline.
Pre-create a root-owned registry directory with exact mode `0700` on a
**different filesystem device** from the disposable quota mount. The harness
refuses a registry parent on the test device, a symlinked/non-canonical parent,
or a registry DB that is not a root-owned regular mode-`0600` file with one
hard link. The harness does not create registry parent directories for you.
Ensure the root test process can write to the pre-created directory.

Run the non-destructive filesystem/mount preflight first (no root privilege or
registry is needed for a mount that does not enable project quotas):

```sh
RUNALITH_QUOTA_TEST_ROOT=/mnt/runalith-quota-test \
  /usr/local/libexec/runalith-quota-integration --preflight
```

Only after it reports the expected ext4/XFS project-quota mount and the
disposable mount has been deliberately prepared should its marker be created.
Pass an explicit acknowledgement for every destructive or recovery mode:

```sh
install -d -o root -g root -m 0700 /var/lib/runalith-quota/integration
printf 'RUNALITH_DISPOSABLE_PROJECT_QUOTA_TEST_MOUNT_V1\n' \
  > /mnt/runalith-quota-test/.runalith-disposable-quota-test-mount
chown root:root /mnt/runalith-quota-test/.runalith-disposable-quota-test-mount
chmod 0600 /mnt/runalith-quota-test/.runalith-disposable-quota-test-mount
export RUNALITH_QUOTA_TEST_DESTRUCTIVE_ACK=I_UNDERSTAND_THIS_MOUNT_WILL_BE_MODIFIED_AND_QUOTA_LIMITS_WILL_BE_EXHAUSTED
RUNALITH_QUOTA_TEST_ROOT=/mnt/runalith-quota-test \
RUNALITH_QUOTA_TEST_REGISTRY=/var/lib/runalith-quota/integration/projects.db \
  /usr/local/libexec/runalith-quota-integration --exhaustion
```

The harness reserves IDs monotonically in the test-only range
`1500000000..=1700000000`; it never deletes rows or reuses an ID. Do not delete
the registry while the filesystem or any old project quota records remain.
`ALLOCATING` and `ACTIVE` entries are reconciled on the next run using the
recorded workspace path and device/inode. A `QUARANTINED` entry deliberately
stops automatic recovery and requires an operator to investigate it.

To exercise interrupted-allocation recovery, run:

```sh
export RUNALITH_QUOTA_TEST_DESTRUCTIVE_ACK=I_UNDERSTAND_THIS_MOUNT_WILL_BE_MODIFIED_AND_QUOTA_LIMITS_WILL_BE_EXHAUSTED
RUNALITH_QUOTA_TEST_ROOT=/mnt/runalith-quota-test \
RUNALITH_QUOTA_TEST_REGISTRY=/var/lib/runalith-quota/integration/projects.db \
  /usr/local/libexec/runalith-quota-integration --prepare-recovery
```

Stop/restart the process or host, then invoke `--recover-only` with the same
root, registry, and acknowledgement:

```sh
export RUNALITH_QUOTA_TEST_DESTRUCTIVE_ACK=I_UNDERSTAND_THIS_MOUNT_WILL_BE_MODIFIED_AND_QUOTA_LIMITS_WILL_BE_EXHAUSTED
RUNALITH_QUOTA_TEST_ROOT=/mnt/runalith-quota-test \
RUNALITH_QUOTA_TEST_REGISTRY=/var/lib/runalith-quota/integration/projects.db \
  /usr/local/libexec/runalith-quota-integration --recover-only
```

This verifies test-harness registry reconciliation by a new process against the real kernel project quota records.
It does **not** by itself test the worker/helper RPC across a systemd helper
restart or an operation racing a helper crash; those require a separately
provisioned host and service-level fault injection. The production worker
deliberately quarantines all unfinished `ALLOCATING`/`ACTIVE` execution
workspaces on worker restart; it does not infer that a process stopped or that
quota usage is safe to release. The helper does not autonomously clear
`ASSIGNING`/`ACTIVE` records on process startup. Exact assignment retry can
resume only the same recorded path/device/inode; uncertain worker workspaces
remain reserved/quarantined pending a separate authorized recovery procedure.

The harness is destructive on its supplied test filesystem. `--exhaustion`,
`--prepare-recovery`, and `--recover-only` fail closed unless the exact
mountpoint, root-owned `0700` directory, marker file/content/permissions,
allowlisted mount contents, and exact acknowledgement all match. The guard
rejects `/` unconditionally and does not accept a subdirectory under a
production mount. `--preflight` remains read-only and does not require the
marker or acknowledgement. If root is unavailable, the filesystem is not
ext4/XFS, or mount options do not contain active `prjquota`/`pquota`, the test
must fail before creating a test workspace. Such a preflight failure is **NOT
RUN**, not evidence that byte/inode enforcement passed.

## Trust boundary

The worker task is assumed unprivileged and must not receive `CAP_SYS_ADMIN`,
`CAP_FOWNER`, or write access to the helper's registry. The helper and root
host remain trusted. A host actor with root-equivalent privileges can change
mount configuration, quota records, registry files, or filesystem topology;
this design does not claim containment against a malicious root host actor.

The project quota protects charged bytes/inodes on the mounted project. It is
not a substitute for the worker's process, network, syscall, filesystem-path,
or resource sandbox. Every release remains conditional on exact directory
identity and kernel readback of zero charged bytes and inodes.

## Registry persistence tests

The unit-level registry regression uses two independent SQLite connections to
exercise identical assignment retries and competing directory/inode claims for
one project ID. It also reopens the registry after an `ASSIGNING` reservation,
resumes only the exact recorded inode binding, verifies immutable byte/inode
limits after restart, and confirms that `RELEASED` IDs cannot be rebound. Run
it with:

```sh
cargo +1.85.0 test -p runalith-linux-quota --locked --offline \
  quota_registry_serializes_assignment_across_connections_and_recovers_after_restart
```

This is SQLite/helper-registry concurrency and crash-recovery evidence only;
it does **not** exercise `quotactl`, kernel byte/inode charging, actual
exhaustion, or systemd socket-activation restart. Those remain subject to the
dedicated disposable ext4/XFS test filesystem described above.

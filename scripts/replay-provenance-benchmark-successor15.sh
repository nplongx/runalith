#!/usr/bin/env bash
set -uo pipefail

# Local fresh-extraction replay for successor15. This script deliberately does
# not run the action-invoking full E2E, package builder, or sandbox action. It
# verifies durable receipt bytes, read-only MCP behavior, and safe regressions.
# All outcomes are local integrity/reproducibility evidence, not attestation.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PACK_ROOT="$(cd "$ROOT/.." && pwd -P)"
OFFICIAL_REL='artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb'
DEV_REL='artifacts/phase1-dev-only/implementation-hardening-successor15-20261023T160000+0700/runalith-1.0.9-rc.5-candidate-source-aligned-dev-only-successor15-receipt-integrity-v9.mcpb'
OFFICIAL="$ROOT/$OFFICIAL_REL"
DEV="$ROOT/$DEV_REL"
HISTORICAL_REL='artifacts/phase1-dev-only/implementation-hardening-successor15-20261023T160000+0700/reference-inputs/historical-dist-candidate-20261020T142019Z.mcpb'
HISTORICAL="$ROOT/$HISTORICAL_REL"
RUN_DIR="${RUNALITH_REPLAY_LOG_DIR:-$(mktemp -d /tmp/runalith-successor15-replay.XXXXXX)}"
mkdir -p "$RUN_DIR"
cd "$ROOT"
export NODE_ENV=test

case "$RUN_DIR/" in
  "$ROOT/"*)
    echo 'FAIL: replay logs and temporary metadata must be outside the workspace to preserve stable workspace hashes' >&2
    exit 2
    ;;
esac

if [[ -e "$ROOT/.git" || -e "$ROOT/dist" ]]; then
  echo 'FAIL: local fresh-extraction workspace must not contain .git/ or dist/' >&2
  exit 2
fi
if [[ ! -f "$OFFICIAL" || ! -f "$DEV" || ! -f "$DEV.sha256" || ! -f "$HISTORICAL" || ! -f "$HISTORICAL.sha256" ]]; then
  echo 'FAIL: official RC.5, successor15 candidate, and immutable historical lineage input/sidecars are required' >&2
  exit 2
fi

# Documentation validation shells out to `git ls-files`. The extracted source
# intentionally has no .git/.gitignore file must be included with the workspace;
# provide an empty temporary bare git database OUTSIDE it and point work-tree
# discovery at the extraction. No commit or source history is synthesized.
unset GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES
git init --bare "$RUN_DIR/replay-git-metadata.git" >"$RUN_DIR/replay-git-init.log" 2>&1 || {
  cat "$RUN_DIR/replay-git-init.log" >&2
  exit 2
}

official_digest="$(sha256sum "$OFFICIAL" | awk '{print $1}')"
dev_digest="$(sha256sum "$DEV" | awk '{print $1}')"
[[ "$official_digest" == 9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37 ]] || { echo 'FAIL: immutable official RC.5 digest differs' >&2; exit 2; }
[[ "$dev_digest" == edcbc3bdbadfe541f987a39b59c8fa3693a2414ace115012516df4987322ab9a ]] || { echo 'FAIL: successor15 development candidate digest differs' >&2; exit 2; }
[[ "$(awk '{print $1}' "$OFFICIAL.sha256")" == "$official_digest" ]] || { echo 'FAIL: official RC.5 sidecar digest field differs' >&2; exit 2; }
(cd "$(dirname "$DEV")" && sha256sum -c "$(basename "$DEV").sha256") || exit 2
(cd "$(dirname "$HISTORICAL")" && sha256sum -c "$(basename "$HISTORICAL").sha256") || exit 2

verify_manifests() {
  (cd "$PACK_ROOT" && sha256sum -c SHA256SUMS && sha256sum -c CORE-SHA256SUMS)
}
verify_manifests >"$RUN_DIR/manifest-check-before.log" 2>&1 || { tail -n 30 "$RUN_DIR/manifest-check-before.log" >&2; exit 2; }
(cd "$ROOT" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) >"$RUN_DIR/workspace-observed-sha256-before.txt"

required_failures=0
expected_blockers=0
checks=()
record() {
  local name="$1" expected="$2" pattern="$3"; shift 3
  printf '%q ' "$@" >"$RUN_DIR/$name.command.txt"
  date -Is >"$RUN_DIR/$name.started-at.txt"
  "$@" >"$RUN_DIR/$name.stdout.log" 2>"$RUN_DIR/$name.stderr.log"
  local actual=$?
  printf '%s\n' "$actual" >"$RUN_DIR/$name.exit-code"
  date -Is >"$RUN_DIR/$name.ended-at.txt"
  local status=FAIL
  if [[ "$expected" == pass && $actual -eq 0 ]]; then status=PASS
  elif [[ "$expected" == blocked && $actual -eq 1 ]] && grep -Eq "$pattern" "$RUN_DIR/$name.stdout.log" "$RUN_DIR/$name.stderr.log"; then
    status=EXPECTED_BLOCKER
    expected_blockers=$((expected_blockers + 1))
  fi
  printf '%s\n' "$status" >"$RUN_DIR/$name.disposition"
  checks+=("$name:$status:exit=$actual")
  printf '%-48s %-17s exit=%s\n' "$name" "$status" "$actual"
  if [[ "$status" == FAIL ]]; then
    required_failures=$((required_failures + 1))
    tail -n 25 "$RUN_DIR/$name.stdout.log" "$RUN_DIR/$name.stderr.log" >&2
  fi
}

record receipt-integrity pass '' node --test tests/test-adaptive-goal-sandbox-receipt-integrity.mjs
record agg-benchmark-causality pass '' node --test tests/test-adaptive-goal-benchmark.mjs
record phase1-protocol-freeze pass '' node --test tests/test-phase1-acceptance-protocol-freeze.mjs
record phase2-diagnostic-contract pass '' node --test tests/test-phase2-inventory-diagnostic-contract.mjs
record source-evidence pass '' node tests/test-adaptive-goal-source-evidence.js
record evidence-lineage pass '' node --test tests/test-adaptive-goal-evidence-lineage.js
record reviewer-identity pass '' node --test tests/test-adaptive-goal-reviewer-identity.js
record candidate-assessment-contract pass '' node --test tests/test-adaptive-goal-candidate-assessment-contract.mjs
record github-actions-provider pass '' node tests/test-github-actions-provider.js
record terminal-ledger-recovery pass '' node tests/test-finish-execution-terminal-ledger.js
record execution-lease-fencing pass '' node tests/test-execution-lease-fencing.js
record execution-batch-terminal-recovery pass '' node tests/test-execution-batch-terminal-recovery.js
record execution-batch-concurrency pass '' node tests/test-execution-batch-concurrency.js
record unstarted-claim-recovery pass '' node tests/test-execution-batch-unstarted-claim-recovery.js
record claim-preparation-fence pass '' node tests/test-execution-batch-claim-preparation-fence.js
record postspawn-reconciliation pass '' node tests/test-execution-postspawn-reconciliation.js
record deterministic-recovery-race pass '' node tests/test-deterministic-recovery-race.js
record recovery-hardening pass '' node tests/test-recovery-hardening.js
record verified-result-atomicity pass '' node tests/test-verified-execution-result-atomicity.js
record phase2-secure-filesystem pass '' node tests/test-secure-filesystem-boundary.js
record phase2-worker-filesystem pass '' node tests/test-worker-filesystem-boundary.js
record execution-verifier pass '' node tests/test-execution-verifier.js
record output-commit-binding pass '' node tests/test-execution-verifier-output-commit-binding-20261017.js
record docs-check pass '' env GIT_DIR="$RUN_DIR/replay-git-metadata.git" GIT_WORK_TREE="$ROOT" npm run docs:check

record official-rc5-package-smoke pass '' node scripts/test-mcpb-candidate.mjs "$OFFICIAL"
record official-rc5-agg-search pass '' node tests/test-mcpb-agg-search-integration.mjs "$OFFICIAL"
record official-rc5-tool-schemas pass '' env PHASE2_CANDIDATE_BUNDLE="$OFFICIAL" node tests/test-extracted-package-tool-schemas.mjs
record official-rc5-response-extension blocked 'response_extension_missing' node tests/test-dev-only-mcpb-agg-evidence-assessment.mjs --dev-only-not-acceptance "$OFFICIAL"
record successor15-package-smoke pass '' node scripts/test-mcpb-candidate.mjs "$DEV"
record successor15-tool-schemas pass '' env PHASE2_CANDIDATE_BUNDLE="$DEV" node tests/test-extracted-package-tool-schemas.mjs
record successor15-readonly-assessment pass '' node tests/test-dev-only-mcpb-agg-evidence-assessment.mjs --dev-only-not-acceptance "$DEV"

record historical-phase2-lineage blocked 'historical_source_manifest_lineage_mismatch' env PHASE2_CANDIDATE_BUNDLE="$HISTORICAL" node benchmarks/plugin-workflow-benchmark/test-create-phase2-candidate-inventory.mjs
record source-aligned-76-vs-71 blocked '76 !== 71' env PHASE2_CANDIDATE_BUNDLE="$DEV" node benchmarks/plugin-workflow-benchmark/test-create-phase2-candidate-inventory.mjs
record phase2-security-aggregate blocked '76 !== 71' env PHASE2_CANDIDATE_BUNDLE="$DEV" npm run test:phase2-security-regressions

(cd "$ROOT" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) >"$RUN_DIR/workspace-observed-sha256-after.txt"
observed_stable=false
if cmp -s "$RUN_DIR/workspace-observed-sha256-before.txt" "$RUN_DIR/workspace-observed-sha256-after.txt"; then observed_stable=true
else required_failures=$((required_failures + 1)); echo 'FAIL: workspace bytes changed during local replay' >&2; fi
manifest_after_verified=false
if verify_manifests >"$RUN_DIR/manifest-check-after.log" 2>&1; then manifest_after_verified=true
else tail -n 30 "$RUN_DIR/manifest-check-after.log" >&2; required_failures=$((required_failures + 1)); fi

{
  printf 'schemaVersion=1\nkind=successor15_local_fresh_extraction_replay\n'
  printf 'officialTargetSha256=%s\nsuccessor15DevSha256=%s\n' "$official_digest" "$dev_digest"
  printf 'checkCount=%s\nexpectedBlockerCount=%s\nunexpectedFailureCount=%s\n' "${#checks[@]}" "$expected_blockers" "$required_failures"
  printf 'workspaceHasGit=false\nworkspaceHasDist=false\n'
  printf 'workspaceHashesStable=%s\nrootAndWorkspaceManifestsVerifiedBeforeAndAfter=%s\n' "$observed_stable" "$( [[ "$manifest_after_verified" == true ]] && echo true || echo false )"
  printf 'fullNpmTestRun=false\npackageReproducibilityE2ERun=false\nreason=those commands invoke the sandbox fixture action and no independent authorization/runtime permission was supplied\n'
  printf 'decision=%s\n' "$( [[ $required_failures -eq 0 ]] && echo PARTIAL_NOT_ACCEPTED_OWNER_GATES_REMAIN || echo REPLAY_HAS_UNEXPECTED_FAILURES )"
  printf 'check=%s\n' "${checks[@]}"
} >"$RUN_DIR/replay-summary.txt"
cat "$RUN_DIR/replay-summary.txt"
printf 'rawLogs=%s\n' "$RUN_DIR"
[[ $required_failures -eq 0 && $expected_blockers -eq 4 ]]

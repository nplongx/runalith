#!/usr/bin/env bash
set -uo pipefail

# Run only from a freshly extracted successor11 evidence pack. Raw logs and the
# detached receipt stay outside the immutable archive to avoid circular hashes.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PACK_ROOT="$(cd "$ROOT/.." && pwd -P)"
OFFICIAL="$ROOT/artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb"
DEV="$ROOT/artifacts/phase1-dev-only/implementation-hardening-successor11-20261023T143000+0700/runalith-1.0.9-rc.5-candidate-source-aligned-dev-only-successor11-artifact-byte-replay.mcpb"
RUN_DIR="${RUNALITH_REPLAY_LOG_DIR:-$(mktemp -d /tmp/runalith-successor11-replay.XXXXXX)}"
cd "$ROOT"
mkdir -p "$RUN_DIR"
export NODE_ENV=test
required_failures=0
expected_blockers=0
checks=()
manifest_before_verified=false
manifest_after_verified=false

if [[ -e "$ROOT/.git" || -e "$ROOT/dist" ]]; then
  echo "FAIL: extracted workspace must not contain .git/ or dist/" >&2
  exit 2
fi
if [[ ! -f "$OFFICIAL" || ! -f "$OFFICIAL.sha256" || ! -f "$DEV" || ! -f "$DEV.sha256" ]]; then
  echo "FAIL: fixed RC.5 and successor11 development-only package plus sidecars are required" >&2
  exit 2
fi
official_digest="$(sha256sum "$OFFICIAL" | awk '{print $1}')"
dev_digest="$(sha256sum "$DEV" | awk '{print $1}')"
[[ "$official_digest" == 9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37 ]] || { echo "FAIL: fixed official RC.5 digest differs" >&2; exit 2; }
[[ "$dev_digest" == 0e685a3d0eba92877c739f39e63a0b56f405abe14354646be837116ce0bf3e5a ]] || { echo "FAIL: successor11 dev-only digest differs" >&2; exit 2; }
(cd "$(dirname "$OFFICIAL")" && sha256sum -c "$(basename "$OFFICIAL").sha256") || exit 2
(cd "$ROOT" && sha256sum -c "$DEV.sha256") || exit 2
verify_manifests() { (cd "$PACK_ROOT" && sha256sum -c SHA256SUMS && sha256sum -c CORE-SHA256SUMS); }
verify_manifests >"$RUN_DIR/manifest-check-before.log" 2>&1 || { cat "$RUN_DIR/manifest-check-before.log" >&2; exit 2; }
manifest_before_verified=true

record() {
  local name="$1" expected="$2" pattern="$3"; shift 3
  printf '%s\n' "$*" >"$RUN_DIR/$name.command.txt"
  date -Is >"$RUN_DIR/$name.started-at.txt"
  "$@" >"$RUN_DIR/$name.stdout.log" 2>"$RUN_DIR/$name.stderr.log"
  local actual=$?
  printf '%s\n' "$actual" >"$RUN_DIR/$name.exit-code"
  date -Is >"$RUN_DIR/$name.ended-at.txt"
  local status=FAIL
  if [[ "$expected" == pass && $actual -eq 0 ]]; then status=PASS
  elif [[ "$expected" == blocked && $actual -eq 1 ]] && grep -Eq "$pattern" "$RUN_DIR/$name.stdout.log" "$RUN_DIR/$name.stderr.log"; then
    status=EXPECTED_BLOCKER; expected_blockers=$((expected_blockers + 1))
  fi
  printf '%s\n' "$status" >"$RUN_DIR/$name.disposition"
  checks+=("$name:$status:exit=$actual")
  printf '%-48s %-17s exit=%s\n' "$name" "$status" "$actual"
  if [[ "$status" == FAIL ]]; then required_failures=$((required_failures + 1)); tail -n 25 "$RUN_DIR/$name.stdout.log" "$RUN_DIR/$name.stderr.log" >&2; fi
}

record agg-source-and-assessment-contracts pass '' node --test \
  "$ROOT/tests/test-adaptive-goal-source-evidence.js" \
  "$ROOT/tests/test-adaptive-goal-evidence-lineage.js" \
  "$ROOT/tests/test-adaptive-goal-candidate-assessment-contract.mjs"
record agg-benchmark-v5 pass '' node --test "$ROOT/tests/test-adaptive-goal-benchmark.mjs" "$ROOT/tests/test-adaptive-goal-benchmark-integrity.mjs"
record agg-execution-plan-candidate pass '' node --test "$ROOT/tests/test-adaptive-goal-execution-plan-candidate.js"
record agg-execution-graph-proposal pass '' node --test "$ROOT/tests/test-adaptive-goal-execution-graph-proposal.js"
record sandbox-receipt-regressions pass '' node --test "$ROOT/tests/test-adaptive-goal-sandbox-executor.mjs"
record reviewer-attestation-regressions pass '' node --test "$ROOT/tests/test-adaptive-goal-reviewer-identity.js"
record durable-artifact-byte-lineage-and-mcp-e2e pass '' node "$ROOT/tests/test-runalith-plugin.js"
record deterministic-recovery-race pass '' node "$ROOT/tests/test-deterministic-recovery-race.js"
record recovery-hardening pass '' node "$ROOT/tests/test-recovery-hardening.js"
record verified-result-atomicity pass '' node "$ROOT/tests/test-verified-execution-result-atomicity.js"
record execution-batch-terminal-recovery pass '' node "$ROOT/tests/test-execution-batch-terminal-recovery.js"
record official-rc5-package-smoke pass '' node "$ROOT/scripts/test-mcpb-candidate.mjs" "$OFFICIAL"
record official-rc5-agg-search pass '' node "$ROOT/tests/test-mcpb-agg-search-integration.mjs" "$OFFICIAL"
record official-rc5-tool-schema pass '' env PHASE2_CANDIDATE_BUNDLE="$OFFICIAL" node "$ROOT/tests/test-extracted-package-tool-schemas.mjs"
record official-rc5-assessment-extension blocked response_extension_missing node "$ROOT/tests/test-dev-only-mcpb-agg-evidence-assessment.mjs" --dev-only-not-acceptance "$OFFICIAL"
record successor11-dev-package-smoke pass '' node "$ROOT/scripts/test-mcpb-candidate.mjs" "$DEV"
record successor11-dev-tool-schema pass '' env PHASE2_CANDIDATE_BUNDLE="$DEV" node "$ROOT/tests/test-extracted-package-tool-schemas.mjs"
record successor11-dev-assessment pass '' node "$ROOT/tests/test-dev-only-mcpb-agg-evidence-assessment.mjs" --dev-only-not-acceptance "$DEV"
record frozen-inventory-71-vs-76 blocked '76 !== 71' env PHASE2_CANDIDATE_BUNDLE="$DEV" node "$ROOT/benchmarks/plugin-workflow-benchmark/test-create-phase2-candidate-inventory.mjs"
record doc-link-parser-unit-test pass '' node "$ROOT/tests/test-doc-link-parser.js"

if verify_manifests >"$RUN_DIR/manifest-check-after.log" 2>&1; then manifest_after_verified=true
else cat "$RUN_DIR/manifest-check-after.log" >&2; required_failures=$((required_failures + 1)); fi
{
  printf 'schemaVersion=1\nkind=successor11_independent_source_extracted_replay\n'
  printf 'officialTargetSha256=%s\nsuccessor11DevSha256=%s\n' "$official_digest" "$dev_digest"
  printf 'expectedBlockerCount=%s\nunexpectedFailureCount=%s\n' "$expected_blockers" "$required_failures"
  printf 'workspaceHasGit=false\nworkspaceHasDist=false\n'
  printf 'sourceRootManifestVerifiedBeforeAndAfter=%s\n' "$( [[ "$manifest_before_verified" == true && "$manifest_after_verified" == true ]] && echo true || echo false )"
  printf 'workspaceManifestVerifiedBeforeAndAfter=%s\n' "$( [[ "$manifest_before_verified" == true && "$manifest_after_verified" == true ]] && echo true || echo false )"
  printf 'decision=%s\n' "$([[ $required_failures -eq 0 ]] && echo BLOCKED_NO_TRUSTED_CORPUS_OR_REAL_AB_RUNS || echo REPLAY_HAS_UNEXPECTED_FAILURES)"
  printf 'check=%s\n' "${checks[@]}"
} >"$RUN_DIR/replay-summary.txt"
printf 'manifestChecksumAfterReplay=%s\n' "$([[ $required_failures -eq 0 ]] && echo VERIFIED || echo FAILED)"
cat "$RUN_DIR/replay-summary.txt"
printf 'rawLogs=%s\n' "$RUN_DIR"
[[ $required_failures -eq 0 && $expected_blockers -eq 2 ]]

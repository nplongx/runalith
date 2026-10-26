#!/usr/bin/env bash
set -uo pipefail

# Fresh-extraction regression replay for successor12. It preserves the exact
# RC.5 acceptance target and records owner-controlled blockers as blockers.
# This script is local replay/integrity evidence only, not independent review.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PACK_ROOT="$(cd "$ROOT/.." && pwd -P)"
OFFICIAL="$ROOT/artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb"
DEV="$ROOT/artifacts/phase1-dev-only/implementation-hardening-successor12-20261023T125228+0700/runalith-1.0.9-rc.5-candidate-source-aligned-dev-only-successor12-result-byte-replay.mcpb"
RUN_DIR="${RUNALITH_REPLAY_LOG_DIR:-$(mktemp -d /tmp/runalith-successor12-replay.XXXXXX)}"
mkdir -p "$RUN_DIR"
cd "$ROOT"
export NODE_ENV=test

if [[ -e "$ROOT/.git" || -e "$ROOT/dist" ]]; then
  echo 'FAIL: extracted workspace must not contain .git/ or dist/' >&2
  exit 2
fi
if [[ ! -f "$OFFICIAL" || ! -f "$OFFICIAL.sha256" || ! -f "$DEV" || ! -f "$DEV.sha256" ]]; then
  echo 'FAIL: exact RC.5 target and successor12 development-only package/sidecars are required' >&2
  exit 2
fi
official_digest="$(sha256sum "$OFFICIAL" | awk '{print $1}')"
dev_digest="$(sha256sum "$DEV" | awk '{print $1}')"
[[ "$official_digest" == 9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37 ]] || { echo 'FAIL: immutable official RC.5 digest differs' >&2; exit 2; }
[[ "$dev_digest" == 08d2d61f7de4ed5bbc69f21a0a70eb0239a8ef99c9eddf705001ee255603f35a ]] || { echo 'FAIL: successor12 development package digest differs' >&2; exit 2; }
(cd "$(dirname "$OFFICIAL")" && sha256sum -c "$(basename "$OFFICIAL").sha256") || exit 2
(cd "$ROOT" && sha256sum -c "$DEV.sha256") || exit 2

verify_manifests() { (cd "$PACK_ROOT" && sha256sum -c SHA256SUMS && sha256sum -c CORE-SHA256SUMS); }
verify_manifests >"$RUN_DIR/manifest-check-before.log" 2>&1 || { cat "$RUN_DIR/manifest-check-before.log" >&2; exit 2; }

required_failures=0
expected_blockers=0
checks=()
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
    status=EXPECTED_BLOCKER
    expected_blockers=$((expected_blockers + 1))
  fi
  printf '%s\n' "$status" >"$RUN_DIR/$name.disposition"
  checks+=("$name:$status:exit=$actual")
  printf '%-44s %-17s exit=%s\n' "$name" "$status" "$actual"
  if [[ "$status" == FAIL ]]; then
    required_failures=$((required_failures + 1))
    tail -n 25 "$RUN_DIR/$name.stdout.log" "$RUN_DIR/$name.stderr.log" >&2
  fi
}

record agg-benchmark-v6 pass '' node --test tests/test-adaptive-goal-benchmark.mjs
record source-evidence-contract pass '' node tests/test-adaptive-goal-source-evidence.js
record assessment-contract pass '' node --test tests/test-adaptive-goal-candidate-assessment-contract.mjs
record sandbox-receipt-unit pass '' node --test tests/test-adaptive-goal-sandbox-executor.mjs
record durable-mcp-e2e pass '' node tests/test-runalith-plugin.js
record deterministic-recovery-race pass '' node tests/test-deterministic-recovery-race.js
record recovery-hardening pass '' node tests/test-recovery-hardening.js
record verified-result-atomicity pass '' node tests/test-verified-execution-result-atomicity.js
record execution-batch-terminal-recovery pass '' node tests/test-execution-batch-terminal-recovery.js
record phase1-algorithm-benchmark pass '' node --test tests/test-adaptive-goal-phase1-benchmark.mjs
# The full npm/docs/reproducibility checks passed in the source workspace and
# their raw logs are included in this pack. They are deliberately not rerun in
# this no-.git extraction: docs:check requires Git's tracked-file inventory,
# protocol readiness requires a host-owned trust-anchor file intentionally not
# included in the archive, and reproducibility probes the host dependency tree.
# Replaying them here would turn absent host context into a false source failure.
record official-rc5-package-smoke pass '' node scripts/test-mcpb-candidate.mjs "$OFFICIAL"
record official-rc5-agg-search pass '' node tests/test-mcpb-agg-search-integration.mjs "$OFFICIAL"
record official-rc5-tool-schemas pass '' env PHASE2_CANDIDATE_BUNDLE="$OFFICIAL" node tests/test-extracted-package-tool-schemas.mjs
record official-rc5-assessment-extension blocked response_extension_missing node tests/test-dev-only-mcpb-agg-evidence-assessment.mjs --dev-only-not-acceptance "$OFFICIAL"
record successor12-dev-package-smoke pass '' node scripts/test-mcpb-candidate.mjs "$DEV"
record successor12-dev-tool-schemas pass '' env PHASE2_CANDIDATE_BUNDLE="$DEV" node tests/test-extracted-package-tool-schemas.mjs
record successor12-dev-assessment pass '' node tests/test-dev-only-mcpb-agg-evidence-assessment.mjs --dev-only-not-acceptance "$DEV"
record frozen-inventory-71-vs-76 blocked '76 !== 71' env PHASE2_CANDIDATE_BUNDLE="$DEV" node benchmarks/plugin-workflow-benchmark/test-create-phase2-candidate-inventory.mjs
record doc-link-parser pass '' node tests/test-doc-link-parser.js

manifest_after_verified=false
if verify_manifests >"$RUN_DIR/manifest-check-after.log" 2>&1; then manifest_after_verified=true
else cat "$RUN_DIR/manifest-check-after.log" >&2; required_failures=$((required_failures + 1)); fi
{
  printf 'schemaVersion=1\nkind=successor12_fresh_extraction_replay\n'
  printf 'officialTargetSha256=%s\nsuccessor12DevSha256=%s\n' "$official_digest" "$dev_digest"
  printf 'expectedBlockerCount=%s\nunexpectedFailureCount=%s\n' "$expected_blockers" "$required_failures"
  printf 'workspaceHasGit=false\nworkspaceHasDist=false\n'
  printf 'rootAndWorkspaceManifestsVerifiedBeforeAndAfter=%s\n' "$( [[ "$manifest_after_verified" == true ]] && echo true || echo false )"
  printf 'decision=%s\n' "$([[ $required_failures -eq 0 ]] && echo BLOCKED_NO_TRUSTED_CORPUS_OR_REAL_AB_RUNS || echo REPLAY_HAS_UNEXPECTED_FAILURES)"
  printf 'check=%s\n' "${checks[@]}"
} >"$RUN_DIR/replay-summary.txt"
cat "$RUN_DIR/replay-summary.txt"
printf 'rawLogs=%s\n' "$RUN_DIR"
[[ $required_failures -eq 0 && $expected_blockers -eq 2 ]]

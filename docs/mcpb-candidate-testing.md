# Fast MCPB candidate smoke test

Use the candidate smoke test when you want to check an existing `.mcpb` without installing it into Chat On Steroids or restarting the running plugin:

```sh
npm run test:mcpb-candidate -- artifacts/runalith-1.0.9-rc.5-candidate-agg-phase1-lineage-ts-order-20261022T024540Z.mcpb
```

Pass any canonical local path to a Runalith MCPB candidate. The command does not rebuild or overwrite the candidate.

The runner checks ZIP entry paths and symlink entries, extracts the bundle into a private temporary directory, verifies the Runalith manifest and launch entry point, then starts the **packaged** `server/index.js` with a minimal environment. It points the data directory, SQLite database, workspace and execution temp directory into that temporary directory; it does not inherit API keys or reviewer trust settings from the current shell. It sends MCP `initialize`, `tools/list`, and a read-only `orchestrator_health` request, checks runtime version and the manifest's exact tool names/count, validates tool input-schema shapes, and verifies the reported database path is temporary. The child process and temporary directory are removed on exit.

Typical successful output includes `MCPB_FAST_TEST=PASS`, the file's SHA-256, `manifest_tools`, `runtime_tools`, the isolated database path and elapsed time. A failed check exits non-zero and prints the failing assertion/diagnostic.

## What this check does not mean

This is a fast package/runtime smoke test only. It does not install the extension, call workflow approval or dispatch, perform the AGG fixture action, or replace the full extracted-package E2E, security regressions or reproducibility checks. The subprocess has isolated environment and state, but it is **not** an OS/container sandbox; only run candidates from a source you trust because the packaged entry point is executed as the current user.

The upstream MCPB CLI validates manifests and can pack, inspect or verify bundles, but its documented commands do not themselves launch the packaged MCP server and probe its live `tools/list` response. This repository script covers that runtime smoke-test gap.

## Verify source-to-bundle byte alignment

The candidate build invokes `scripts/verify-mcpb-source-alignment.mjs` before publishing the archive. It checks every ZIP entry against the exact regular source file in the selected repository snapshot; `manifest.json` maps to `plugin/manifest.json`, and the packaged `package.json` is checked against the documented dependency-closure projection. Missing files, symlinks, unsafe/duplicate ZIP paths, and byte drift fail closed. The report binds the archive SHA-256 and a deterministic digest over the exact packaged source entries plus critical build and acceptance inputs (including the Phase 1 scorer, frozen scenario specifications, protocol plan and freeze). The protocol runner consumes this result and blocks operational corpus/scoring readiness when the configured candidate is not source-aligned or the proposal does not bind the calculated source digest.

### Historical Phase-2 archive lineage diagnosis

When the frozen Phase-2 inventory regression reports that no candidate has exact current-source lineage, inspect the archive bytes against Git history before deciding whether the problem is source drift, a mixed/dirty build, or a separate frozen-path-count blocker:

```sh
node scripts/diagnose-phase2-archive-lineage.mjs > /tmp/phase2-archive-lineage.json
```

The diagnostic is read-only. It records each candidate's archive SHA-256, entry count, README content hash, current-worktree mismatches, closest Git trees, reachable-commit/blob matches, and whether mismatched payload blobs are absent from reachable Git trees. Its `sourceLineageClassification` distinguishes a known historical README from a mixed/unattributed source snapshot; it does not call historical drift proof of archive corruption. It excludes only generated local-runtime `package.json` metadata from exact source-blob scores; `manifest.json` is compared against `plugin/manifest.json`. A closest tree is only a content comparison: it does **not** establish who built the archive, whether the source tree was clean, or whether a reviewer approved it. The inventory regression enriches the no-exact-match failure with this forensic evidence but still exits nonzero and refuses to create an inventory. Do not use the result to edit an archive, regenerate expected hashes, trim entries, or change the frozen 71-path contract.

Unblock the gate only after a candidate is reproducibly built from one explicitly identified source snapshot, the full exact source-to-bundle verifier passes for every packaged path, and the inventory has exactly 71 paths under the unchanged contract. Preserve the historical archives and their hashes; if a matching build receipt/source snapshot cannot be independently established, keep the gate blocked and build a separately reviewed successor only after the remaining release gates pass.

Re-run the verifier on an existing candidate and write a **new** provenance report (the report path must not already exist):

```sh
npm run verify:mcpb-source-alignment -- \
  --bundle artifacts/agg-phase1-finalization-YYYYMMDDTHHMMSSZ/runalith-1.0.9-rc.5-agg-phase1-candidate.mcpb \
  --source-root "$PWD" \
  --output artifacts/agg-phase1-finalization-YYYYMMDDTHHMMSSZ/source-binary-provenance.json
```

The source-snapshot digest establishes byte alignment for the files actually shipped in the bundle; it is not a Git commit signature, reviewer approval, release authorization, production isolation attestation, or Phase 1 acceptance result. New reports expose three separate decisions: `byteIdentityStatus` describes exact archive-entry bytes; `sourceProvenanceStatus` distinguishes a clean Git tree, a dirty-but-byte-aligned tree, or unavailable Git provenance; and `releaseEligibility` remains `BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED` because this verifier cannot authenticate a build receipt or establish production authority. New reports also include `sourceGitState`: the HEAD commit, SHA-256 digests of the tracked diff and full porcelain status (without exposing local path names), and explicit `trackedWorkingTreeClean`/`workingTreeClean` booleans. A separate `sourceProvenanceSha256` binds this Git-state record to `sourceSnapshotSha256`; keeping the content snapshot and source-tree cleanliness separate preserves independent clean-clone reconstruction while still surfacing dirty/untracked state. A dirty-tree build can still be byte-aligned, but it must not be represented as if HEAD alone identifies the shipped source. Historical reports generated before these fields existed cannot be retroactively treated as having proved a clean tree or authenticated receipt. Run `npm run test:package-reproducibility` separately to verify independent rebuilds produce byte-identical archives; reproducibility is still not an authenticated build receipt.

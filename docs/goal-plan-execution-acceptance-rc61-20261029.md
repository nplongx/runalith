# RC.61 Goal/Idea → Plan → Execution acceptance — failed, superseded

Candidate `dist/runalith-1.0.9-rc.61-acceptance-inventory-fix-20261029.mcpb`, SHA-256 `4d8729cce8067aad55a8d32dbb2b12c011d9256d6683fef7e358c4e9328cb92b`.

The candidate-specific source-alignment, ZIP integrity, MCP fast test and 23/23 focused tests passed. Full `npm test` exited 1 because the acceptance-consistency CLI test fixture used a fixed timestamp and became stale relative to the verifier's one-hour default. The test was corrected without changing the stale-observation oracle; RC.62 is the successor.

The live host remains on RC.26. Host-connected read-only evidence still reports Goal/Idea snapshot hash `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`, `verified=false`, `eligibleForAttestation=false`, zero evidence-manifest entries; 60 jobs require individual reconciliation and 61 running tasks have no active lease rows. Missing leases do not prove worker death.

All six release blockers remain open. No production workflow/task mutation, trust-ledger write, external checkpoint transition, package activation, or Git history mutation occurred. RC.61 is not an accepted release candidate.

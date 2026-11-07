# Security policy

COS-AP validates message and execution-contract structure. It does not authenticate a sender, authorize a reviewer, approve a workflow, prove evidence lineage or guarantee provider delivery.

## Reporting a vulnerability

Do not publish exploitable details in a public issue. Use GitHub's private vulnerability reporting for this repository when enabled. Include the affected package version, input shape, expected behavior, observed behavior and a minimal reproduction. Do not include real credentials, private keys, production workflow records or personal data.

## Scope

In scope: unsafe schema resolution, validator bypasses, prototype/accessor execution, inconsistent wire/runtime validation, unsafe parsing and contract ambiguities that can cause a consumer to mis-handle security-relevant protocol data.

Out of scope: claims that structural validation alone provides authentication, authorization, trusted evidence, exactly-once delivery or process isolation. Those guarantees are not provided by this package.

# Contributing

Thanks for helping improve COS-AP. This repository owns the public message and durable execution contracts; it does not own Runalith workflow persistence, authorization or provider execution.

## Development setup

- Node.js 22.13 or newer.
- No third-party dependency installation is required for the package test suite.

```bash
npm test
npm pack --dry-run
```

When working from the Runalith monorepo, also run the host integration test:

```bash
npm run test:protocol
```

## Contract changes

Every contract change must include:

1. Updated JSON Schema and API reference when the public shape changes.
2. Valid and invalid fixtures covering the new behavior.
3. Compatibility analysis for source, wire and semantic behavior.
4. A versioning decision separating package SemVer from wire protocol version.
5. Consumer impact analysis for the Runalith host and external adopters.

Do not change approval, authorization, lease, evidence-lineage or dispatch semantics here. Those belong to host runtime owners.

## Pull requests

Keep changes focused. Include exact test commands and outcomes. Do not claim a schema or API change is backward-compatible merely because the JavaScript function signature remains unchanged.

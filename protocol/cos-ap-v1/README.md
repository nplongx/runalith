# @runalith/cos-ap

Standalone package boundary for Runalith's COS-AP v1 message contracts and the durable execution request/result validators currently colocated with them.

**Status:** extraction-ready package scaffold; experimental package version `0.1.0`; not published to npm and not yet split into its own GitHub repository. The host Runalith runtime currently consumes this package through `protocol/cos-ap-v1/index.js`.

## Responsibilities

- Define the `cos-ap` protocol identifier, wire version, message types and envelope shape.
- Validate execution batch/result payloads and durable execution request/result contracts.
- Publish the JSON Schemas for the envelope, batch, result and supported result payloads.
- Provide schema loading helpers for the packaged schema files.

## Non-responsibilities

- No workflow/job persistence or SQLite access.
- No approval, authorization, lease ownership, scheduling or dispatch decisions.
- No provider implementation, process execution, MCP transport or remote delivery.
- No claim that a valid message is authorized, trusted, executed or successful.

## Current consumers

The Runalith host imports the public `index.js` entry point from execution contracts, execution management, durable session transport, job storage and the MCP server. Consumers must not import package-private implementation details.

## Local development

Requires Node.js 22.13 or newer. Package tests use Node's built-in test runner and require no third-party dependencies.

```bash
npm test
```

The host-level protocol regression remains separate:

```bash
cd ../..
npm run test:protocol
```

## Documentation

- [Public API reference](API.md)
- [Subsystem boundary and extraction status](https://github.com/nplongx/runalith/blob/main/docs/subsystems/README.md)
- [Runalith architecture decision](https://github.com/nplongx/runalith/blob/main/docs/adr/0001-modular-monolith-first.md)
- [Runalith repository](https://github.com/nplongx/runalith)

The standalone source repository is [runalith-cos-ap](https://github.com/nplongx/runalith-cos-ap). The Runalith architecture catalog links to this repository's README and API reference; changes to the contract should update both the package source and the host integration tests.

## Contribution and security

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)

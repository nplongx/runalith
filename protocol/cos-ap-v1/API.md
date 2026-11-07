# Public API reference

This reference describes exports from `index.js`. Package version `0.1.0` is experimental; the API is not yet frozen for a `1.0.0` release.

## Protocol identity

| Export | Meaning |
|---|---|
| `COS_AP_PROTOCOL` | Protocol identifier: `cos-ap`. |
| `COS_AP_VERSION` | Wire protocol version: `1`. Separate from the npm package version. |
| `COS_AP_MESSAGE_TYPES` | Frozen list of recognized message types. |
| `COS_AP_SCHEMA_NAMES` | Frozen allowlist of schema names accepted by `schemaPath` and `readSchema`. |
| `MAX_EXECUTION_BATCH_ITEMS` | Maximum batch size: 32. |
| `MAX_EXECUTION_COMMAND_CHARS` | Maximum command length: 32,768 characters. |
| `MAX_EXECUTION_TIMEOUT_MS` | Maximum requested timeout: 600,000 ms. |
| `DurableExecutionResultStatus` | Frozen list of durable execution terminal/unknown states. |

## Envelope and payload operations

| Function | Contract |
|---|---|
| `createEnvelope(input)` | Creates and freezes an envelope, then validates both envelope and payload. |
| `validateEnvelope(value)` | Validates a COS-AP v1 envelope and returns the supplied value. Throws `TypeError` for invalid input. |
| `validatePayload(messageType, payload)` | Validates the payload contract implemented for the supplied message type. Unrecognized message types are rejected by `validateEnvelope`; payload types without a dedicated schema receive only the currently implemented generic-object validation. |
| `validateExecutionBatch(payload)` | Validates batch identity, item count, unique item IDs, command length, working directory and timeout bounds. |
| `validateExecutionResult(payload)` | Validates terminal item states, uniqueness and exact summary reconciliation. |

## Durable execution operations

| Function | Contract |
|---|---|
| `validateDurableExecutionRequest(value)` | Validates schema-versioned durable execution request fields, including job/task/lease identity, attempt, input commit and required evidence. |
| `validateDurableExecutionResult(value)` | Validates schema-versioned durable execution result fields, status-specific evidence and timestamp ordering. |

These durable execution validators are currently implemented in this package, but they do not yet have corresponding standalone JSON Schema files. Their schemas must be formalized before the package is considered stable.

## Schema access

| Function | Contract |
|---|---|
| `schemaPath(name)` | Returns the path of a named packaged schema. Rejects names outside `COS_AP_SCHEMA_NAMES` with `TypeError`. |
| `readSchema(name)` | Reads and parses an allowlisted packaged JSON Schema. Rejects unknown names with `TypeError`. |

Current schema names: `child-result`, `envelope`, `execution-batch`, `execution-result`, `provider-status`, `synthesis`.

## Compatibility rules

The current v1 validators are intentionally strict: they reject unknown envelope fields, unsupported message types and unknown fields in the typed batch/result objects. The published JSON Schemas also use `additionalProperties: false` for these shapes.

Consequences:

- Adding an envelope field is **not** automatically backward-compatible with existing v1 consumers.
- Adding a message type is **not** automatically backward-compatible because older validators reject it.
- Changing field meaning, requiredness, enum values, numeric bounds or status semantics is a contract change even if the JavaScript function signature stays unchanged.
- Treat changes to strict v1 wire shapes as protocol-breaking unless an explicit compatibility test proves old consumers continue to accept the new messages. Prefer a new protocol major version for breaking wire changes.
- Package SemVer and wire protocol version are separate axes. A package patch/minor release does not itself change `COS_AP_VERSION`.

Before package `1.0.0`, freeze the durable execution schemas, add consumer/provider contract fixtures, and define the supported compatibility window.

## Error behavior

Validation failures currently throw `TypeError`. Error messages are diagnostic text, not stable machine-readable error codes. Consumers must not branch on message text. A future stable API should add typed error codes without removing the current exception behavior in a compatible release.

## Security boundary

Validation establishes structural conformity only. It does not prove sender identity, reviewer authorization, trust-root validity, approval, producer lineage, provider outcome or exactly-once delivery. Those decisions remain owned by the calling runtime and its trust/evidence components.

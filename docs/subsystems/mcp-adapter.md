# MCP adapter and runtime composition

**Target boundary:** protocol/channel transport, MCP tool registration, DTO mapping and dependency composition. The target repository is `runalith-api-adapters`, which will contain MCP, legacy HTTP, Slack projection/delivery and external OpenClaw message adapters as distinct transport modules. Internal agent sessions/message queues stay in Agent Runtime. Business policy and domain persistence should live behind subsystem APIs.

## Current implementation

The package entrypoint points at a versioned file under `server/`. The current stdio MCP entrypoint (`server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js` in the checked-out package metadata) is a large monolithic file and contains substantial runtime, persistence, tool-handler and composition logic. It currently imports reusable runtime modules directly, including strict JSON parsing and COS-AP validators.

The separate root `server.js` is an HTTP/OpenAI tool-call adapter/composition path. It imports the singleton workflow store and execution/provider managers; it is not the same transport entrypoint as the versioned stdio MCP server. Keep these host adapters distinct in the decomposition map.

The adapter is therefore not yet a thin shell. It is a migration target, not a subsystem that can be independently extracted just by moving `server/`.

## Target responsibilities

- Own MCP stdio transport and JSON-RPC framing.
- Register public tool names and schemas.
- Validate transport-level input and map it to public subsystem DTOs.
- Compose implementations, configuration and lifecycle shutdown.
- Map subsystem result/error contracts to MCP responses without changing their semantics.

It must not own domain tables, issue SQL for other subsystems, reimplement authorization, or duplicate workflow/execution policy.

## Candidate public surface

The host's MCP tool catalog remains the external client surface. Internally, each handler should call a subsystem public API. Tool schemas are adapter contracts and must be versioned/tested separately from package APIs and persisted record schemas.

## Extraction gate

First replace direct DB and internal-module calls in the entrypoint with injected public ports. Keep existing MCP tool names and input/output behavior stable during migration. Only extract the adapter repository after it can compose independently versioned subsystem packages without bundling private implementation imports.

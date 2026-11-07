# WS2 Control contract candidate — V10.5 transport preservation addendum

**Status:** DRAFT / PROPOSED / NOT RATIFIED.  
**Lineage:** V9 `86365876b2677ce9f99aeb23df0a1b49bcaaeb271f744731883740002f3ceec5` + V10 `9fb54a38f1f97f41af6d969d6ec06fc8a779beddcf9128ce0049ffb74375b9e8` + V10.1 `345179cbe3a1affca10f42b8fe5094df971afbed78179857ac6d41a99e01bf97` + V10.2 `ca6e310b5ccc79edd4eb455d7ded6dce3b034d0341c3dc842d4fd96e29cacabd` + V10.3 `d794a15cd5a30f72cf766772bb19e9fdb6f8fa266c8e22d2e64313aff3c4c16c` + V10.4 `504da2d0e33f870ad63c06353197de84cfc9d1683d67db1f220a4b95ec25201a` + this addendum. Earlier versions remain immutable.

## 1. W8 two-field diagnostic preservation — exact runtime boundary

WS8 accepted the crosswalk-level principle that `domain_code` and `cause_code` must be preserved as two independent opaque values, without HTTP/retry/terminal inference. This remains `ACCEPTED_WITH_BLOCKERS_FOR_TRANSPORT_REPRESENTATION`, not schema/runtime ratification.

Direct source inspection in the isolated WS8 worktree confirms:

| WS8 source | SHA-256 | Observed shape |
|---|---|---|
| `workstreams/08-common-envelope-v1.schema.json` | `ba01c0c9f973ace4d4b438307338fef1f18e45f99dba2929ddd33696cbee18b2` | Outer envelope V1 has `additionalProperties=false`; its `payload` is a generic JSON object. No top-level error/domain/cause fields are defined. |
| `crates/runalith-protocol/src/mcp_service_v1.rs` | `1b7d7ed4090ad2d660150ae64d6bbc05f139954fb4258d4117b2cdb51758192c` | `McpServiceErrorV1` is `deny_unknown_fields` and contains only `code` + `message`; `McpServiceResponseV1.error` uses this closed type. |

WS2 independently tested the actual exported W8 Rust type using a temporary external crate under `/tmp` (no W8 source changes):

`CARGO_TARGET_DIR=/tmp/ws2-ws8-error-probe-target cargo run --manifest-path /tmp/ws2-ws8-error-probe/Cargo.toml --offline`

Result, exit 0:

- `PASS legacy MCP error V1: code=AUTHORITY_UNAVAILABLE message=unknown`
- `PASS MCP error V1 rejects separate domain_code/cause_code: unknown field 'domain_code', expected 'code' or 'message'`

The first attempted command with `--locked` failed only because this new temporary probe had no `Cargo.lock`; rerunning offline without `--locked` resolved dependencies from the local cache and completed successfully. No repository lockfile was modified.

### 1.1 Consequence

The existing Common Envelope V1 `payload` can structurally contain a producer-defined response object carrying `domain_code` and `cause_code`; that does not prove a route-specific payload schema or runtime forwarding implementation. The current generic MCP service `error` DTO cannot carry both fields: adding them directly is rejected by the closed V1 struct. Therefore WS8's accepted two-field boundary is not yet proven for the current `McpServiceResponseV1.error` path.

WS8 must clarify whether WS2 errors will travel in a typed producer-owned response `payload` or require a versioned successor to `McpServiceErrorV1` / `McpServiceResponseV1`. Do not add unknown fields to V1, weaken `deny_unknown_fields`, alias `code` to one field while dropping the other, or flatten `cause_code` into message text. Preserve separate exact fields through the chosen versioned route contract before runtime acceptance.

## 2. Review request sent

WS2 sent WS8 a successor review under correlation `COS-A2A-WS2-WS8-MCP-SERVICE-DIAGNOSTICS-20261103`, asking for an exact typed payload/error envelope decision and confirmation that V1 remains unchanged. This is a design question, not authorization for WS2 to edit WS8 files.

## 3. Overall status

The V2.1 diagnostic inventory/source-attribution and two-field logical boundary are structurally validated. WS8 previously accepted the transport preservation principle with blockers. The exact current MCP service error DTO is proven not to preserve both fields; runtime preservation remains NOT PROVEN until WS8 issues and tests a versioned typed response contract. No W8 source, schema, route, HTTP status, retry policy, production Control endpoint or deployment was changed.

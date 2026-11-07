# Changelog

All notable changes to this package are recorded here. Package releases and COS-AP wire protocol versions are independent.

## 0.1.0 — 2026-10-31

- Establish the standalone package metadata and explicit public export entry point.
- Document COS-AP envelope, batch/result and durable execution validators.
- Publish the existing six JSON Schemas with the package.
- Restrict schema lookup to the explicit `COS_AP_SCHEMA_NAMES` allowlist.
- Add standalone public API tests and package CI.
- Experimental: durable execution request/result schemas and a stable machine-readable validation error model remain future work.

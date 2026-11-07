# Domain Docs

This repository uses a single-context domain documentation layout.

## Before exploring

Read `CONTEXT.md` at the repository root, if it exists, and read relevant architecture decision records under `docs/adr/`.

If these files do not exist, proceed silently. Do not create them upfront. The domain-modeling workflow creates them when domain terms or significant decisions are resolved.

## File structure

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/
```

## Glossary

Use canonical terms defined in `CONTEXT.md` in issue titles, proposals, hypotheses, tests, and code. When a required concept is missing, identify the vocabulary gap for domain modeling rather than inventing an inconsistent synonym.

## Architecture decisions

Surface conflicts with existing ADRs explicitly. Create an ADR only for a decision that is hard to reverse, surprising without context, and the result of a genuine trade-off.

# AGENTS.md — Raphah Engineering Harness & Operating Guidelines

Welcome! This file provides operating instructions, architectural boundaries, and guidelines for working with the `D-Raphah` repository.

## Repository Layout

- `lead-engine/` — Internal opportunity discovery and revenue pipeline operating system.
- `delivery-tool/` — Independent client delivery workspace, implementation blueprints, and handover management.
- `website/` — Public Raphah.io marketing experience and consultation entry point.
- `docs/` — PRD, technical runbooks, architecture decision records, and operational guides.

## Architectural Boundaries & Operating Rules

1. **Product Independence**:
   - `Lead Engine` and `Delivery Tool` are separate products with independent data boundaries.
   - **No direct database access** between the Lead Engine and Delivery Tool. All integration occurs via versioned contract endpoints (`LeadEngineHandoffPackage`).

2. **Deterministic & Compliance Controls**:
   - **No automated LinkedIn scraping**, login automation, CAPTCHA bypass, or access control circumvention.
   - **No automated outreach sending in MVP**. The system drafts messages; a human approves and sends them.
   - **No source runs until its policy is explicitly approved and active**.
   - **No model suggested requirement becomes authoritative** without an identified human validator (`humanValidatorId`).
   - **No requirement baseline can freeze** if any `Must` requirement has blocking questions or is unvalidated.
   - **Every handoff package must compute and verify a SHA-256 manifest checksum**.

3. **Verification & Testing Commands**:

To build and test the entire monorepo:

```bash
pnpm build
pnpm test
```

To run individual service tests:

```bash
cd lead-engine && pnpm test
cd delivery-tool && pnpm test
```

## Backlog & Definition of Done

Any code change or feature addition must satisfy:
1. Business criteria pass and behavior is demonstrated.
2. Unit, integration, and contract test coverage is updated.
3. Hard compliance constraints (policy checks, human approval, checksum verification) are enforced.
4. Clean build with zero TypeScript or lint errors.

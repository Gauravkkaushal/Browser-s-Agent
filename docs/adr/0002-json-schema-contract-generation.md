# ADR 0002: Single Source of Truth via JSON Schema Contract Generation

## Status
Proposed (Phase 2 Architecture)

## Context
As documented in `docs/audit/AUDIT.md` (Finding CON-01), the TypeScript client (`src/shared/types/netrashield.ts`) and the Python server (`server/schemas.py`) suffer from schema drift. The frontend defines `SanitizedPayload` with `schemaVersion: 'netrashield.sanitized.v1'` and `privacySummary`, while the Python server defines `Observation` with `interactive_elements`, `sensitive_boxes`, and `ocr_regions`. Furthermore, changes to server response models (such as the recent update to `/health` in commit `862a299`) broke evaluation scripts (`server/eval/run_smoke.py:266`) because contracts are declared manually in two different languages without validation.

## Decision
1. Establish `contracts/netrashield.sanitized.v1.schema.json` as the canonical Single Source of Truth for all wire contracts between client and server.
2. Maintain `contracts/envelope.v1.schema.json` for WebSocket message framing.
3. Add a code-generation script (`scripts/generate_contracts.py`) that generates:
   - TypeScript interfaces with branded types in `src/shared/contracts/`.
   - Python Pydantic v2 models with `model_config = ConfigDict(extra="forbid")` in `server/schemas/`.
4. Add a CI gate asserting that generated files are in sync with `contracts/*.json`.

## Consequences
### Positive
- Zero manual synchronization or copy-pasting of field names between TypeScript and Python.
- Complete contract immutability with `extra="forbid"`, preventing silent payload tampering or unexpected field leakage.
- Automatic verification in CI prevents merging PRs that introduce breaking schema changes.

### Negative / Trade-offs
- Developers must edit the JSON schema and run code generation rather than directly modifying Python or TS type files.

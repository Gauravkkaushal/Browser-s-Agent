# ADR 0003: Pure Core Architecture & Dependency Inversion

## Status
Proposed (Phase 2 Architecture)

## Context
Currently, perception, PII detection, redaction, and action execution logic are intertwined with DOM lookups (`document.querySelectorAll`, `window.getComputedStyle`), Canvas manipulations, Chrome extension APIs (`chrome.runtime`, `chrome.tabs`), and WebSocket network calls. This makes unit testing impossible without mocking entire browser environments or using `new Function(...)` to slice code out of uncompiled script files (as observed in `src/test/redaction.test.ts`).

## Decision
Adopt a strict Hexagonal / Clean Architecture:
1. `src/core/`:
   - `core/perception/`: Pure geometry functions, role deduction logic, stable ID generation (`computeNid`, `fnv1a`), and visibility scoring.
   - `core/privacy/`: Pure PII detectors, Luhn/Verhoeff checksum algorithms, surrogate mapping, and `SanitizedPayload` builder.
   - `core/actions/`: Pure action proposal schemas, parameter validators, and pre/post-condition checks.
2. Rule: `core/` files have ZERO imports from React, React-DOM, Ant Design, Node.js libraries, or `chrome.*` APIs.
3. All side effects, DOM querying, network I/O, and platform-specific calls belong exclusively in `src/adapters/` and `src/app/`.

## Consequences
### Positive
- Sub-second unit test execution with 100% test coverage of core privacy logic using standard Vitest in pure Node.
- Enforceable layer boundaries using ESLint rules (`eslint-plugin-boundaries`).
- Architectural resilience: core privacy algorithms can be embedded in Node, Python (via wasm or transpilation), or other browsers (Firefox MV2/MV3) without rewriting detection logic.

### Negative / Trade-offs
- Requires passing plain data structures (e.g., `ElementSnapshot`) instead of raw DOM element references into `core/`.

# ADR 0001: Multi-Entry TypeScript Bundling via Vite

## Status
Proposed (Phase 2 Architecture)

## Context
Currently, `public/agent-background.js` (1,265 lines) and `public/agent-content.js` (2,101 lines) are written in raw JavaScript directly inside `public/`. Vite copies `public/` files into `dist/` verbatim without compiling, typechecking, or linting them. As identified in `docs/audit/AUDIT.md` (Finding ARC-01), the most critical privacy algorithms and security walls run completely outside TypeScript's type safety net. A syntax error or undefined variable in `agent-content.js` is undetected during `npm run build` and only surfaces at runtime in the user's browser.

## Decision
Configure Vite to compile four distinct entry points from `src/`:
1. `src/app/popup/index.html` -> Popup UI (`dist/index.html`)
2. `src/app/background/index.ts` -> Service Worker (`dist/agent-background.js`)
3. `src/app/content/index.ts` -> Content Script (`dist/agent-content.js`)
4. `src/app/offscreen/index.ts` -> Offscreen Document Worker (`dist/offscreen.js`)

Each entry point will be compiled from TypeScript with strict type checking, ES2022 target, and full source map support in development.

## Consequences
### Positive
- Strict TypeScript type safety across service worker, content script, and offscreen document.
- Dead-code elimination and tree shaking for imported dependencies.
- Shared code between background, content script, and popup without manual duplication.
- Centralized ESLint and type checking with `npm run build`.

### Negative / Trade-offs
- Build time increases slightly (~5-10s) due to compiling multiple Rollup entry points.
- Output filenames must remain strictly compatible with `manifest.json` expectations (`agent-background.js`, `agent-content.js`).

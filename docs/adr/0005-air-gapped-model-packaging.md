# ADR 0005: Air-Gapped Asset Management & Git Hygiene

## Status
Proposed (Phase 2 Architecture)

## Context
As documented in `docs/audit/AUDIT.md` (Finding SEC-07), the repository currently tracks:
- A 45.92 MB production zip archive (`netrashield-extension-v2.0.0-production.zip`).
- 76.52 MB of unbundled model weights, WASM binaries, and language packs in `public/models/`, `public/transformers/`, and `public/tesseract/`.

Committing large binaries and build archives into git bloats repository history, makes cloning over slow connections difficult, and violates Hard Rule 4 ("No secrets, model weights or large binaries in git...").

## Decision
1. **Untrack Build Archives**:
   - Remove `netrashield-extension-v2.0.0-production.zip` from git tracking and add `*.zip` to `.gitignore`.
2. **Deterministic Checksum-Pinned Asset Retrieval**:
   - Provide `scripts/fetch_offline_assets.mjs` with hardcoded SHA-256 hashes for all required ONNX and WASM assets:
     - `text_model_quantized.onnx`
     - `vision_model_quantized.onnx`
     - `tesseract-core-simd-lstm.wasm`
     - `eng.traineddata.gz`
     - `ort-wasm-simd-threaded.wasm`
   - Assets are cached locally in `.cache/models/` and verified against their pinned hashes at build time.
3. **Packaging for Releases**:
   - GitHub Actions release workflow packages the extension zip with all verified offline assets included, publishing artifacts directly to GitHub Releases.

## Consequences
### Positive
- Git repository size shrinks dramatically, enabling fast cloning and clean history.
- Supply-chain integrity is strictly enforced through cryptographic SHA-256 verification.
- Conforms to Hard Rule 4.

### Negative / Trade-offs
- A fresh clone requires running `node scripts/fetch_offline_assets.mjs` (or `npm run prepare`) before building if models are not present locally.

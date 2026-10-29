# ADR 0004: Offline Fail-Closed Verification & Local AI Grounding

## Status
Proposed (Phase 2 Architecture)

## Context
Visual perception and screenshot redaction present unique failure modes:
1. Coordinate drift: device pixel ratio, viewport scrolling, and CSS transforms can cause bounding boxes calculated in DOM space to drift when mapped to raw pixels captured by `chrome.tabs.captureVisibleTab`.
2. Image text / QR codes: text embedded in images, charts, and QR codes cannot be read by DOM text traversal.
3. Air-gap compliance: the system must prove that OCR and CLIP grounding never send unredacted pixels over the internet.

## Decision
1. **Raw Canvas Blackout**:
   - `captureRedacted()` draws the raw bitmap to an offscreen canvas and applies solid blackout masks (`ctx.fillRect`) over all sensitive bounding boxes and QR code locations before exporting the JPEG.
2. **On-Device Secondary Verification (Re-OCR)**:
   - The *already-redacted* JPEG is sent to the local offscreen document running bundled Tesseract.js (WASM) with offline English models (`eng.traineddata.gz`).
   - If re-OCR detects any PII pattern on the redacted screenshot, the redaction wall triggers a **fail-closed state**: `obs.screenshot = null` with `obs.ocr_leak_detected = true`. The image is strictly withheld.
3. **Local-Only CLIP Grounding**:
   - MobileCLIP-S0 ONNX model runs locally in ONNX Runtime Web (WASM single-thread). It scores the top candidate elements visually to assist grounding without inventing clicks or exporting raw images.
4. **Offline Assertion**:
   - `env.allowRemoteModels = false` and `env.allowLocalModels = true` are enforced. All remote URL fetches in offscreen workers are blocked.

## Consequences
### Positive
- Mathematically provable fail-closed security: any leak in visual masking withholds the entire image rather than sending a partially redacted capture.
- Total offline operation with zero CDN or external AI dependencies.

### Negative / Trade-offs
- Local WASM OCR and CLIP inference add ~200-400ms latency to observation cycles where screenshots are captured.

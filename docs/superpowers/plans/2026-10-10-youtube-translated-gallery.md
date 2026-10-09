# YouTube translated gallery implementation

Goal: a single public YouTube link becomes reviewed Chinese gallery images with immutable source transcript comparison.
Architecture: existing MediaService/JobStore, dedicated translation helper, GalleryService native/translated branch, existing preview/render/package integrity checks and React workspace.
Tech Stack: TypeScript, yt-dlp, whisper.cpp, FFmpeg, existing OpenAI SDK and Playwright.
Spec: ../specs/2026-10-10-youtube-translated-gallery.md
Global Constraints: isolated worktree; no remote branch push; no real storage fixture writes; no hidden Cookies or auto publishing; server controlled source/provenance; never silently truncate.
Review Focus: captions source ordering, invalid timings/rolling text, source/version/hash invalidation, prompt/output injection, image text overflow, native regression.

### Task 1: YouTube ingestion and long request reliability
RED: platform routing/JSON3 selection and malformed/rolling cues/ASR language tests. GREEN: yt-dlp video and captions, metadata + source provenance, captions first jobs, ASR auto fallback, explicit runtime/FFmpeg integration; skip Douyin source fetch for YouTube. Verify existing media/jobs/asr tests. Touch src/lib/media*,youtube*,asr*,jobs*,types.ts; config app/server/electron; source text frontend deferred Task 3.
Interfaces: export isYouTubeUrl(url); MediaService.readYouTubeCaptions(jobId,duration) returns {text,segments,language,model,provider} or null. AsrService.transcribe(audioPath,language?) preserves old zh default. Optional ytDlpJsRuntime configuration; old mock MediaService callers tolerated.

### Task 2: Translation and text rendering
RED: exact ID alignment, incomplete/truncated output, batch coverage, grouping capacity/35 limit, overflow and HTML escaping. GREEN: GalleryTranslator.translate(cues) returns all immutable original/time cues with Chinese text; planTranslatedGallery(translation,targetLines,duration) produces GalleryPlan proposal. renderTranslatedGallery takes frame callback and screenshot via existing browser resolution, embeds only local data URLs and escaped text, rejects overflow; GalleryMedia.render routes only translatedCaptions. No new deps.
Interfaces: GalleryTranslationCue {segmentIndex,original,text,start,end}; helper constructor resolveAiConfig/createClient like GalleryCopyWriter. Caption length<=240; reduce per-image count with real rendering overflow failure. Render output deterministic1080x1440, 6～9 target, readable text, original at UI not image.

### Task 3: Gallery service, routes and UI
RED: translated source immutable, source/hash/version conflicts, edits invalidate plan/generated, confirmed preview required, original native unchanged. GREEN: add mode/translation types; translation endpoints; plan native/translated branch; image safety; reuse full preview render and package consistency checks. UI mode creation, explicit source label, range controls, bilingual editable translations, save/replace safety, plan preview labels, long API timeout. Config translation writer to existing AI resolver. Update README with actual usage and Skills applied.

### Task 4: Acceptance and review
Run targeted + full npm test, npm run check, backend/electron/renderer builds. Isolated actual FFmpeg/Chromium rendering and UI workflow; attempt supplied real YouTube URL without default cookies. Review diff with fresh reviewer, fix meaningful issues and rerun affected checks. Record verification limitations; leave local change reviewable, no remote push in this approval scope.

Execution: independent Task1/2 modules delegated under dispatching-parallel-agents; root owns shared gallery types, Task3 and integration. Each implementer reads spec, performs RED/GREEN, reports files/tests/limitations. No per-task commits necessary before final complete verification. Preflight: Task1 transcript contract matches Task3 selection; Task2 consumes root owned gallery types exactly; root app assembly after download agent completion to avoid shared edit.

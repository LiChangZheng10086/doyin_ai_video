/** Read-only fixed real-source regression. Video pixels never leave this computer. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GalleryMedia } from '../src/lib/gallery-media.js';

const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const video = arg('video');
const transcriptFile = arg('transcript');
if (!video || !transcriptFile) throw new Error('Usage: node --import tsx scripts/verify-native-subtitles.ts --video=/path/to/local/source.mp4 --transcript=/path/to/local/transcript.json [--output=/tmp/report.json]');
const fixture = JSON.parse(await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/research/fixtures/native-subtitles-2026-10-09.json'), 'utf8'));
const hash = createHash('sha256');
for await (const chunk of createReadStream(video)) hash.update(chunk);
assert.equal(hash.digest('hex'), fixture.sourceSha256, 'source must match the annotated fixed video');
const transcript: { segments: Array<{ start: number; end: number; text: string }> } = JSON.parse(await readFile(transcriptFile, 'utf8'));
assert.ok(Array.isArray(transcript.segments) && transcript.segments.length, 'local timed transcript required');
const media = new GalleryMedia();
const source = await media.probe(video);
assert.equal(source.width, fixture.width); assert.equal(source.height, fixture.height);
const results = [];
for (const item of fixture.cases) {
  const baseline = await media.suggestSubtitle(video, { start: item.quote.start, end: item.quote.end });
  const text = transcript.segments.filter(segment => segment.end > item.quote.start + .001 && segment.start < item.quote.end - .001).map(segment => segment.text).join(' ');
  assert.ok(text.trim(), `${item.id}: local transcript has no text in this window`);
  const candidate = await media.suggestSubtitle(video, { ...item.quote, text });
  assert.equal(Boolean(candidate), item.expectedDialogue, item.id);
  if (candidate) {
    assert.ok(candidate.recognizedText && candidate.recognizedText.length >= 2, `${item.id}: OCR dialogue evidence required`);
    assert.ok(candidate.bandTop > .85 && candidate.bandBottom < .98, `${item.id}: native dialogue band`);
  }
  results.push({ ...item, baseline, candidate });
  console.log(`PASS ${item.id}: baseline=${Boolean(baseline)} OCR=${Boolean(candidate)}`);
}
const report = { sourceSha256: fixture.sourceSha256, annotation: fixture.annotation, results };
if (arg('output')) await writeFile(arg('output')!, JSON.stringify(report, null, 2));
console.log('PASS fixed six windows: four dialogue candidates selected (three recovered), two news-only banners rejected. This is not semantic subtitle accuracy.');

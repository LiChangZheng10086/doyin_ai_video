import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSkillProgressLine } from './skill-progress.js';

test('skill progress parser preserves normal progress events', () => {
  assert.deepEqual(
    parseSkillProgressLine('{"stage":"extracting_item","progress":12,"current":1,"total":65}'),
    { stage: 'extracting_item', progress: 12, current: 1, total: 65 },
  );
});

test('skill progress parser exposes streamed backend errors', () => {
  assert.throws(
    () => parseSkillProgressLine('{"stage":"error","success":false,"error":"HTTP 520"}'),
    /HTTP 520/,
  );
});

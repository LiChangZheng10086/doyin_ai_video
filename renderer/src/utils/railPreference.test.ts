import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStoredRailExpanded, writeStoredRailExpanded } from './railPreference.js';

const KEY = 'douyin-ai-video.rail-expanded';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test('readStoredRailExpanded defaults to collapsed when the key is missing', () => {
  assert.equal(readStoredRailExpanded(memoryStorage() as unknown as Storage), false);
});

test('readStoredRailExpanded only accepts the stored "1" as expanded', () => {
  assert.equal(readStoredRailExpanded(memoryStorage({ [KEY]: '1' }) as unknown as Storage), true);

  for (const invalid of ['0', 'yes', 'true', '']) {
    assert.equal(
      readStoredRailExpanded(memoryStorage({ [KEY]: invalid }) as unknown as Storage),
      false,
      `"${invalid}" 应视为收起`
    );
  }
});

test('readStoredRailExpanded falls back to collapsed when storage throws', () => {
  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
  } as unknown as Storage;

  assert.equal(readStoredRailExpanded(blocked), false);
});

test('writeStoredRailExpanded persists a boolean-semantic value', () => {
  const storage = memoryStorage();

  writeStoredRailExpanded(storage as unknown as Storage, true);
  assert.equal(storage.values.get(KEY), '1');
  assert.equal(readStoredRailExpanded(storage as unknown as Storage), true);

  writeStoredRailExpanded(storage as unknown as Storage, false);
  assert.equal(storage.values.get(KEY), '0');
  assert.equal(readStoredRailExpanded(storage as unknown as Storage), false);
});

test('writeStoredRailExpanded never throws when storage is unavailable', () => {
  const blocked = {
    setItem: () => {
      throw new Error('quota exceeded');
    },
  } as unknown as Storage;

  assert.doesNotThrow(() => writeStoredRailExpanded(blocked, true));
});

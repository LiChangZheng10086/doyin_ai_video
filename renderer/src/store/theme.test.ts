import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeTheme, useThemeStore } from './theme.js';

function environment(app: unknown = {}, saveError = false) {
  const media = new EventTarget() as EventTarget & { matches: boolean }; media.matches = false;
  const root = { dataset: {} as Record<string, string> };
  const writes: unknown[] = [];
  const target = Object.assign(new EventTarget(), {
    document: { documentElement: root }, matchMedia: () => media,
    electron: { getConfig: async () => ({ app }), saveConfig: async (value: unknown) => { if (saveError) throw new Error('private detail'); writes.push(value); } },
  }) as unknown as Window;
  return { target, root, writes, change(dark: boolean) { media.matches = dark; media.dispatchEvent(new Event('change')); } };
}

test('old unused system preference stays dark; chosen theme is saved without unrelated settings', async () => {
  const env = environment({ theme: 'system', firstRun: false }); const close = await initializeTheme(env.target);
  try {
    assert.equal(env.root.dataset.theme, 'dark');
    await useThemeStore.getState().setPreference('light');
    assert.equal(env.root.dataset.theme, 'light');
    assert.deepEqual(env.writes, [{ app: { theme: 'light', themeConfigured: true } }]);
  } finally { close(); }
});

test('saved system follows OS; manually selected dark ignores later OS changes; cleanup detaches listener', async () => {
  const env = environment({ theme: 'system', themeConfigured: true }); const close = await initializeTheme(env.target);
  assert.equal(env.root.dataset.theme, 'light'); env.change(true); assert.equal(env.root.dataset.theme, 'dark');
  await useThemeStore.getState().setPreference('dark'); env.change(false); assert.equal(env.root.dataset.theme, 'dark');
  await useThemeStore.getState().setPreference('system'); assert.equal(env.root.dataset.theme, 'light');
  close(); env.change(true); assert.equal(env.root.dataset.theme, 'light');
});

test('failed persistence retains chosen appearance but reports it was not saved', async () => {
  const env = environment({}, true); const close = await initializeTheme(env.target);
  try { await useThemeStore.getState().setPreference('light'); assert.equal(env.root.dataset.theme, 'light'); assert.match(useThemeStore.getState().error, /未保存/); assert.doesNotMatch(useThemeStore.getState().error, /private detail/); }
  finally { close(); }
});

test('browser storage restores choice; denied storage does not crash or claim persistence', async () => {
  const env = environment(); const data = new Map<string, string>();
  Reflect.deleteProperty(env.target, 'electron');
  Object.defineProperty(env.target, 'localStorage', { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
  let close = await initializeTheme(env.target); await useThemeStore.getState().setPreference('light'); close();
  close = await initializeTheme(env.target); assert.equal(env.root.dataset.theme, 'light'); close();
  Object.defineProperty(env.target, 'localStorage', { get() { throw new Error('denied'); } });
  close = await initializeTheme(env.target);
  try { assert.equal(env.root.dataset.theme, 'dark'); await useThemeStore.getState().setPreference('light'); assert.match(useThemeStore.getState().error, /未保存/); }
  finally { close(); }
});

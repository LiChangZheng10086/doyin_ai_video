import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { createAppRouter } from './appRouter.js';
afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });

// A minimal browser boundary; the actual React Router matches and navigates the routes.
function browser(url: string): Window {
  let location = new URL(url); let state: unknown = null;
  return {
    get location() { return location; },
    document: { createElement: () => ({}), querySelector: () => null },
    history: {
      get state() { return state; },
      replaceState(next: unknown, _title: string, href?: string) { state = next; if (href) location = new URL(href, location); },
      pushState(next: unknown, _title: string, href: string) { state = next; location = new URL(href, location); },
      go() {},
    },
    addEventListener() {}, removeEventListener() {},
  } as unknown as Window;
}

test('file startup and bookmarked hash paths stay inside the shell instead of router 404', async () => {
  for (const url of ['file:///Applications/Test.app/Contents/Resources/app.asar/dist-renderer/index.html', 'file:///tmp/app/dist-renderer/index.html#/hotspots?tab=favorites']) {
    const target = browser(url);
    Object.defineProperty(globalThis, 'window', { value: target, configurable: true });
    const router = createAppRouter([{ path: '/', id: 'home' }, { path: '/hotspots', id: 'hotspots' }], target);
    try {
      assert.equal(router.state.errors, null);
      assert.equal(router.state.matches.at(-1)?.route.id, url.includes('#') ? 'hotspots' : 'home');
      await router.navigate('/hotspots?source=zhihu');
      assert.equal(router.state.matches.at(-1)?.route.id, 'hotspots');
      assert.equal(target.location.hash, '#/hotspots?source=zhihu');
    } finally { router.dispose(); }
  }
});

test('Vite HTTP deep links retain normal browser navigation', async () => {
  const target = browser('http://localhost:5173/hotspots?source=douyin');
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true });
  const router = createAppRouter([{ path: '/', id: 'home' }, { path: '/hotspots', id: 'hotspots' }], target);
  try {
    assert.equal(router.state.errors, null); assert.equal(router.state.matches.at(-1)?.route.id, 'hotspots');
    await router.navigate('/'); assert.equal(target.location.pathname, '/'); assert.equal(target.location.hash, '');
  } finally { router.dispose(); }
});

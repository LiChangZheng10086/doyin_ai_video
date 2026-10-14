// npm run dev, then playwright-cli run-code --filename scripts/verify-publishing-thumbnails-ui.js
async (page) => {
  const requests = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VioAAAAASUVORK5CYII=', 'base64');
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(path);
    if (request.method() !== 'GET') throw new Error(`Unexpected write: ${path}`);
    if (request.headers()['x-local-session'] !== 'thumbnail-test-session') throw new Error('Missing image authentication header');
    await route.fulfill({ status: path.includes('/broken/') ? 404 : 200, contentType: 'image/png', body: png });
  });
  await page.route('http://localhost:5173/thumbnail-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: `<div id="fixture"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>`,
  }));
  try {
    await page.goto('http://localhost:5173/thumbnail-fixture');
    await page.evaluate(async () => {
      const moduleText = await fetch('/src/pages/PublishingPage.tsx').then(response => response.text());
      const reactUrl = moduleText.match(/from "([^"]+\/react\.js[^\"]*)"/)[1];
      const React = (await import(reactUrl)).default;
      const { createRoot } = (await import(reactUrl.replace('/react.js', '/react-dom_client.js'))).default;
      const { PackageRow } = await import('/src/pages/PublishingPage.tsx');
      const { apiClient } = await import('/src/services/api.ts');
      apiClient.setLocalSession('thumbnail-test-session');
      const root = createRoot(document.getElementById('fixture'));
      window.renderThumbnailRows = cases => root.render(React.createElement('div', null, cases.map(pkg =>
        React.createElement('section', { key: pkg.id, 'data-case': pkg.id }, React.createElement(PackageRow, {
          detail: { package: { title: pkg.id, version: 1, state: 'active', assetHealth: 'healthy', createdAt: '2026-10-14T00:00:00Z', createdBy: { displayName: 'test' }, ...pkg }, tasks: [], audit: [] },
          sourceJobId: '', role: 'admin', expanded: false, busy: false, onToggle() {}, async onAction() {},
        })))));
    });
    await page.evaluate(() => window.renderThumbnailRows([
      { id: 'note', contentType: 'note', imagePaths: ['images/01.png', 'images/02.png'], coverPath: '/unused-cover.jpg' },
      { id: 'note-no-cover', contentType: 'note', imagePaths: ['images/01.png'] },
      { id: 'video', contentType: 'video', imagePaths: ['images/01.png'], coverPath: '/cover.jpg' },
      { id: 'article', contentType: 'article', imagePaths: ['images/01.png'], coverPath: '/cover.jpg' },
      { id: 'empty-note', contentType: 'note', imagePaths: [] },
      { id: 'no-cover', contentType: 'article', imagePaths: ['images/01.png'] },
      { id: 'broken', contentType: 'note', imagePaths: ['images/01.png'] },
    ]));
    for (const id of ['note', 'note-no-cover', 'video', 'article']) {
      await page.waitForFunction(id => {
        const image = document.querySelector(`[data-case="${id}"] img`);
        return image?.complete && image.naturalWidth > 0;
      }, id, { timeout: 5000 });
    }
    for (const expected of ['/api/publishing/packages/note/images/0', '/api/publishing/packages/note-no-cover/images/0', '/api/publishing/packages/video/cover', '/api/publishing/packages/article/cover', '/api/publishing/packages/broken/images/0']) {
      if (!requests.includes(expected)) throw new Error(`Missing request: ${expected}; got ${requests}`);
    }
    if (requests.length !== 5) throw new Error(`Unexpected image requests: ${requests}`);
    for (const id of ['empty-note', 'no-cover', 'broken']) {
      if (await page.locator(`[data-case="${id}"] img`).count()) throw new Error(`${id} must retain placeholder`);
    }
    const urls = await page.locator('img').evaluateAll(images => images.map(image => image.src));
    await page.evaluate(() => window.renderThumbnailRows([{ id: 'note', contentType: 'note', imagePaths: [] }]));
    await page.waitForFunction(() => !document.querySelector('[data-case="note"] img'));
    await page.evaluate(() => window.renderThumbnailRows([]));
    await page.waitForFunction(() => !document.querySelector('img'));
    const revoked = await page.evaluate(async urls => Promise.all(urls.map(url => fetch(url).then(() => false, () => true))), urls);
    if (revoked.some(value => !value)) throw new Error('Object URL leaked after unmount');
    return 'PASS: note uses first image; video/article keep cover; missing/failed images keep placeholder; blob URLs released';
  } finally {
    await page.goto('about:blank');
    await page.unroute('**/api/**');
    await page.unroute('http://localhost:5173/thumbnail-fixture');
  }
}

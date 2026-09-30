// Run against the isolated --serve API: playwright-cli run-code --filename scripts/verify-online-audio-ui.js
async (page) => {
  const tracks = [1, 2].map(id => ({ key: `netease:${id}`, source: 'netease', trackId: String(id), title: `回归歌曲 ${id}`, artist: '测试歌手', url: `https://music.163.com/song?id=${id}` }));
  const assets = tracks.map((track, index) => ({ id: `test-asset-${index}`, kind: 'audio', filename: `${index}.mp3`, originalName: track.title, bytes: 10, createdAt: '2026-09-30T00:00:00Z', audioSource: { platform: track.source, trackId: track.trackId, title: track.title, artist: track.artist, url: track.url, previewOnly: false } }));
  const items = tracks.map((track, i) => ({ id: `item-${i}`, track, status: 'queued' }));
  let stage = 0;
  let releaseOld;
  let oldSeen = false;
  const oldResponseGate = new Promise(resolve => { releaseOld = resolve; });
  await page.route('**/api/assets?kind=*', async route => {
    const requestStage = stage;
    if (route.request().url().includes('kind=audio') && requestStage === 1) { oldSeen = true; await oldResponseGate; }
    await route.fulfill({ json: { assets: route.request().url().includes('kind=audio') ? assets.slice(0, requestStage) : [] } });
  });
  await page.route('**/api/online-audio/imports/test-batch', async route => {
    stage = oldSeen ? 2 : 1;
    await route.fulfill({ json: { batch: { id: 'test-batch', items: items.map((item, i) => ({ ...item, status: i < stage ? 'succeeded' : 'queued', assetId: i < stage ? assets[i].id : undefined })) } } });
  });
  try {
    await page.evaluate(batch => sessionStorage.setItem('douyin-ai-video.online-audio-batch', JSON.stringify(batch)), { id: 'test-batch', items });
    await page.reload();
    await page.getByRole('button', { name: '在线音频', exact: true }).click();
    const audioHeading = page.getByRole('heading', { name: /^音频/ });
    await page.waitForFunction(() => [...document.querySelectorAll('h2')].some(el => /音频.*\(2\)/.test(el.textContent)), undefined, { timeout: 8000 });
    releaseOld();
    // The response was held only to force an older list to finish after the new list.
    await page.waitForTimeout(1000);
    const actual = await audioHeading.textContent();
    if (!actual.includes('(2)')) throw new Error(`Stale asset response replaced the latest list: ${actual}`);
    return 'PASS: concurrent import refreshes preserve the latest two assets';
  } catch (error) {
    return `FAIL: ${error.message}`;
  } finally {
    releaseOld();
    await page.unroute('**/api/assets?kind=*');
    await page.unroute('**/api/online-audio/imports/test-batch');
    await page.evaluate(() => sessionStorage.removeItem('douyin-ai-video.online-audio-batch'));
    await page.reload();
  }
}

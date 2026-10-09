import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveYtDlpCookieConfig } from './ytdlp-config.js';

test('桌面端透传 YTDLP_* 环境变量（否则 buildCookieArgs 恒为空，yt-dlp 永远拿不到 cookie）', () => {
  assert.deepEqual(
    resolveYtDlpCookieConfig({ YTDLP_COOKIES_FILE: '/tmp/cookies.txt' }),
    { cookiesFile: '/tmp/cookies.txt', cookiesFromBrowser: undefined }
  );
  assert.deepEqual(
    resolveYtDlpCookieConfig({ YTDLP_COOKIES_FROM_BROWSER: 'chrome' }),
    { cookiesFile: undefined, cookiesFromBrowser: 'chrome' }
  );
});

test('两侧空白被裁掉：路径带空格时不能原样交给 yt-dlp', () => {
  assert.deepEqual(
    resolveYtDlpCookieConfig({ YTDLP_COOKIES_FILE: '  /tmp/cookies.txt  ', YTDLP_COOKIES_FROM_BROWSER: ' chrome ' }),
    { cookiesFile: '/tmp/cookies.txt', cookiesFromBrowser: 'chrome' }
  );
});

test('空串与纯空白等于「没配」，不能下发成 --cookies ""', () => {
  assert.deepEqual(
    resolveYtDlpCookieConfig({ YTDLP_COOKIES_FILE: '', YTDLP_COOKIES_FROM_BROWSER: '   ' }),
    { cookiesFile: undefined, cookiesFromBrowser: undefined }
  );
  assert.deepEqual(resolveYtDlpCookieConfig({}), { cookiesFile: undefined, cookiesFromBrowser: undefined });
});

test('未打包桌面端优先使用项目已准备的 yt-dlp，尊重显式覆盖并保留 PATH 后备', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { resolveYtDlpBinary } = await import('./ytdlp-config.js');
  const rootDir = await mkdtemp(path.join(tmpdir(), 'desktop-ytdlp-'));
  try {
    const local = { rootDir, platform: 'darwin' as const };
    assert.equal(resolveYtDlpBinary('yt-dlp', {}, local), 'yt-dlp');
    const bin = path.join(rootDir, 'vendor/package-assets/bin'); await mkdir(bin, { recursive: true });
    const binary = path.join(bin, 'yt-dlp'); await writeFile(binary, 'prepared binary');
    assert.equal(resolveYtDlpBinary('yt-dlp', {}, local), binary);
    assert.equal(resolveYtDlpBinary('yt-dlp', { YTDLP_BINARY: '  /explicit/yt-dlp  ' }, local), '/explicit/yt-dlp');
    assert.equal(resolveYtDlpBinary('yt-dlp', { YTDLP_BINARY: '  ' }, local), binary);
    assert.equal(resolveYtDlpBinary('/resources/bin/yt-dlp', {}), '/resources/bin/yt-dlp');
    assert.equal(resolveYtDlpBinary('/resources/bin/yt-dlp', { YTDLP_BINARY: '/explicit/tool' }), '/explicit/tool');
    await rm(binary); await mkdir(binary);
    assert.equal(resolveYtDlpBinary('yt-dlp', {}, local), 'yt-dlp');
    await writeFile(path.join(bin, 'yt-dlp.exe'), 'windows prepared binary');
    assert.equal(resolveYtDlpBinary('yt-dlp', {}, { rootDir, platform: 'win32' }), path.join(bin, 'yt-dlp.exe'));
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

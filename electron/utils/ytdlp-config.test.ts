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

type YtDlpCookieConfig = { cookiesFile?: string; cookiesFromBrowser?: string };
const text = (value: unknown) => typeof value === 'string' ? value.trim() || undefined : undefined;

/**
 * 把 `YTDLP_*` 环境变量收敛成媒体服务配置 —— **与独立后端 `src/server.ts` 同一套契约**。
 *
 * 为什么单独成函数：桌面端一度**完全没透传**这两个值，于是 `MediaService.buildCookieArgs()`
 * 恒返回 `[]`，用户配了环境变量也只会看到 yt-dlp 那句「Fresh cookies ... are needed」，
 * 只能靠读代码才发现少了一行。收敛成纯函数后「空串等于没配」这条口径有用例守着
 * （空串若原样下发，会变成 `--cookies ""`，yt-dlp 直接报错）。
 */
export function resolveYtDlpCookieConfig(env: {
  YTDLP_COOKIES_FILE?: string;
  YTDLP_COOKIES_FROM_BROWSER?: string;
}): YtDlpCookieConfig {
  return {
    cookiesFile: text(env.YTDLP_COOKIES_FILE),
    cookiesFromBrowser: text(env.YTDLP_COOKIES_FROM_BROWSER),
  };
}

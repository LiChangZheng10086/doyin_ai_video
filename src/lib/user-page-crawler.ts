import { readFile } from "node:fs/promises";
import { CommandError, runCommand } from "./command.js";

export interface DouyinUserPageInfo {
  secUid: string;
  nickname: string;
  avatarUrl: string;
  description: string;
  followerCount: number;
  followingCount: number;
  awemeCount: number;
}

export interface DouyinVideoItem {
  awemeId: string;
  desc: string;
  coverUrl: string;
  videoUrl: string;
  duration: number;
  createTime: number;
  statistics: {
    diggCount: number;
    commentCount: number;
    shareCount: number;
    playCount: number;
  };
  musicTitle?: string;
  hashtags?: string[];
}

export interface CrawlUserPageResult {
  userInfo: DouyinUserPageInfo;
  items: DouyinVideoItem[];
  totalCollected: number;
  hasMore: boolean;
  nextCursor: number;
}

export interface UserPageCrawlerConfig {
  /** 可选，覆盖 User-Agent */
  userAgent?: string;
  /** cookies 文件路径（兼容 yt-dlp 格式） */
  cookiesFile?: string;
  /** 从浏览器读取 cookies */
  cookiesFromBrowser?: string;
  /** 直接传入Cookie字符串（优先级最高） */
  cookieString?: string;
}

/**
 * 抖音 API 认证所需的关键 Cookie 字段。
 * 参考 dyDownload 和 douyin-download 两个项目。
 */
export const DOUYIN_COOKIE_KEYS = [
  "msToken",
  "ttwid",
  "odin_tt",
  "passport_csrf_token",
  "sid_guard",
  "uid_tt",
  "sid_tt",
  "sessionid",
  "sessionid_ss",
  "s_v_web_id",
  "verifyFp",
];

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/121.0.2277.107 Version/17.0 Mobile/15E148 Safari/604.1";

const MOBILE_USER_AGENT_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";

function buildHeaders(config: UserPageCrawlerConfig, extra: Record<string, string> = {}): Record<string, string> {
  const cookie = resolveCookieHeader(config);
  const headers: Record<string, string> = {
    "User-Agent": config.userAgent ?? DEFAULT_USER_AGENT,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  };
  return headers;
}

/**
 * 从多种来源解析 Cookie 字符串。
 * 优先级：cookieString > cookiesFile > 环境变量 DOUYIN_COOKIE
 */
function resolveCookieHeader(config: UserPageCrawlerConfig): string {
  // 1. 直接传入的 Cookie 字符串
  if (config.cookieString?.trim()) {
    return config.cookieString.trim();
  }

  // 2. 从环境变量读取
  if (process.env.DOUYIN_COOKIE?.trim()) {
    return process.env.DOUYIN_COOKIE.trim();
  }

  return "";
}

/**
 * 从 yt-dlp 格式的 cookies 文件中提取 Netscape 格式的 cookies，
 * 并转换为适用于抖音 API 请求的 Cookie header。
 */
async function loadCookiesFromFile(filePath: string): Promise<string> {
  const content = await readFile(filePath, "utf8");
  const now = Date.now() / 1000;

  const pairs: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // 跳过注释和空行
    if (!trimmed || trimmed.startsWith("#")) continue;

    const fields = trimmed.split("\t");
    // Netscape 格式: domain flag path secure expires name value
    if (fields.length >= 7) {
      const domain = fields[0];
      const expires = Number(fields[4]);
      const name = fields[5];
      const value = fields[6];

      // 只保留抖音相关域名的 cookie
      if (domain.includes("douyin.com") || domain.includes("iesdouyin.com") || domain.includes("snssdk.com") || domain.includes("byteimg.com") || domain.includes("bytedance.com")) {
        // 跳过过期 cookie
        if (expires > 0 && expires < now) continue;
        pairs.push(`${name}=${value}`);
      }
    }
  }

  return pairs.join("; ");
}

/**
 * 构建请求专用的头部，包含从各种来源加载的认证信息。
 * 并发安全的轻量版本——每次调用都同步读取环境变量，不缓存文件。
 */
function buildAuthHeaders(config: UserPageCrawlerConfig): Record<string, string> {
  return buildHeaders(config);
}

/** 从用户主页 URL 中提取 sec_uid */
export function extractSecUidFromUrl(url: string): string | null {
  // 匹配模式：/user/{sec_uid} 或 /user/{sec_uid}?...
  const match = url.match(/\/user\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

/** 从用户主页 HTML 中提取 SSR 数据和 sec_uid */
function extractSecUidFromHtml(html: string, fallbackUrl: string): string | null {
  // 先尝试从 URL 提取
  const fromUrl = extractSecUidFromUrl(fallbackUrl);
  if (fromUrl) return fromUrl;

  // 尝试从 ROUTER_DATA 或其他内嵌 JSON 中提取
  const routerMatch = html.match(/window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s);
  if (routerMatch) {
    try {
      const raw = routerMatch[1].trim().replace(/;$/, "");
      const data = JSON.parse(raw) as Record<string, any>;
      const loaderData = (data.loaderData ?? {}) as Record<string, any>;
      // 遍历 loaderData 查找包含 sec_uid 的 key
      for (const value of Object.values(loaderData)) {
        const typed = value as Record<string, any> | undefined;
        if (typed?.userPageResp?.sec_uid) return String(typed.userPageResp.sec_uid);
        if (typed?.userInfoResp?.sec_uid) return String(typed.userInfoResp.sec_uid);
        if (typed?.sec_uid) return String(typed.sec_uid);
      }
    } catch {
      // ROUTER_DATA 解析失败，继续尝试其他方式
    }
  }

  // 尝试从页面 JS 变量中提取
  const secUidMatch = html.match(/"sec_uid"\s*:\s*"([^"]+)"/);
  if (secUidMatch) return secUidMatch[1];

  // 尝试从 SSR 初始 state 提取
  const stateMatch = html.match(
    /"user"\s*:\s*\{[^}]*"sec_uid"\s*:\s*"([^"]+)"/
  );
  if (stateMatch) return stateMatch[1];

  return null;
}

/** 从 HTML 中提取昵称等用户信息 */
function extractUserInfoFromHtml(
  html: string
): Partial<DouyinUserPageInfo> {
  const info: Partial<DouyinUserPageInfo> = {};

  const routerMatch = html.match(/window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s);
  if (routerMatch) {
    try {
      const raw = routerMatch[1].trim().replace(/;$/, "");
      const data = JSON.parse(raw) as Record<string, any>;
      const loaderData = (data.loaderData ?? {}) as Record<string, any>;
      for (const value of Object.values(loaderData)) {
        const typed = value as Record<string, any> | undefined;
        const user = typed?.userPageResp ?? typed?.userInfoResp;
        if (user) {
          info.nickname = info.nickname ?? user.nickname ?? user.unique_id;
          info.avatarUrl = info.avatarUrl ?? user.avatar_medium?.url_list?.[0] ?? user.avatar_thumb?.url_list?.[0];
          info.description = info.description ?? user.signature ?? user.bio;
          info.followerCount = info.followerCount ?? user.follower_count;
          info.followingCount = info.followingCount ?? user.following_count;
          info.awemeCount = info.awemeCount ?? user.aweme_count ?? user.total_favorited;
        }
      }
    } catch {
      // 忽略
    }
  }

  // 从 meta 标签 fallback
  info.nickname = info.nickname ?? extractMetaContent(html, "og:title");

  return info;
}

function extractMetaContent(html: string, key: string): string | undefined {
  const pattern = new RegExp(
    `<meta[^>]*(?:property|name)=["']${escapeRegExp(key)}["'][^>]*content=["']([^"']*)["'][^>]*>`,
    "i"
  );
  const match = html.match(pattern);
  return match?.[1] ? decodeHtmlEntities(match[1]) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * 解析 aweme/post API 返回的 JSON，提取视频列表
 */
function parseAwemeItems(data: Record<string, any>): {
  items: DouyinVideoItem[];
  hasMore: boolean;
  nextCursor: number;
  userInfo?: Partial<DouyinUserPageInfo>;
} {
  const awemeList: any[] = data?.aweme_list ?? data?.data ?? [];
  const hasMore = data?.has_more === 1 || data?.has_more === true;
  const nextCursor = data?.max_cursor ?? data?.cursor ?? 0;

  const items: DouyinVideoItem[] = awemeList.map((aweme: any) => {
    const video = aweme.video ?? {};
    const playAddr = video.play_addr ?? video.playAddr ?? {};
    const coverInfo = video.cover ?? video.origin_cover ?? {};
    const stats = aweme.statistics ?? {};

    // 优先使用无水印地址
    const videoUrl =
      playAddr.url_list?.find?.((u: string) => !u.includes("watermark")) ??
      playAddr.url_list?.[0] ??
      video.download_addr?.url_list?.[0] ??
      "";

    const coverUrl =
      coverInfo.url_list?.[0] ??
      aweme.video?.cover?.url_list?.[0] ??
      "";

    const hashtags: string[] = [];
    if (aweme.text_extra) {
      for (const extra of aweme.text_extra) {
        if (extra.hashtag_name) hashtags.push(extra.hashtag_name);
      }
    }

    return {
      awemeId: String(aweme.aweme_id ?? aweme.aid ?? ""),
      desc: String(aweme.desc ?? ""),
      coverUrl: String(coverUrl),
      videoUrl: String(videoUrl),
      duration: Number(video.duration ?? 0) / 1000,
      createTime: Number(aweme.create_time ?? 0),
      statistics: {
        diggCount: Number(stats.digg_count ?? stats.like_count ?? 0),
        commentCount: Number(stats.comment_count ?? 0),
        shareCount: Number(stats.share_count ?? 0),
        playCount: Number(stats.play_count ?? 0),
      },
      musicTitle: aweme.music?.title ?? aweme.music?.author,
      hashtags,
    };
  });

  // 从第一个视频的作者信息提取
  let userInfo: Partial<DouyinUserPageInfo> | undefined;
  const author = awemeList[0]?.author;
  if (author) {
    userInfo = {
      nickname: author.nickname ?? author.unique_id,
      avatarUrl: author.avatar_medium?.url_list?.[0] ?? author.avatar_thumb?.url_list?.[0],
      description: author.signature,
      followerCount: author.follower_count,
      followingCount: author.following_count,
      awemeCount: author.aweme_count ?? author.total_favorited,
    };
  }

  return { items, hasMore, nextCursor, userInfo };
}

/**
 * 通过直接 API 调用爬取用户作品列表。
 * 优先使用 www.douyin.com 接口（Cookie 认证），失败则尝试 iesdouyin.com。
 * 参考: dyDownload (Everless321) 和 douyin-download (datnndd)
 */
async function crawlViaApi(
  secUid: string,
  maxItems: number,
  config: UserPageCrawlerConfig
): Promise<CrawlUserPageResult> {
  const allItems: DouyinVideoItem[] = [];
  let cursor = 0;
  let hasMore = true;
  let userInfo: DouyinUserPageInfo | null = null;
  const perPage = Math.min(maxItems, 35);

  // 两个备选 API 端点
  const apiEndpoints = [
    {
      name: "douyin-web",
      baseUrl: "https://www.douyin.com/aweme/v1/web/aweme/post/",
      referer: `https://www.douyin.com/user/${secUid}`,
      params: (csr: number) => ({
        sec_user_id: secUid,
        count: String(perPage),
        max_cursor: String(csr),
        aid: "6383",
        cookie_enabled: "true",
        platform: "pc",
        downlink: "10",
      }),
      responseListKey: (json: any) => json?.aweme_list ?? json?.data,
      hasMoreKey: (json: any) => json?.has_more === 1,
      nextCursorKey: (json: any) => json?.max_cursor ?? 0,
      statusOk: (json: any) => json?.status_code === 0 || json?.status_code === undefined,
    },
    {
      name: "iesdouyin",
      baseUrl: "https://www.iesdouyin.com/web/api/v2/aweme/post/",
      referer: `https://www.iesdouyin.com/share/user/${secUid}`,
      params: (csr: number) => ({
        sec_user_id: secUid,
        count: String(perPage),
        max_cursor: String(csr),
        aid: "6383",
        cookie_enabled: "true",
        platform: "pc",
        downlink: "10",
      }),
      responseListKey: (json: any) => json?.aweme_list ?? json?.data,
      hasMoreKey: (json: any) => json?.has_more === 1 || json?.has_more === true,
      nextCursorKey: (json: any) => json?.max_cursor ?? json?.cursor ?? 0,
      statusOk: (json: any) => json?.status_code === 0 || json?.status_code === undefined,
    },
  ];

  for (const endpoint of apiEndpoints) {
    // 重置
    cursor = 0;
    hasMore = true;
    allItems.length = 0;

    try {
      while (hasMore && allItems.length < maxItems) {
        const params = endpoint.params(cursor);
        const queryString = new URLSearchParams(
          Object.entries(params).map(([k, v]) => [k, String(v)])
        ).toString();
        const apiUrl = `${endpoint.baseUrl}?${queryString}`;
        const headers = buildAuthHeaders(config);
        headers["Referer"] = endpoint.referer;
        headers["Accept"] = "application/json, text/plain, */*";

        const response = await fetch(apiUrl, {
          method: "GET",
          headers,
          redirect: "follow",
        });

        if (!response.ok) {
          if (allItems.length > 0) break;
          throw new Error(`${endpoint.name}: HTTP ${response.status}`);
        }

        const json = (await response.json()) as Record<string, any>;

        if (!endpoint.statusOk(json)) {
          throw new Error(
            `${endpoint.name}: API status ${json.status_code ?? "unknown"}: ${json.status_msg ?? ""}`
          );
        }

        const parsed = parseAwemeItems(json);

        if (!userInfo && parsed.userInfo) {
          userInfo = {
            secUid,
            nickname: parsed.userInfo.nickname ?? "未知用户",
            avatarUrl: parsed.userInfo.avatarUrl ?? "",
            description: parsed.userInfo.description ?? "",
            followerCount: parsed.userInfo.followerCount ?? 0,
            followingCount: parsed.userInfo.followingCount ?? 0,
            awemeCount: parsed.userInfo.awemeCount ?? 0,
          };
        }

        cursor = endpoint.nextCursorKey(json);
        hasMore = endpoint.hasMoreKey(json) && parsed.items.length > 0;
        allItems.push(...parsed.items);

        if (!parsed.hasMore || parsed.items.length === 0) break;
      }

      // 成功获取到数据，退出循环
      if (allItems.length > 0 || !hasMore) break;
    } catch (err) {
      console.warn(`API 端点 ${endpoint.name} 失败:`, err);
      // 继续尝试下一个端点
    }
  }

  if (allItems.length === 0) {
    throw new Error("所有 API 端点均失败，无法获取视频列表。请尝试:\n1. 设置环境变量 DOUYIN_COOKIE=你的Cookie\n2. 使用 cookiesFile 参数指定 Cookie 文件\n3. 查看 README 了解如何获取抖音 Cookie");
  }

  if (!userInfo) {
    userInfo = {
      secUid,
      nickname: "未知用户",
      avatarUrl: "",
      description: "",
      followerCount: 0,
      followingCount: 0,
      awemeCount: 0,
    };
  }

  return {
    userInfo,
    items: allItems.slice(0, maxItems),
    totalCollected: Math.min(allItems.length, maxItems),
    hasMore: hasMore && allItems.length < maxItems,
    nextCursor: cursor,
  };
}

/**
 * 通过 Playwright 浏览器自动化爬取用户作品列表。
 * 启动无头浏览器，拦截 aweme/post API 响应来获取数据。
 */
async function crawlViaBrowser(
  secUid: string,
  maxItems: number,
  config: UserPageCrawlerConfig
): Promise<CrawlUserPageResult> {
  // 检查 npx playwright 是否可用
  const playwrightScript = `
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "${config.userAgent ?? DEFAULT_USER_AGENT}",
    viewport: { width: 390, height: 844 },
  });

  const page = await context.newPage();
  const items = [];
  let userInfo = null;
  let hasMore = true;
  let cursor = 0;

  // 拦截 API 响应
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('aweme/v1/web/aweme/post') || url.includes('aweme/post')) {
      try {
        const json = await response.json();
        if (json && json.aweme_list) {
          items.push(...json.aweme_list);
          cursor = json.max_cursor || 0;
          hasMore = json.has_more === 1;
        }
        if (!userInfo && json?.aweme_list?.[0]?.author) {
          const author = json.aweme_list[0].author;
          userInfo = {
            secUid: author.sec_uid || "${secUid}",
            nickname: author.nickname || '',
            avatarUrl: (author.avatar_medium?.url_list?.[0] || author.avatar_thumb?.url_list?.[0] || ''),
            description: author.signature || '',
            followerCount: author.follower_count || 0,
            followingCount: author.following_count || 0,
            awemeCount: author.aweme_count || 0,
          };
        }
      } catch {}
    }
  });

  const targetMax = ${maxItems};
  await page.goto('https://www.douyin.com/user/${secUid}', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  // 等待初始数据加载
  await page.waitForTimeout(3000);

  // 滚动加载更多
  while (hasMore && items.length < targetMax) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(2000);

    // 如果连续滚动都没有新数据，尝试点击 "加载更多"
    const loadMore = page.locator('text=加载更多, text=查看更多');
    if (await loadMore.count() > 0) {
      await loadMore.first().click();
      await page.waitForTimeout(2000);
    }
  }

  if (!userInfo) {
    userInfo = {
      secUid: "${secUid}",
      nickname: "未知用户",
      avatarUrl: "",
      description: "",
      followerCount: 0,
      followingCount: 0,
      awemeCount: 0,
    };
  }

  console.log(JSON.stringify({ items, userInfo, hasMore, cursor }));
  await browser.close();
})();
`;

  try {
    const { stdout } = await runCommand("npx", ["playwright", "run", "-c", "/dev/null", "--"], {
      captureStdout: true,
      captureStderr: true,
      timeoutMs: 120000,
      env: {
        ...process.env,
        PLAYWRIGHT_SCRIPT: playwrightScript,
      },
    }).catch(async () => {
      // npx playwright run 可能不支持这种用法，尝试 node -e
      return await runCommand("node", ["-e", playwrightScript], {
        captureStdout: true,
        captureStderr: true,
        timeoutMs: 120000,
      });
    });

    const raw = stdout.trim();
    // 找到最后一个 JSON 对象
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("浏览器模式未能获取有效数据");
    }

    const result = JSON.parse(jsonMatch[0]) as {
      items: any[];
      userInfo: DouyinUserPageInfo;
      hasMore: boolean;
      cursor: number;
    };

    const parsed = parseAwemeItems({ aweme_list: result.items, max_cursor: result.cursor, has_more: result.hasMore ? 1 : 0 });

    return {
      userInfo: result.userInfo ?? {
        secUid,
        nickname: parsed.userInfo?.nickname ?? "未知用户",
        avatarUrl: parsed.userInfo?.avatarUrl ?? "",
        description: parsed.userInfo?.description ?? "",
        followerCount: parsed.userInfo?.followerCount ?? 0,
        followingCount: parsed.userInfo?.followingCount ?? 0,
        awemeCount: parsed.userInfo?.awemeCount ?? 0,
      },
      items: parsed.items.slice(0, maxItems),
      totalCollected: Math.min(parsed.items.length, maxItems),
      hasMore: parsed.hasMore && parsed.items.length < maxItems,
      nextCursor: parsed.nextCursor,
    };
  } catch (error) {
    if (error instanceof CommandError) {
      throw new Error(
        `浏览器自动化爬取失败: ${error.stderr || error.message}\n请确认已安装 Playwright: npx playwright install chromium`
      );
    }
    throw error;
  }
}

/**
 * 爬取抖音用户主页视频列表。
 *
 * @param pageUrl - 用户主页链接，如 https://www.douyin.com/user/MS4wLjABAAAA...
 * @param maxItems - 最多获取的作品数
 * @param config - 配置选项
 * @returns 爬取结果
 */
export async function crawlUserPage(
  pageUrl: string,
  maxItems: number = 100,
  config: UserPageCrawlerConfig = {}
): Promise<CrawlUserPageResult> {
  // Step 1: 获取页面 HTML，提取 sec_uid 和可能的内嵌数据
  let secUid: string | null = null;
  let htmlUserInfo: Partial<DouyinUserPageInfo> = {};

  const pageHeaders = buildAuthHeaders(config);
  pageHeaders["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

  const pageResponse = await fetch(pageUrl, {
    method: "GET",
    redirect: "follow",
    headers: pageHeaders,
  });

  if (pageResponse.ok) {
    const html = await pageResponse.text();
    const finalUrl = pageResponse.url;
    secUid = extractSecUidFromHtml(html, finalUrl);
    htmlUserInfo = extractUserInfoFromHtml(html);
  }

  if (!secUid) {
    secUid = extractSecUidFromUrl(pageUrl);
  }

  if (!secUid) {
    throw new Error(
      `无法从页面链接中提取用户 ID: ${pageUrl}\n请确认链接格式为 https://www.douyin.com/user/{用户ID}`
    );
  }

  // Step 2: 尝试 API 直接调用
  try {
    const apiResult = await crawlViaApi(secUid, maxItems, config);

    // 合并页面中提取的用户信息（通常更完整）
    return {
      ...apiResult,
      userInfo: {
        secUid,
        nickname: htmlUserInfo.nickname ?? apiResult.userInfo.nickname ?? "未知用户",
        avatarUrl: htmlUserInfo.avatarUrl ?? apiResult.userInfo.avatarUrl ?? "",
        description: htmlUserInfo.description ?? apiResult.userInfo.description ?? "",
        followerCount: htmlUserInfo.followerCount ?? apiResult.userInfo.followerCount ?? 0,
        followingCount: htmlUserInfo.followingCount ?? apiResult.userInfo.followingCount ?? 0,
        awemeCount: htmlUserInfo.awemeCount ?? apiResult.userInfo.awemeCount ?? apiResult.items.length,
      },
    };
  } catch (apiError) {
    console.warn("API 直调爬取失败，正在降级到浏览器模式:", apiError);
  }

  // Step 3: 降级到浏览器自动化
  return crawlViaBrowser(secUid, maxItems, config);
}

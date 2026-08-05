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
  /** Optional User-Agent override */
  userAgent?: string;
  /** Path to cookies file (yt-dlp compatible format) */
  cookiesFile?: string;
  /** Read cookies from browser */
  cookiesFromBrowser?: string;
  /** Cookie string directly passed in (highest priority) */
  cookieString?: string;
}

/**
 * Key cookie fields required for Douyin API auth.
 * Based on dyDownload and douyin-download projects.
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
 * Resolve cookie string from multiple sources.
 * Priority: cookieString > environment variable DOUYIN_COOKIE
 */
function resolveCookieHeader(config: UserPageCrawlerConfig): string {
  if (config.cookieString?.trim()) {
    return config.cookieString.trim();
  }
  if (process.env.DOUYIN_COOKIE?.trim()) {
    return process.env.DOUYIN_COOKIE.trim();
  }
  return "";
}

/**
 * Load cookies from yt-dlp format (Netscape) cookies file
 * and convert to Cookie header string for Douyin API requests.
 */
async function loadCookiesFromFile(filePath: string): Promise<string> {
  const content = await readFile(filePath, "utf8");
  const now = Date.now() / 1000;

  const pairs: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const fields = trimmed.split("\t");
    // Netscape format: domain flag path secure expires name value
    if (fields.length >= 7) {
      const domain = fields[0];
      const expires = Number(fields[4]);
      const name = fields[5];
      const value = fields[6];

      // Only keep cookies for Douyin-related domains
      if (domain.includes("douyin.com") || domain.includes("iesdouyin.com") || domain.includes("snssdk.com") || domain.includes("byteimg.com") || domain.includes("bytedance.com")) {
        if (expires > 0 && expires < now) continue;
        pairs.push(`${name}=${value}`);
      }
    }
  }

  return pairs.join("; ");
}

/**
 * Build auth headers, including cookies from various sources.
 * Concurrency-safe lightweight version - reads env vars synchronously each call without caching files.
 */
function buildAuthHeaders(config: UserPageCrawlerConfig): Record<string, string> {
  return buildHeaders(config);
}

/** Extract sec_uid from a user page URL */
export function extractSecUidFromUrl(url: string): string | null {
  const match = url.match(/\/user\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

/** Extract sec_uid and user info from user page HTML */
function extractSecUidFromHtml(html: string, fallbackUrl: string): string | null {
  const fromUrl = extractSecUidFromUrl(fallbackUrl);
  if (fromUrl) return fromUrl;

  // Try to extract from ROUTER_DATA or other embedded JSON
  const routerMatch = html.match(/window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s);
  if (routerMatch) {
    try {
      const raw = routerMatch[1].trim().replace(/;$/, "");
      const data = JSON.parse(raw) as Record<string, any>;
      const loaderData = (data.loaderData ?? {}) as Record<string, any>;
      for (const value of Object.values(loaderData)) {
        const typed = value as Record<string, any> | undefined;
        if (typed?.userPageResp?.sec_uid) return String(typed.userPageResp.sec_uid);
        if (typed?.userInfoResp?.sec_uid) return String(typed.userInfoResp.sec_uid);
        if (typed?.sec_uid) return String(typed.sec_uid);
      }
    } catch {
      // ROUTER_DATA parse failed, continue trying
    }
  }

  // Try JS variables in the page
  const secUidMatch = html.match(/"sec_uid"\s*:\s*"([^"]+)"/);
  if (secUidMatch) return secUidMatch[1];

  // Try SSR initial state
  const stateMatch = html.match(
    /"user"\s*:\s*\{[^}]*"sec_uid"\s*:\s*"([^"]+)"/
  );
  if (stateMatch) return stateMatch[1];

  return null;
}

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
      // ignore
    }
  }

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
 * Parse aweme/post API response JSON, extract video items.
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

    // Prefer non-watermarked address
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
 * Crawl user page via direct API calls with a_bogus + X-Bogus signatures.
 * Automatically loads persisted cookie; if none exists, extracts via browser.
 */
async function crawlViaApi(
  secUid: string,
  maxItems: number,
  config: UserPageCrawlerConfig
): Promise<CrawlUserPageResult> {
  // Dynamic import to avoid top-level side effects
  const { signUserPostRequest } = await import("./douyin-signatures.js");
  const { loadCookie, extractCookiesViaBrowser } = await import("./douyin-cookie.js");

  let cookie = resolveCookieHeader(config);
  if (!cookie) {
    cookie = loadCookie();
  }

  // No cookie at all? Extract one via headless browser
  if (!cookie) {
    try {
      console.log("[crawl] No cookie found, extracting via headless browser...");
      cookie = await extractCookiesViaBrowser();
      console.log("[crawl] Cookie extracted, length:", cookie.length);
    } catch (err) {
      console.warn("[crawl] Auto cookie extraction failed:", err);
    }
  }

  const userAgent = config.userAgent ??
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

  const allItems: DouyinVideoItem[] = [];
  let cursor = 0;
  let hasMore = true;
  let userInfo: DouyinUserPageInfo | null = null;
  const perPage = Math.min(maxItems, 35);

  while (hasMore && allItems.length < maxItems) {
    const signed = signUserPostRequest(secUid, cursor, perPage, userAgent);

    const headers: Record<string, string> = {
      "User-Agent": signed.userAgent,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Referer": `https://www.douyin.com/user/${secUid}`,
      "Origin": "https://www.douyin.com",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    };
    if (cookie) {
      headers["Cookie"] = cookie;
    }

    const response = await fetch(signed.url, {
      method: "GET",
      headers,
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`API returned HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text.trim()) {
      // Empty response: cookie expired or missing
      throw new Error(
        "API returned empty response. Cookie may have expired.\n" +
        "Try deleting ~/.douyin-ai-video/douyin-cookie.txt to re-extract."
      );
    }

    const json = JSON.parse(text) as Record<string, any>;

    if (json.status_code !== 0) {
      throw new Error(
        `API error: status_code=${json.status_code}, msg=${json.status_msg ?? "unknown"}`
      );
    }

    const parsed = parseAwemeItems(json);

    if (!userInfo && parsed.userInfo) {
      userInfo = {
        secUid,
        nickname: parsed.userInfo.nickname ?? "Unknown User",
        avatarUrl: parsed.userInfo.avatarUrl ?? "",
        description: parsed.userInfo.description ?? "",
        followerCount: parsed.userInfo.followerCount ?? 0,
        followingCount: parsed.userInfo.followingCount ?? 0,
        awemeCount: parsed.userInfo.awemeCount ?? 0,
      };
    }

    cursor = json?.max_cursor ?? 0;
    hasMore = (json?.has_more === 1) && parsed.items.length > 0;
    allItems.push(...parsed.items);

    if (!parsed.hasMore || parsed.items.length === 0) break;
    if (cursor === 0) break;
  }

  if (allItems.length === 0) {
    throw new Error(
      "No videos collected from user page. Possible causes:\n" +
      "1. Cookie expired: delete ~/.douyin-ai-video/douyin-cookie.txt and retry\n" +
      "2. Need to login: open https://www.douyin.com/ in browser and sign in first\n" +
      "3. Set DOUYIN_COOKIE=... env var with a valid cookie string"
    );
  }

  if (!userInfo) {
    userInfo = {
      secUid,
      nickname: "Unknown User",
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
 * Crawl user page via Playwright browser automation.
 * Launches headless browser, intercepts aweme/post API responses to get data.
 *
 * Writes an ESM script to a temp .mjs file and executes it as a child process,
 * avoiding the issue where require('playwright') fails in an ESM project.
 */
async function crawlViaBrowser(
  secUid: string,
  maxItems: number,
  config: UserPageCrawlerConfig
): Promise<CrawlUserPageResult> {
  const os = await import("node:os");
  const pathModule = await import("node:path");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");

  const tmpDir = await mkdtemp(pathModule.join(os.tmpdir(), "douyin-crawl-"));
  const scriptPath = pathModule.join(tmpDir, "crawl.mjs");

  // Resolve playwright to an absolute path so the child process can import it
  const playwrightPath = pathModule.join(process.cwd(), "node_modules", "playwright", "index.js");

  const scriptContent = `import pkg from ${JSON.stringify(playwrightPath)};
const { chromium } = pkg;

const secUid = ${JSON.stringify(secUid)};
const maxItems = ${maxItems};
const userAgent = ${JSON.stringify(config.userAgent ?? DEFAULT_USER_AGENT)};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent,
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

const items = [];
let userInfo = null;
let hasMore = true;
let cursor = 0;

page.on("response", async (response) => {
  const url = response.url();
  if ((url.includes("aweme/v1/web/aweme/post") || url.includes("aweme/post")) && response.status() === 200) {
    try {
      const json = await response.json();
      if (json && json.aweme_list && json.aweme_list.length > 0) {
        items.push(...json.aweme_list);
        cursor = json.max_cursor || 0;
        hasMore = json.has_more === 1;
      }
      if (!userInfo && json?.aweme_list?.[0]?.author) {
        const author = json.aweme_list[0].author;
        userInfo = {
          secUid: author.sec_uid || secUid,
          nickname: author.nickname || "",
          avatarUrl: (author.avatar_medium?.url_list?.[0] || author.avatar_thumb?.url_list?.[0] || ""),
          description: author.signature || "",
          followerCount: author.follower_count || 0,
          followingCount: author.following_count || 0,
          awemeCount: author.aweme_count || 0,
        };
      }
    } catch {}
  }
});

await page.goto("https://www.douyin.com/user/" + secUid, {
  waitUntil: "domcontentloaded",
  timeout: 30000,
});
await page.waitForTimeout(4000);

// Scroll to load more
let noNewRounds = 0;
while (hasMore && items.length < maxItems && noNewRounds < 3) {
  const before = items.length;
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2500);
  if (items.length === before) {
    noNewRounds++;
  } else {
    noNewRounds = 0;
  }
}

if (!userInfo) {
  userInfo = {
    secUid: secUid,
    nickname: "Unknown User",
    avatarUrl: "",
    description: "",
    followerCount: 0,
    followingCount: 0,
    awemeCount: 0,
  };
}

process.stdout.write(JSON.stringify({ items, userInfo, hasMore, cursor }));
await browser.close();
`;

  try {
    await writeFile(scriptPath, scriptContent, "utf8");

    const nodeModulesPath = pathModule.join(process.cwd(), "node_modules");
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: nodeModulesPath };
    delete env.NODE_OPTIONS; // avoid --import etc flags interfering with child process

    const { stdout, stderr } = await runCommand("node", ["--no-warnings", scriptPath], {
      captureStdout: true,
      captureStderr: true,
      timeoutMs: 120000,
      env,
    });

    const raw = stdout.trim();
    if (stderr) {
      console.warn("Playwright stderr:", stderr.slice(0, 500));
    }

    // Find JSON object
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(
        `Browser mode did not return valid data. stdout: ${raw.slice(0, 200)}, stderr: ${stderr.slice(0, 200)}`
      );
    }

    const result = JSON.parse(jsonMatch[0]) as {
      items: any[];
      userInfo: DouyinUserPageInfo;
      hasMore: boolean;
      cursor: number;
    };

    const parsed = parseAwemeItems({
      aweme_list: result.items,
      max_cursor: result.cursor,
      has_more: result.hasMore ? 1 : 0,
    });

    return {
      userInfo: result.userInfo ?? {
        secUid,
        nickname: parsed.userInfo?.nickname ?? "Unknown User",
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
        `Browser automation crawl failed: ${error.stderr || error.message}\n` +
        `Please ensure Playwright is installed: npm install playwright && npx playwright install chromium`
      );
    }
    throw error;
  } finally {
    // Clean up temp directory
    rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Crawl Douyin user page to get video list.
 *
 * Priority:
 *   1. Direct API with signatures (a_bogus + X-Bogus) + cookie
 *   2. Playwright browser automation (fallback if signature API fails)
 *
 * First call will auto-extract cookie via headless browser if none exists;
 * subsequent calls reuse the persisted cookie for lightning-fast API access.
 *
 * @param pageUrl - User page URL, e.g. https://www.douyin.com/user/MS4wLjABAAAA...
 * @param maxItems - Maximum number of items to fetch
 * @param config - Configuration options
 * @returns Crawl result
 */
export async function crawlUserPage(
  pageUrl: string,
  maxItems: number = 100,
  config: UserPageCrawlerConfig = {}
): Promise<CrawlUserPageResult> {
  // Step 1: Fetch page HTML, extract sec_uid and embedded data
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
      `Cannot extract user ID from page URL: ${pageUrl}\n` +
      `Please ensure the URL format is https://www.douyin.com/user/{userID}`
    );
  }

  // Step 2: Try direct API with signatures (fast, no browser needed)
  try {
    const apiResult = await crawlViaApi(secUid, maxItems, config);

    // Merge user info from page HTML (often more complete)
    return {
      ...apiResult,
      userInfo: {
        secUid,
        nickname: htmlUserInfo.nickname ?? apiResult.userInfo.nickname ?? "Unknown User",
        avatarUrl: htmlUserInfo.avatarUrl ?? apiResult.userInfo.avatarUrl ?? "",
        description: htmlUserInfo.description ?? apiResult.userInfo.description ?? "",
        followerCount: htmlUserInfo.followerCount ?? apiResult.userInfo.followerCount ?? 0,
        followingCount: htmlUserInfo.followingCount ?? apiResult.userInfo.followingCount ?? 0,
        awemeCount: htmlUserInfo.awemeCount ?? apiResult.userInfo.awemeCount ?? apiResult.items.length,
      },
    };
  } catch (apiError) {
    console.warn("Direct API crawl failed, falling back to browser mode:", apiError);
  }

  // Step 3: Fall back to browser automation
  return crawlViaBrowser(secUid, maxItems, config);
}

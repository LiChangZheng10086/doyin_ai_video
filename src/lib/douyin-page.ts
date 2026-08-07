export interface DouyinRedirectHop {
  url: string;
  status: number;
  location?: string | null;
}

export interface DouyinPageInfo {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl?: string;
  videoId?: string;
  pageTitle?: string;
  pageDescription?: string;
  coverUrl?: string;
  authorName?: string;
  publishTime?: string;
  isChallengePage: boolean;
  redirectChain: DouyinRedirectHop[];
}

const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "cache-control": "no-cache",
  pragma: "no-cache"
};

export async function fetchDouyinPageInfo(requestedUrl: string): Promise<DouyinPageInfo> {
  const resolved = await followRedirects(requestedUrl);
  const html = resolved.html ?? "";
  const metadata = extractMetadata(html);
  const finalUrl = resolved.finalUrl;

  return {
    requestedUrl,
    finalUrl,
    canonicalUrl: metadata.canonicalUrl ?? finalUrl,
    videoId: extractVideoId(finalUrl) ?? extractVideoId(metadata.canonicalUrl ?? ""),
    pageTitle: metadata.title,
    pageDescription: metadata.description,
    coverUrl: metadata.coverUrl,
    authorName: metadata.authorName,
    publishTime: metadata.publishTime,
    isChallengePage: looksLikeChallengePage(html),
    redirectChain: resolved.redirectChain
  };
}

async function followRedirects(url: string, maxHops = 5) {
  let current = url;
  const redirectChain: DouyinRedirectHop[] = [];
  let html = "";

  for (let i = 0; i <= maxHops; i += 1) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: DEFAULT_HEADERS
    });

    const location = response.headers.get("location");
    redirectChain.push({
      url: current,
      status: response.status,
      location
    });

    if (isRedirectStatus(response.status) && location) {
      current = new URL(location, current).href;
      continue;
    }

    html = await response.text();
    break;
  }

  return {
    finalUrl: current,
    html,
    redirectChain
  };
}

function isRedirectStatus(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function extractMetadata(html: string) {
  return {
    canonicalUrl: getLinkHref(html, "canonical"),
    title:
      getMetaContent(html, "og:title") ??
      getMetaContent(html, "twitter:title") ??
      extractTitleTag(html),
    description:
      getMetaContent(html, "og:description") ??
      getMetaContent(html, "description") ??
      getMetaContent(html, "twitter:description"),
    coverUrl:
      getMetaContent(html, "og:image") ??
      getMetaContent(html, "twitter:image") ??
      getMetaContent(html, "twitter:image:src"),
    authorName:
      getMetaContent(html, "author") ?? getMetaContent(html, "og:video:director"),
    publishTime:
      getMetaContent(html, "article:published_time") ??
      getMetaContent(html, "og:video:release_date")
  };
}

function getMetaContent(html: string, key: string) {
  const pattern = new RegExp(
    `<meta[^>]*(?:property|name)=["']${escapeRegExp(key)}["'][^>]*content=["']([^"']*)["'][^>]*>`,
    "i"
  );
  const match = html.match(pattern);
  return match?.[1] ? decodeHtmlEntities(match[1]) : undefined;
}

function getLinkHref(html: string, rel: string) {
  const pattern = new RegExp(
    `<link[^>]*rel=["']${escapeRegExp(rel)}["'][^>]*href=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const match = html.match(pattern);
  return match?.[1] ? decodeHtmlEntities(match[1]) : undefined;
}

function extractTitleTag(html: string) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match?.[1] ? decodeHtmlEntities(match[1].trim()) : undefined;
}

function extractVideoId(url: string) {
  const match = url.match(/\/video\/(\d+)/);
  return match?.[1];
}

function looksLikeChallengePage(html: string) {
  return html.includes("window.byted_acrawler.init") || html.includes("__ac_signature");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

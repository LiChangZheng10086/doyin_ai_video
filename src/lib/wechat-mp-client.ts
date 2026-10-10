/**
 * 微信公众号官方 API 客户端（`api.weixin.qq.com`）。
 *
 * 与项目里 `sau-runner.ts` / `yt-dlp` / `whisper-cli` 同模式：把外部系统包成一层薄封装，
 * 由调用方注入配置，测试注入假 `fetchImpl` —— **绝不联网、绝不触碰真实公众号**。
 *
 * ## 为什么是官方 API 而不是浏览器自动化
 *
 * 参考项目 `liyown/ai-trend-publish`（MIT）的公众号输出侧只有约 520 行，且全仓无
 * playwright/puppeteer；它只用 4 个官方端点（本模块覆盖其中 3 个 + 自检用的 1 个）。
 * 官方 API 不会有「上游 DOM 改版就失效」的问题。详见 spec §1.1。
 *
 * ## 覆盖的端点
 *
 * | 方法 | 端点 | 返回 | 用途 |
 * | --- | --- | --- | --- |
 * | `getDraftCount` | `GET /cgi-bin/draft/count` | `total_count` | 账号自检（**零副作用**，最便宜的权限判据） |
 * | `uploadCoverImage` | `POST /cgi-bin/material/add_material?type=image` | `media_id`（**永久素材**） | 封面 → 作为 `draft/add` 的 `thumb_media_id` |
 * | `uploadContentImage` | `POST /cgi-bin/media/uploadimg` | `url`（微信托管） | 正文配图 → **必须**换成这个 URL 写进 content |
 * | `createDraft` | `POST /cgi-bin/draft/add` | `media_id`（草稿） | 建草稿。**到此为止，绝不调用 `freepublish/*`**（spec §2） |
 *
 * ⚠️ 两个上传端点的**格式白名单不同**（正文图仅 jpg/png；封面另收 bmp/gif），
 * 且微信按**文件名扩展名**判格式 —— 扩展名与内容不符会报 `40113`，所以两者都按文件名校验。
 * ⚠️ 本轮只做**图文消息（`article_type: "news"`）**：`newspic`（图片消息）是刻意的将来选项（spec §11），
 * 不要顺手加 `image_info`。
 *
 * ## 四条从官方文档实测来的契约（2026-09-18 逐条核对，非推断）
 *
 * 1. **稳定版凭据**：`POST /cgi-bin/stable_token`，JSON body `{grant_type, appid, secret, force_refresh?}`。
 *    普通模式下**有效期内重复调用不会更新 token**，且平台会**提前 5 分钟**更新，因此返回的
 *    `expires_in` **可能远小于 7200**（官方示例里出现过 345） —— 缓存**必须用返回的 `expires_in`**，
 *    硬编码 7200 会让我们持有一个即将失效的凭据。它与 `/cgi-bin/token` 的凭据**互相隔离**。
 * 2. **白名单错误码官方两处不一致**：接口错误码表写 `40164`，开发指南写 `61004` —— **两个都认**，
 *    否则用户的明确错误会被报成未知错误。
 * 3. **风险调用确认是三个码**：`89503`（待管理员确认）、`89506`（拒绝，24 小时）、`89507`（拒绝，1 小时）。
 * 4. **配额要分日限与分钟限**：`45009` 是日额度（可 clear_quota 恢复），`45011` 才是分钟级限流 ——
 *    两者对用户的含义与动作完全不同，文案不能混。
 *
 * ## 脱敏
 *
 * `AppSecret` 会出现在 `/cgi-bin/token` 的查询串里，`access_token` 会出现在后续所有接口的查询串里，
 * 而底层网络错误往往把整个 URL 塞进 message。因此**任何写进 `message` / 审计 / 持久化字段的文本
 * 都必须先过 `redact()`**。这条有专门用例守住。
 */

import { LocalStorage } from "./storage.js";

/** 落盘缓存的相对路径（相对 storage 根目录）。 */
export const WECHAT_MP_TOKEN_CACHE = "cache/wechat-mp-token.json";

const DEFAULT_BASE_URL = "https://api.weixin.qq.com";
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * 提前刷新余量。官方保证刷新期间**新老 token 在 5 分钟内都可用**，所以提前 5 分钟换是安全的；
 * 而稳定版接口普通模式本身也会提前 5 分钟更新，两者一致。
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** 未配置凭据时的**可执行**指引：只说「未配置」等于把用户丢在原地。 */
export const WECHAT_MP_SETUP_GUIDANCE = [
  "未配置微信公众号凭据：需要 AppID 与 AppSecret。",
  "获取路径：微信开发者平台（developers.weixin.qq.com/platform）→ 扫码登录 → 我的业务 → 公众号 → 开发密钥。",
  "同一页面可设置 API IP 白名单 —— 调用换取凭据接口的机器公网 IP 必须在白名单里，否则会报 IP 相关错误。",
  "独立后端用环境变量 WECHAT_MP_APP_ID / WECHAT_MP_APP_SECRET；桌面端在「设置 → 微信公众号」里填写。",
].join("");

export type WechatMpErrorKind =
  | "auth"
  | "secret_frozen"
  | "ip_whitelist"
  | "risk_pending"
  | "risk_rejected"
  | "permission"
  | "rate_limit"
  | "quota"
  /** 响应不是合法 JSON / HTTP 层就失败了。 */
  | "invalid_response"
  /** 连不上、超时。 */
  | "network"
  /** 微信给了错误码，但我们没有为它写专门的处理（消息里带上原码与原 msg）。 */
  | "unknown";

export type WechatMpErrorCode =
  | "wechat_mp_not_configured"
  /** 上传的图不合规（空文件 / 格式不被该端点接受 / 超过调用方给的上限）。**本地就拒，不发请求。** */
  | "wechat_mp_invalid_upload"
  /** 草稿缺必填项（title / content / thumb_media_id）。**本地就拒，不发请求。** */
  | "wechat_mp_invalid_draft";

export class WechatMpError extends Error {
  readonly status = 422;

  constructor(
    readonly code: WechatMpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WechatMpError";
  }
}

export type WechatFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface WechatMpResult<T> {
  ok: boolean;
  data?: T;
  /** 微信业务错误码（HTTP 200 时响应体里的 `errcode`）。 */
  errorCode?: number;
  errorKind?: WechatMpErrorKind;
  /** 已脱敏、可直接展示给操作者。 */
  message: string;
  /** 仅白名单类错误：微信回显的调用方 IP，用户要照抄进后台。 */
  ip?: string;
  /** 原始 errmsg（已脱敏），便于事后追查。 */
  errmsg?: string;
}

export interface WechatMpConfig {
  /** env: `WECHAT_MP_APP_ID` */
  appId?: string;
  /** env: `WECHAT_MP_APP_SECRET` */
  appSecret?: string;
  /** 便于测试指向假服务；缺省官方域名。 */
  baseUrl?: string;
  /** storage 根目录；给了才做 token 落盘缓存。 */
  storagePath?: string;
  /** 注入 HTTP 实现（测试用）。 */
  fetchImpl?: WechatFetch;
  /** 注入时钟（测试用）。 */
  now?: () => number;
  timeoutMs?: number;
}

export interface WechatVerifyItem {
  ok: boolean;
  message: string;
  errorKind?: WechatMpErrorKind;
  ip?: string;
}

export interface WechatVerifyReport {
  /** 三项全通过才为 true。 */
  ok: boolean;
  /** 凭据是否有效（换取 access_token 成功）。 */
  credentials: WechatVerifyItem;
  /** 调用方 IP 是否被接受（由换取凭据的结果反推）。 */
  ipWhitelist: WechatVerifyItem;
  /** 仅证明 `draft/count` 查询可用，不证明素材上传或新建草稿权限。 */
  draftPermission: WechatVerifyItem;
}

/** 待上传的图片。 */
export interface WechatImageUpload {
  /** 文件字节（`Buffer` 是 `Uint8Array` 的子类，可直接传）。 */
  bytes: Uint8Array;
  /**
   * 文件名。⚠️ **微信按扩展名判格式**，所以它必须与内容一致
   * （扩展名说谎会报 `40113`，而且它决定了 multipart 的 content-type）。
   */
  filename: string;
  /**
   * 调用方给出的上限（例如 `WECHAT_ARTICLE_LIMITS.contentImageBytes`）。
   * 给了就**在上传前**拦住超限图，省一次白跑 —— 上限数字的真源仍在限额表里，本模块不另写一份。
   */
  maxBytes?: number;
}

/** 要写进草稿箱的图文消息（`article_type: "news"`）。 */
export interface WechatDraftArticle {
  /** 必填，≤32 字（长度上限由 `wechat-article.ts` 的限额表管，本模块只判非空）。 */
  title: string;
  /** 必填。**内联样式的微信兼容 HTML**，且图必须是 `uploadimg` 返回的 mmbiz URL（外链会被过滤）。 */
  content: string;
  /** 必填，**必须是永久素材 MediaID**（`uploadCoverImage` 的返回值；`uploadimg` 的 URL 不能当封面）。 */
  thumbMediaId: string;
  /** 可选，≤16 字。 */
  author?: string;
  /** 可选，≤120 字；不填则由平台抓正文前 54 字。 */
  digest?: string;
  /** 可选，≤1kb，「阅读原文」的 URL。 */
  contentSourceUrl?: string;
}

interface CachedToken {
  appId: string;
  accessToken: string;
  /** 绝对时间戳（ms）。 */
  expiresAt: number;
}

const AUTH_ERROR_CODES = new Set([40001, 40002, 40013, 40125, 41002, 41004, 43002]);
/** 日额度类：45009 官方文案是 “reach max api daily quota limit”。 */
const QUOTA_ERROR_CODES = new Set([45008, 45009, 45028]);
/** 官方 `-1` = 系统繁忙，等会儿就好：它是**暂时性**的，可以换另一个端点再试。 */
const TRANSIENT_ERROR_CODES = new Set([-1]);

/**
 * 上传格式白名单（扩展名 → multipart 的 content-type）。
 *
 * ⚠️ **两个端点不一样，别合并**：`media/uploadimg` 只收 jpg/png（官方注意事项第 5 条），
 * 而 `material/add_material` 另收 bmp/gif。合并会让一张 webp 在正文图那一步悄悄溜到微信侧才报错。
 */
const CONTENT_IMAGE_TYPES = new Map<string, string>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
]);
const COVER_IMAGE_TYPES = new Map<string, string>([
  ...CONTENT_IMAGE_TYPES,
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
]);

/**
 * 错误码 → 类别。**单一真源**：模块内所有报错路径都走这里，
 * 免得同一条件在不同分支被归成不同类别（本项目在 assets 层吃过「校验有两个真源」的亏）。
 */
export function classifyWechatError(errcode: number | undefined): WechatMpErrorKind | undefined {
  if (errcode === undefined || errcode === 0) return undefined;
  if (AUTH_ERROR_CODES.has(errcode)) return "auth";
  if (errcode === 40243) return "secret_frozen";
  if (errcode === 40164 || errcode === 61004) return "ip_whitelist";
  if (errcode === 89503) return "risk_pending";
  if (errcode === 89506 || errcode === 89507) return "risk_rejected";
  if (errcode === 48001) return "permission";
  if (QUOTA_ERROR_CODES.has(errcode)) return "quota";
  if (errcode === 45011) return "rate_limit";
  return "unknown";
}

/**
 * 从 `errmsg` 里抠出调用方 IP。
 *
 * 实测形态有两种（分别对应两个官方错误码）：
 * `invalid ip 223.104.3.15 ipv6 ::ffff:223.104.3.15, not in whitelist` 与
 * `ip 223.104.3.15 not in whitelist`。优先取第一个 IP 字面量，并去掉 v4-mapped 的 `::ffff:` 前缀，
 * 因为用户要把它逐字抄进公众号后台，`::ffff:` 那种形态抄进去是不对的。
 */
export function extractWhitelistIp(errmsg: string | undefined): string | undefined {
  if (typeof errmsg !== "string") return undefined;
  const match = /(?:invalid\s+ip|\bip)\s+([0-9a-fA-F:.]+)/u.exec(errmsg);
  if (!match) return undefined;
  const candidate = match[1].replace(/^::ffff:/u, "");
  return candidate.length > 0 ? candidate : undefined;
}

interface WechatErrorBody {
  errcode?: number;
  errmsg?: string;
}

export class WechatMpClient {
  private readonly appId?: string;
  private readonly appSecret?: string;
  private readonly baseUrl: string;
  private readonly storagePath?: string;
  private readonly fetchImpl: WechatFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly storage?: LocalStorage;

  private token?: CachedToken;
  /** 单飞锁：并发调用只换取一次凭据（否则会互相顶掉）。 */
  private inFlight?: Promise<WechatMpResult<{ accessToken: string }>>;

  constructor(config: WechatMpConfig = {}) {
    this.appId = firstNonBlank(config.appId);
    this.appSecret = firstNonBlank(config.appSecret);
    this.baseUrl = (firstNonBlank(config.baseUrl) ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
    this.storagePath = firstNonBlank(config.storagePath);
    this.fetchImpl = config.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = config.now ?? (() => Date.now());
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (this.storagePath) this.storage = new LocalStorage(this.storagePath);
  }

  /** 供调用方在任何请求之前确认凭据可用。 */
  assertConfigured(): void {
    this.requireCredentials();
  }

  get configured(): boolean {
    return Boolean(this.appId && this.appSecret);
  }

  /** 换取 access_token（内存 → 落盘缓存 → 稳定版接口 → 旧接口回退）。 */
  async getAccessToken(): Promise<WechatMpResult<{ accessToken: string }>> {
    this.assertConfigured();
    if (this.isFresh(this.token)) {
      return this.tokenResult(this.token as CachedToken);
    }
    if (this.inFlight) return await this.inFlight;

    this.inFlight = this.loadAccessToken();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  /** 草稿总数。不上传素材或创建草稿，获取 token 可能触发管理员确认。 */
  async getDraftCount(): Promise<WechatMpResult<{ totalCount: number }>> {
    const token = await this.getAccessToken();
    if (!token.ok) return { ok: false, ...withoutData(token) };

    const result = await this.requestJson<{ total_count?: number }>(
      "GET",
      "/cgi-bin/draft/count",
      { accessToken: token.data?.accessToken },
    );
    if (!result.ok) return { ok: false, ...withoutData(result) };
    const count = result.data?.total_count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      return { ok: false, errorKind: "invalid_response", message: "草稿数量接口没有返回有效的 total_count，无法确认查询权限。" };
    }
    return { ok: true, message: "ok", data: { totalCount: count } };
  }

  /**
   * 账号自检：把「凭据 / IP 白名单 / 草稿箱权限」三件事一次性问清楚。
   *
   * 不建草稿、不上传素材；获取 token 可能触发管理员确认。
   * 三项**逐项独立**：凭据好但没权限时，凭据项仍然是 ok —— 这正是可行性判据要的信息。
   */
  async verifyAccount(): Promise<WechatVerifyReport> {
    this.assertConfigured();
    // 显式预检不使用缓存；普通稳定 token 不强制刷新，也不回退到会影响其它工具的旧端点。
    const fresh = await this.requestToken("stable");
    const token = fresh.ok ? await this.acceptToken(fresh) : fresh;

    if (!token.ok) {
      const item: WechatVerifyItem = {
        ok: false,
        message: token.message,
        errorKind: token.errorKind,
        ip: token.ip,
      };
      // 换不到凭据时白名单状态是**已知的**（凭据接口本身就是白名单的闸门）；
      // 但其它类别（比如 secret 写错）不能替白名单下结论。
      // 白名单这一类不在两行里重复打印同一段长指引：详细指引由 credentials 那一项给出。
      const ipWhitelist: WechatVerifyItem =
        token.errorKind === "ip_whitelist"
          ? {
              ok: false,
              errorKind: token.errorKind,
              ip: token.ip,
              message: `调用方 IP（${token.ip ?? "微信未回显"}）被白名单拒绝：请按上方指引把它加入 API IP 白名单后重试。`,
            }
          : { ok: false, message: "未能换取凭据，IP 白名单状态未知。请先解决凭据问题。" };
      return {
        ok: false,
        credentials: item,
        ipWhitelist,
        // 拿不到凭据就不该再打 draft/count：那是必然失败的噪声。
        draftPermission: { ok: false, message: "未取得凭据，无法检测草稿箱接口权限。" },
      };
    }

    const draft = await this.getDraftCount();
    return {
      ok: draft.ok,
      credentials: { ok: true, message: "凭据有效，已成功换取 access_token。" },
      ipWhitelist: { ok: true, message: "调用方 IP 被接受（换取凭据成功）。" },
      draftPermission: draft.ok
        ? { ok: true, message: `草稿数量查询通过（当前 ${draft.data?.totalCount ?? 0} 篇）；素材上传与新建草稿尚未验证。` }
        : { ok: false, message: draft.message, errorKind: draft.errorKind },
    };
  }

  /**
   * 上传封面，拿到**永久素材** `media_id`（`draft/add` 的 `thumb_media_id` 只认这个）。
   *
   * 封面比例：我们在打包阶段已按 ffmpeg 裁成 900×383（≈`2.35_1`，见 `wechat-media.ts`）。
   * ⚠️ 官方还支持 `cover_info.crop_percent_list` 同时声明 `2.35_1` + `1_1`（让平台自己裁 1:1 缩略图），
   * 那是**已记录为将来选项**的增强（research §4 吸收项 4），本轮不发 —— 别当成漏做。
   */
  async uploadCoverImage(image: WechatImageUpload): Promise<WechatMpResult<{ mediaId: string }>> {
    // 顺序有意：**先判输入、再判配置**（本项目被测试抓到过「配置压过输入」的错序）。
    const prepared = this.prepareImage(image, COVER_IMAGE_TYPES, "封面", "/cgi-bin/material/add_material");
    const token = await this.getAccessToken();
    if (!token.ok) return { ok: false, ...withoutData(token) };

    const form = new FormData();
    form.append("media", prepared.blob, prepared.filename);
    const result = await this.requestMultipart<{ media_id?: string }>("/cgi-bin/material/add_material", {
      accessToken: token.data?.accessToken,
      query: { type: "image" },
      form,
    });
    if (!result.ok) return { ok: false, ...withoutData(result) };

    const mediaId = result.data?.media_id;
    if (typeof mediaId !== "string" || !mediaId.trim()) {
      return {
        ok: false,
        errorKind: "invalid_response",
        message: "封面上传没有返回 media_id：封面未生效，草稿也没有创建，可以直接重试。",
      };
    }
    return { ok: true, message: "ok", data: { mediaId } };
  }

  /**
   * 上传正文配图，拿到微信托管 `url`。
   *
   * ⚠️ 这一步**不可省**：官方明确「外部图片 url 将被过滤」，也就是说直接把本地图/外链写进
   * `content` 的结局是**草稿里全是裂图**，而接口不会报错。
   */
  async uploadContentImage(image: WechatImageUpload): Promise<WechatMpResult<{ url: string }>> {
    const prepared = this.prepareImage(image, CONTENT_IMAGE_TYPES, "正文图", "/cgi-bin/media/uploadimg");
    const token = await this.getAccessToken();
    if (!token.ok) return { ok: false, ...withoutData(token) };

    const form = new FormData();
    form.append("media", prepared.blob, prepared.filename);
    const result = await this.requestMultipart<{ url?: string }>("/cgi-bin/media/uploadimg", {
      accessToken: token.data?.accessToken,
      form,
    });
    if (!result.ok) return { ok: false, ...withoutData(result) };

    const url = result.data?.url;
    if (typeof url !== "string" || !url.trim()) {
      return {
        ok: false,
        errorKind: "invalid_response",
        message: "正文图上传没有返回 url：请勿把本地路径写进正文（会被平台过滤成裂图），可直接重试。",
      };
    }
    return { ok: true, message: "ok", data: { url } };
  }

  /**
   * 建草稿。**这是本通路的终点**：绝不调用 `freepublish/*`（spec §2 的产品边界）。
   *
   * 只发必填 + 用户显式给的可选字段；**不给的键不出现在 payload 里**（不塞 `undefined`/空串 ——
   * 那会让预览里看到的与发出去的看起来一样、其实不同）。
   */
  async createDraft(article: WechatDraftArticle): Promise<WechatMpResult<{ mediaId: string }>> {
    const draft = this.validateDraft(article);
    const token = await this.getAccessToken();
    if (!token.ok) return { ok: false, ...withoutData(token) };

    const entry: Record<string, unknown> = {
      // 本轮只做图文消息（news）。`newspic`（图片消息）是刻意的将来选项（spec §11）——
      // 加 image_info 会把整条通路的语义变成另一种内容类型，别顺手加。
      article_type: "news",
      title: draft.title,
      content: draft.content,
      thumb_media_id: draft.thumbMediaId,
    };
    const author = firstNonBlank(article?.author);
    if (author) entry.author = author;
    const digest = firstNonBlank(article?.digest);
    if (digest) entry.digest = digest;
    const contentSourceUrl = firstNonBlank(article?.contentSourceUrl);
    if (contentSourceUrl) entry.content_source_url = contentSourceUrl;
    // 评论字段（need_open_comment / only_fans_can_comment）**目前不发**：不填即平台默认（不打开评论）。
    // 这是已记录的口径（spec §1.3「我们目前未发的三个字段」），要改先改文档。

    const result = await this.requestJson<{ media_id?: string }>("POST", "/cgi-bin/draft/add", {
      accessToken: token.data?.accessToken,
      body: { articles: [entry] },
    });
    if (!result.ok) return { ok: false, ...withoutData(result) };

    const mediaId = result.data?.media_id;
    if (typeof mediaId !== "string" || !mediaId.trim()) {
      return {
        ok: false,
        errorKind: "invalid_response",
        message:
          "draft/add 没有返回 media_id：草稿可能没有创建成功。请先到公众号后台草稿箱确认，再决定是否重试（避免重复建草稿）。",
      };
    }
    return { ok: true, message: "ok", data: { mediaId } };
  }

  /** 更新同一草稿的第一篇文章；不提供新增或发布回退。 */
  async updateDraft(mediaId: string, article: WechatDraftArticle): Promise<WechatMpResult<{ mediaId: string }>> {
    if (typeof mediaId !== "string" || !mediaId.trim() || mediaId.length > 256) {
      throw new WechatMpError("wechat_mp_invalid_draft", "更新草稿必须指定已有草稿 ID");
    }
    const draft = this.validateDraft(article);
    const token = await this.getAccessToken();
    if (!token.ok) return { ok: false, ...withoutData(token) };
    const entry: Record<string, unknown> = { article_type: "news", title: draft.title, content: draft.content, thumb_media_id: draft.thumbMediaId };
    for (const [key, value] of [["author", article.author], ["digest", article.digest], ["content_source_url", article.contentSourceUrl]]) {
      const text = firstNonBlank(value); if (text) entry[key!] = text;
    }
    const result = await this.requestJson<{ errcode?: number }>("POST", "/cgi-bin/draft/update", {
      accessToken: token.data?.accessToken, body: { media_id: mediaId, index: 0, articles: entry },
    });
    if (!result.ok) return { ok: false, ...withoutData(result) };
    if (result.data?.errcode !== 0) return { ok: false, errorKind: "invalid_response", message: "更新草稿未返回明确成功结果，请先核实原草稿，勿直接重试。" };
    return { ok: true, message: "草稿已更新，尚未发布", data: { mediaId } };
  }

  /**
   * 上传前的本地校验。
   *
   * **先判输入、再判配置**是有意的：本项目在抖音通路上被测试抓到过「配置压过输入」的错序
   * （对视频包报「未配置 sau」而不是「这不是图文包」）—— 误报的配置错误会掩盖真正的输入错误。
   * 所以格式/大小不合规时**连 token 都不换**：白跑一次凭据或一次上传都是净损失。
   */
  private prepareImage(
    image: WechatImageUpload,
    allowed: Map<string, string>,
    label: string,
    endpoint: string,
  ): { blob: Blob; filename: string } {
    const filename = typeof image?.filename === "string" ? image.filename.trim() : "";
    const size = image?.bytes?.byteLength ?? 0;
    if (size === 0) {
      throw new WechatMpError(
        "wechat_mp_invalid_upload",
        `${label}内容为空（0 字节）：没有可上传的图片，请检查打包阶段是否真的产出了文件。`,
      );
    }

    const extension = extensionOf(filename);
    const contentType = extension ? allowed.get(extension) : undefined;
    if (!contentType) {
      const accepts = [...allowed.keys()].join("/").replace(/\./gu, "");
      throw new WechatMpError(
        "wechat_mp_invalid_upload",
        `${label}只收 ${accepts}（${endpoint} 的限制），收到的文件名是“${filename || "（空）"}”：` +
          "请先把图片转成受支持的格式，并让扩展名与内容一致（扩展名说谎会被平台判为非法图片）。",
      );
    }

    if (image.maxBytes !== undefined && size > image.maxBytes) {
      throw new WechatMpError(
        "wechat_mp_invalid_upload",
        `${label}大小 ${formatMegabytes(size)}MB 超过上限 ${formatMegabytes(image.maxBytes)}MB：` +
          "请先在打包阶段压缩后再上传（这一步是必须的，平台侧会直接拒收）。",
      );
    }

    // 不自己设 content-type 头：multipart 的 boundary 必须由 fetch 生成。
    //
    // 复制到一块独立的 `ArrayBuffer` 再交给 Blob：TS 5.7 起 `Uint8Array` 的缓冲区是参数化的
    // （`Buffer` 是 `Uint8Array<ArrayBufferLike>`，理论上可挂在 SharedArrayBuffer 上），
    // 而 `BlobPart` 只接受 ArrayBuffer 背书的那种。一次 ≤10MB 的拷贝换掉一个类型断言，划算。
    const copy = new Uint8Array(image.bytes.length);
    copy.set(image.bytes);
    return { blob: new Blob([copy], { type: contentType }), filename };
  }

  /** 草稿的必填项校验；**只判非空**，长度上限的真源在 `wechat-article.ts` 的限额表里。 */
  private validateDraft(article: WechatDraftArticle): {
    title: string;
    content: string;
    thumbMediaId: string;
  } {
    const title = firstNonBlank(article?.title);
    if (!title) {
      throw new WechatMpError(
        "wechat_mp_invalid_draft",
        "草稿缺少标题（title）：draft/add 要求标题必填且不超过 32 字。",
      );
    }
    const content = article?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new WechatMpError(
        "wechat_mp_invalid_draft",
        "草稿正文为空（content）：空正文说明渲染阶段出了问题，不能在本地就把空文章提交上去。",
      );
    }
    const thumbMediaId = firstNonBlank(article?.thumbMediaId);
    if (!thumbMediaId) {
      throw new WechatMpError(
        "wechat_mp_invalid_draft",
        "草稿缺少封面素材 id（thumb_media_id）：图文消息（news）必填，且必须是永久素材 MediaID" +
          "（uploadimg 返回的正文图 URL 不能当封面）。",
      );
    }
    return { title, content, thumbMediaId };
  }

  private async loadAccessToken(): Promise<WechatMpResult<{ accessToken: string }>> {
    const cached = await this.readCache();
    if (cached) {
      this.token = cached;
      return this.tokenResult(cached);
    }

    const stable = await this.requestToken("stable");
    if (stable.ok) return this.acceptToken(stable);

    // 只有「没拿到明确业务答复」时才回退：明确的凭据错误换端点只会得到同一个答案，
    // 而回退到 /cgi-bin/token 还会顶掉既有凭据（两个端点的凭据互相隔离，但我们不必多打一次）。
    if (stable.errorCode !== undefined && !TRANSIENT_ERROR_CODES.has(stable.errorCode)) {
      return stable;
    }
    const legacy = await this.requestToken("legacy");
    if (legacy.ok) return this.acceptToken(legacy);
    return legacy;
  }

  private async acceptToken(
    result: WechatMpResult<{ accessToken: string; expiresIn: number }>,
  ): Promise<WechatMpResult<{ accessToken: string }>> {
    const accessToken = result.data?.accessToken;
    const expiresIn = result.data?.expiresIn;
    if (!accessToken || typeof expiresIn !== "number" || expiresIn <= 0) {
      return {
        ok: false,
        errorKind: "invalid_response",
        message: "微信返回的凭据响应缺少 access_token 或 expires_in，拒绝缓存不确定的凭据。",
      };
    }
    const entry: CachedToken = {
      appId: this.appId as string,
      accessToken,
      expiresAt: this.now() + expiresIn * 1000,
    };
    this.token = entry;
    await this.writeCache(entry);
    return this.tokenResult(entry);
  }

  private tokenResult(entry: CachedToken): WechatMpResult<{ accessToken: string }> {
    return { ok: true, message: "ok", data: { accessToken: entry.accessToken } };
  }

  private isFresh(entry: CachedToken | undefined): boolean {
    if (!entry || entry.appId !== this.appId) return false;
    return entry.expiresAt - this.now() > REFRESH_MARGIN_MS;
  }

  private async readCache(): Promise<CachedToken | undefined> {
    if (!this.storage) return undefined;
    try {
      const raw = await this.storage.readJson<Partial<CachedToken>>(WECHAT_MP_TOKEN_CACHE);
      const entry: CachedToken = {
        appId: typeof raw.appId === "string" ? raw.appId : "",
        accessToken: typeof raw.accessToken === "string" ? raw.accessToken : "",
        expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : 0,
      };
      return this.isFresh(entry) ? entry : undefined;
    } catch {
      // 缓存缺失/损坏都不是错误：重新换一次即可。
      return undefined;
    }
  }

  private async writeCache(entry: CachedToken): Promise<void> {
    if (!this.storage) return;
    try {
      await this.storage.writeJsonAtomic(WECHAT_MP_TOKEN_CACHE, entry);
    } catch {
      // 落盘失败不该让一次成功的凭据换取变成失败（下次重新换即可）。
    }
  }

  private async requestToken(
    kind: "stable" | "legacy",
  ): Promise<WechatMpResult<{ accessToken: string; expiresIn: number }>> {
    if (kind === "stable") {
      return await this.requestJson<{ access_token?: string; expires_in?: number }>(
        "POST",
        "/cgi-bin/stable_token",
        { body: { grant_type: "client_credential", appid: this.appId, secret: this.appSecret } },
      ).then((result) => this.asTokenData(result));
    }
    return await this.requestJson<{ access_token?: string; expires_in?: number }>(
      "GET",
      "/cgi-bin/token",
      { query: { grant_type: "client_credential", appid: this.appId as string, secret: this.appSecret as string } },
    ).then((result) => this.asTokenData(result));
  }

  private asTokenData(
    result: WechatMpResult<{ access_token?: string; expires_in?: number }>,
  ): WechatMpResult<{ accessToken: string; expiresIn: number }> {
    if (!result.ok) return { ok: false, ...withoutData(result) };
    return {
      ok: true,
      message: "ok",
      data: { accessToken: result.data?.access_token ?? "", expiresIn: result.data?.expires_in ?? 0 },
    };
  }

  private async requestJson<T>(
    method: "GET" | "POST",
    path: string,
    options: { accessToken?: string; query?: Record<string, string>; body?: unknown },
  ): Promise<WechatMpResult<T>> {
    const init: RequestInit = { method };
    if (options.body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(options.body);
    }
    return await this.send<T>(this.buildUrl(path, options), init);
  }

  /**
   * multipart 上传（封面 / 正文图）。
   *
   * 响应处理与 JSON 请求**共用 `send()`** —— 错误分类、脱敏、`errcode` 判定只有一处真源，
   * 否则上传通路会长出第二套文案（本项目最忌讳的那种分叉）。
   */
  private async requestMultipart<T>(
    path: string,
    options: { accessToken?: string; query?: Record<string, string>; form: FormData },
  ): Promise<WechatMpResult<T>> {
    // ⚠️ 不能手写 `content-type: multipart/form-data`：boundary 由 fetch 生成，手写会缺 boundary。
    return await this.send<T>(this.buildUrl(path, options), { method: "POST", body: options.form });
  }

  private buildUrl(
    path: string,
    options: { accessToken?: string; query?: Record<string, string> },
  ): URL {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    if (options.accessToken) url.searchParams.set("access_token", options.accessToken);
    return url;
  }

  /** 所有请求的公共尾段：发送 → HTTP 层 → 解析 → `errcode` 判定。 */
  private async send<T>(url: URL, init: RequestInit): Promise<WechatMpResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.sendWithSignal<T>(url, { ...init, signal: controller.signal, redirect: "error" });
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendWithSignal<T>(url: URL, init: RequestInit): Promise<WechatMpResult<T>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url.href, init);
    } catch (error) {
      return this.transportFailure("network", url, error);
    }

    // HTTP 层失败：当作「没拿到答复」，调用方可以据此换端点重试。
    if (!response.ok) {
      return this.transportFailure("network", url, new Error(`HTTP ${response.status}`), response.status);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return this.transportFailure("network", url, error);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return {
        ok: false,
        errorKind: "invalid_response",
        message: "微信接口返回了非 JSON 响应（可能是网关错误页）。",
      };
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, errorKind: "invalid_response", message: "微信接口返回了无效的响应结构。" };
    }
    const body = payload as WechatErrorBody & T;
    if (typeof body.errcode === "number" && body.errcode !== 0) {
      const failure = this.businessFailure<T>(body.errcode, body.errmsg);
      return { ...failure, message: `${url.pathname}：${failure.message}` };
    }
    return { ok: true, message: "ok", data: payload as T };
  }

  private businessFailure<T>(errcode: number, errmsg: string | undefined): WechatMpResult<T> {
    const kind = classifyWechatError(errcode);
    const ip = kind === "ip_whitelist" ? extractWhitelistIp(errmsg) : undefined;
    return {
      ok: false,
      errorCode: errcode,
      errorKind: kind,
      ip,
      errmsg: this.redact(errmsg ?? ""),
      message: this.describeError(errcode, kind, ip, errmsg),
    };
  }

  /**
   * 每个类别的文案必须**可执行且互不相同** —— 它们对应完全不同的用户动作。
   * 混成一句「微信接口调用失败」等于没有文案（本项目在抖音通路上踩过这个坑）。
   */
  private describeError(
    errcode: number,
    kind: WechatMpErrorKind | undefined,
    ip: string | undefined,
    errmsg: string | undefined,
  ): string {
    const raw = this.redact(errmsg ?? "");
    switch (kind) {
      case "auth":
        return `微信公众号凭据无效（errcode ${errcode}）：请检查 AppID 与 AppSecret 是否有多余空格、大小写是否正确。`;
      case "secret_frozen":
        return `AppSecret 已被冻结（errcode 40243）：请到 微信开发者平台 → 我的业务 → 公众号 → 开发密钥 解冻，约 10 分钟后生效。`;
      case "ip_whitelist":
        return `当前公网 IP（${ip ?? "微信未回显"}）不在公众号 IP 白名单中（errcode ${errcode}）：请到 微信开发者平台 → 我的业务 → 公众号 → 开发密钥 → API IP 白名单 添加它，然后重试。换个网络环境后 IP 会变，需要重新添加。`;
      case "risk_pending":
        return `微信要求管理员确认这个 IP 的调用（errcode 89503）：已给公众号管理员下发模板消息，请在微信里确认后重试。`;
      case "risk_rejected": {
        const wait = errcode === 89506 ? "24 小时" : "1 小时";
        return `管理员拒绝了这个 IP 的调用（errcode ${errcode}）：请等待 ${wait} 后再试，或先与管理员沟通确认。`;
      }
      case "permission":
        return `该公众号没有调用这个接口的权限（errcode 48001）：请核对后台接口权限或咨询微信官方，认证不保证解决。可下载文章和图片手工编辑。`;
      case "quota":
        return `微信公众号接口的当日额度已用完（errcode ${errcode}）：这是日额度限制，请到公众号后台查看当日用量，或等次日额度恢复。`;
      case "rate_limit":
        return `调用微信公众号接口太频繁（errcode 45011）：这是分钟级限流，请稍后重试。`;
      default:
        return `微信接口返回了未预期的错误（errcode ${errcode}）：${raw || "（无 errmsg）"}`;
    }
  }

  private transportFailure(
    kind: WechatMpErrorKind,
    url: URL,
    error: unknown,
    status?: number,
  ): WechatMpResult<never> {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errorKind: kind,
      message: `访问微信接口失败（${
        status === undefined ? "网络原因" : `HTTP ${status}`
      }）：${this.redact(detail)}`,
    };
  }

  /**
   * 抹掉任何可能出现在文本里的凭据。
   *
   * 底层网络错误常把整个 URL 塞进 message，而 `/cgi-bin/token` 的 secret 与后续接口的
   * access_token 都在查询串里。这里先按字面替换，再兜住「换了账号/形状不同」的情况。
   */
  private redact(text: string): string {
    let out = text;
    for (const secret of [this.appSecret, this.appId, this.token?.accessToken]) {
      if (secret && secret.length > 0) out = out.split(secret).join("***");
    }
    return out
      .replace(/((?:access_token|secret|appsecret)=)[^&\s"']+/giu, "$1***")
      .replace(/("(?:access_token|secret|appsecret)"\s*:\s*")[^"]*(")/giu, "$1***$2");
  }

  private requireCredentials(): { appId: string; appSecret: string } {
    if (!this.appId || !this.appSecret) {
      throw new WechatMpError("wechat_mp_not_configured", WECHAT_MP_SETUP_GUIDANCE);
    }
    return { appId: this.appId, appSecret: this.appSecret };
  }
}

function withoutData<T>(result: WechatMpResult<unknown>): Omit<WechatMpResult<T>, "ok"> {
  return {
    data: undefined,
    errorCode: result.errorCode,
    errorKind: result.errorKind,
    message: result.message,
    ip: result.ip,
    errmsg: result.errmsg,
  };
}

function firstNonBlank(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 文件名的扩展名（小写）。微信按扩展名判格式，所以这里大小写不敏感但**保留原文件名**上传。 */
function extensionOf(filename: string): string | undefined {
  const match = /\.[A-Za-z0-9]+$/u.exec(filename);
  return match ? match[0].toLowerCase() : undefined;
}

/** 人类可读的兆字节（用例断言的是 `2.0MB` / `1.0MB` 这种形态）。 */
function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

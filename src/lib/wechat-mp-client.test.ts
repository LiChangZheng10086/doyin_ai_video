/**
 * 微信公众号官方 API 客户端测试。
 *
 * **全程假 HTTP**（注入 `fetchImpl`），绝不联网、绝不触碰真实公众号。
 * 错误码与请求形状的取值依据见 spec §1.3（逐条核对过官方文档，不是猜的）：
 *
 * - 稳定版凭据：`POST /cgi-bin/stable_token`，JSON body，普通模式下有效期内不更新 token，
 *   且**平台会提前 5 分钟更新**，所以返回的 `expires_in` 可能远小于 7200；
 * - 白名单错误码**官方两处不一致**：接口错误码表写 `40164`，开发指南写 `61004` → 两个都认；
 * - 风险调用确认是**三个码**：`89503`（待管理员确认）、`89506`（拒绝，24 小时）、`89507`（拒绝，1 小时）；
 * - `45009` 是**日额度**（可 clear_quota 恢复），`45011` 才是**分钟限流**；
 * - `draft/count` 是 `GET`，返回 `{ total_count }`。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  WECHAT_MP_SETUP_GUIDANCE,
  WECHAT_MP_TOKEN_CACHE,
  WechatMpClient,
  WechatMpError,
  classifyWechatError,
  extractWhitelistIp,
  type WechatFetch,
  type WechatMpConfig,
  type WechatMpErrorKind,
} from "./wechat-mp-client.js";

// ⚠️ 测试假值**必须一眼看出不是真凭据**：这里原先用的是「`wx` 开头 + 16 位十六进制」的占位串，
// 形态恰好命中 GitHub 的「腾讯微信 AppID」规则，推送后在 Security → Secret scanning 里报了一条
// **误报**（它只是个占位符，不是谁的账号）。误报的代价不只是吓一跳 —— 它会训练人忽略这类告警。
// 所以本条注释也**不写那个字面量**：假值一律用非十六进制的可读串，别用「看起来像真的」的随机串。
const APP_ID = "test-app-id";
const APP_SECRET = "test-app-secret";
const ACCESS_TOKEN = "test-access-token";

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempStoragePath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wechat-mp-test-"));
  tempDirs.push(dir);
  return dir;
}

interface RecordedCall {
  url: string;
  method: string;
  body: string | undefined;
  /** multipart 上传的字段（三个写接口用）；非 multipart 请求为 undefined。 */
  form?: FormData;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 把响应脚本化成「按 URL 分派」的假 fetch，并记录每次调用。
 * 用 `calls` 就能断言「打了几次 token 接口」这类行为，而不只是结果对不对。
 */
function scriptedFetch(
  handler: (url: string, callIndex: number) => Response | Promise<Response> | never,
) {
  const calls: RecordedCall[] = [];
  const impl: WechatFetch = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      // 上传走 multipart：body 是 FormData 而不是字符串，只有记下它才能断言字段名/文件名。
      form: init?.body instanceof FormData ? init.body : undefined,
    });
    return await handler(url, calls.length);
  };
  return { impl, calls };
}

/** 只看换取凭据的两次调用（稳定版优先、`/cgi-bin/token` 回退）。 */
function tokenCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => isTokenRequest(call.url));
}

/**
 * 是不是「换取凭据」的请求。
 *
 * **不要写成 `url.includes("token")`**：后续接口的查询串里带着 `access_token=...`，
 * 这种朴素匹配会把 `draft/count` 也判成换取凭据的请求，于是脚本化的假 fetch 拿 token 响应
 * 去回答它 —— 断言就会以「假成功」的方式通过或失败。本文件实测踩过一次。
 */
function isTokenRequest(url: string): boolean {
  return url.includes("/cgi-bin/stable_token") || /\/cgi-bin\/token\?/u.test(url);
}

function okTokenHandler() {
  return (url: string): Response => {
    if (url.includes("/cgi-bin/stable_token") || url.includes("/cgi-bin/token")) {
      return jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 7200 });
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

function client(overrides: Partial<WechatMpConfig> = {}): WechatMpClient {
  return new WechatMpClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    baseUrl: "https://api.weixin.qq.com",
    ...overrides,
  });
}

// ── 配置 ──────────────────────────────────────────────────────────────────────

test("草稿数量响应缺失、非整数或非法 JSON 结构不能让预检假成功", async () => {
  for (const body of [{}, { total_count: -1 }, { total_count: "3" }, { total_count: 0.5 }, null, []]) {
    const c = client({ fetchImpl: async (url) => isTokenRequest(url)
      ? jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 7200 }) : jsonResponse(body) });
    const report = await c.verifyAccount();
    assert.equal(report.ok, false, JSON.stringify(body));
    assert.equal(report.draftPermission.errorKind, "invalid_response");
  }
});

test("显式连接预检重新检查稳定凭据，不把缓存当成当前 secret 和 IP 证明", async () => {
  let rejected = false;
  const c = client({ fetchImpl: async (url) => isTokenRequest(url)
    ? jsonResponse(rejected ? { errcode: 40125, errmsg: "invalid secret" } : { access_token: ACCESS_TOKEN, expires_in: 7200 })
    : jsonResponse({ total_count: 0 }) });
  assert.equal((await c.getAccessToken()).ok, true);
  rejected = true;
  assert.equal((await c.verifyAccount()).credentials.ok, false);
});

test("请求和响应体读取均受 timeoutMs 限制", async () => {
  for (const phase of ["fetch", "body"]) {
    let aborted = 0;
    const c = client({ timeoutMs: 10, fetchImpl: async (_url, init) => {
      if (!init?.signal) throw new Error("missing signal");
      const pending = () => new Promise<never>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => { aborted++; reject(new Error("aborted")); }, { once: true });
      });
      if (phase === "fetch") return pending();
      return { ok: true, text: pending } as unknown as Response;
    } });
    const result = await c.getAccessToken();
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, "network");
    assert.ok(aborted > 0, "超时必须实际取消请求或响应体读取");
  }
});

test("未配置 AppID/AppSecret 时 assertConfigured 抛明确错误，且含可执行的配置路径", () => {
  assert.throws(
    () => new WechatMpClient({}).assertConfigured(),
    (error: unknown) => {
      assert.ok(error instanceof WechatMpError);
      assert.match(error.message, /未配置/);
      // 只说「未配置」等于把用户丢在原地，必须给出路径。
      assert.match(error.message, /微信开发者平台/);
      assert.match(error.message, /开发密钥/);
      return true;
    },
  );
  assert.match(WECHAT_MP_SETUP_GUIDANCE, /IP 白名单/);
});

test("只配置了 AppID 也算未配置（两个都要有）", () => {
  assert.throws(() => new WechatMpClient({ appId: APP_ID }).assertConfigured(), WechatMpError);
  assert.throws(() => new WechatMpClient({ appSecret: APP_SECRET }).assertConfigured(), WechatMpError);
});

// ── 稳定版凭据：优先 + 回退 ────────────────────────────────────────────────────

test("优先用稳定版凭据接口，且是 POST + JSON body", async () => {
  const storagePath = await tempStoragePath();
  const { impl, calls } = scriptedFetch(okTokenHandler());
  const result = await client({ storagePath, fetchImpl: impl }).getAccessToken();

  assert.equal(result.ok, true);
  assert.equal(result.data?.accessToken, ACCESS_TOKEN);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/cgi-bin\/stable_token$/u);
  assert.equal(calls[0].method, "POST");
  const body = JSON.parse(calls[0].body ?? "{}");
  assert.equal(body.grant_type, "client_credential");
  assert.equal(body.appid, APP_ID);
  assert.equal(body.secret, APP_SECRET);
  // 强制刷新会顶掉上次的 token，我们永远不用它（官方：每天限 20 次且需间隔 30 秒）。
  assert.notEqual(body.force_refresh, true);
});

test("稳定版接口不可用时回退 /cgi-bin/token（GET + 查询参数）", async () => {
  const storagePath = await tempStoragePath();
  const { impl, calls } = scriptedFetch((url) => {
    if (url.includes("/cgi-bin/stable_token")) return jsonResponse({ errcode: -1 }, 500);
    return jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 7200 });
  });
  const result = await client({ storagePath, fetchImpl: impl }).getAccessToken();

  assert.equal(result.ok, true);
  assert.equal(tokenCalls(calls).length, 2);
  assert.match(calls[0].url, /stable_token/u);
  assert.match(calls[1].url, /\/cgi-bin\/token\?/u);
  assert.equal(calls[1].method, "GET");
  assert.match(calls[1].url, /grant_type=client_credential/u);
  assert.ok(calls[1].url.includes(APP_ID));
});

test("凭据是明确的业务错误时不回退（回退只会拿到同一个答案）", async () => {
  const storagePath = await tempStoragePath();
  const { impl, calls } = scriptedFetch(() => jsonResponse({ errcode: 40125, errmsg: "invalid appsecret" }));
  const result = await client({ storagePath, fetchImpl: impl }).getAccessToken();

  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "auth");
  assert.equal(tokenCalls(calls).length, 1);
});

// ── 错误码分类 ────────────────────────────────────────────────────────────────

const ERROR_CASES: Array<{ errcode: number; kind: WechatMpErrorKind }> = [
  { errcode: 40001, kind: "auth" },
  { errcode: 40013, kind: "auth" },
  { errcode: 40125, kind: "auth" },
  { errcode: 40002, kind: "auth" },
  { errcode: 41002, kind: "auth" },
  { errcode: 41004, kind: "auth" },
  { errcode: 43002, kind: "auth" },
  { errcode: 40243, kind: "secret_frozen" },
  { errcode: 40164, kind: "ip_whitelist" },
  { errcode: 61004, kind: "ip_whitelist" },
  { errcode: 89503, kind: "risk_pending" },
  { errcode: 89506, kind: "risk_rejected" },
  { errcode: 89507, kind: "risk_rejected" },
  { errcode: 48001, kind: "permission" },
  { errcode: 45009, kind: "quota" },
  { errcode: 45008, kind: "quota" },
  { errcode: 45028, kind: "quota" },
  { errcode: 45011, kind: "rate_limit" },
];

test("每个 errcode 都被分类到正确的 errorKind", () => {
  for (const { errcode, kind } of ERROR_CASES) {
    assert.equal(classifyWechatError(errcode), kind, `errcode ${errcode} 应归为 ${kind}`);
  }
  assert.equal(classifyWechatError(0), undefined);
  assert.equal(classifyWechatError(undefined), undefined);
  assert.equal(classifyWechatError(999999), "unknown");
});

test("每个 errorKind 的中文文案互不相同，且各自可执行", async () => {
  const byKind = new Map<WechatMpErrorKind, string>();
  for (const { errcode } of ERROR_CASES) {
    const storagePath = await tempStoragePath();
    const { impl } = scriptedFetch(() => jsonResponse({ errcode, errmsg: `errmsg for ${errcode}` }));
    const result = await client({ storagePath, fetchImpl: impl }).getAccessToken();
    assert.equal(result.ok, false);
    assert.ok(result.message.length > 0);
    if (result.errorKind) byKind.set(result.errorKind, result.message);
  }

  // 七个码对应七种不同的用户动作；混成一句兜底文案就等于没有文案。
  assert.equal(byKind.size, 8);
  const messages = [...byKind.values()];
  assert.equal(new Set(messages).size, messages.length, `文案重复：${JSON.stringify(messages)}`);
  assert.match(byKind.get("secret_frozen") ?? "", /解冻/u);
  assert.match(byKind.get("permission") ?? "", /权限/u);
  assert.match(byKind.get("ip_whitelist") ?? "", /白名单/u);
  assert.match(byKind.get("risk_pending") ?? "", /管理员/u);
  assert.match(byKind.get("risk_rejected") ?? "", /拒绝/u);
  // 日额度和分钟限流的动作完全不同（前者等额度恢复，后者稍后重试）。
  assert.match(byKind.get("quota") ?? "", /额度/u);
  assert.match(byKind.get("rate_limit") ?? "", /频繁|稍后/u);
});

test("89506 与 89507 的等待时长不同（24 小时 / 1 小时）", async () => {
  const collect = async (errcode: number) => {
    const storagePath = await tempStoragePath();
    const { impl } = scriptedFetch(() => jsonResponse({ errcode, errmsg: "rejected" }));
    return await client({ storagePath, fetchImpl: impl }).getAccessToken();
  };
  const rejected24 = await collect(89506);
  const rejected1 = await collect(89507);
  assert.match(rejected24.message, /24\s*小时/u);
  assert.match(rejected1.message, /1\s*小时/u);
  assert.notEqual(rejected24.message, rejected1.message);
});

test("非 JSON 响应与网络异常都归为对应类别，且不抛出", async () => {
  const storagePath = await tempStoragePath();
  const broken = scriptedFetch(() => new Response("<html>502</html>", { status: 200 }));
  const notJson = await client({ storagePath, fetchImpl: broken.impl }).getAccessToken();
  assert.equal(notJson.ok, false);
  assert.equal(notJson.errorKind, "invalid_response");

  const storagePath2 = await tempStoragePath();
  const offline = scriptedFetch(() => {
    throw new Error("connect ECONNREFUSED");
  });
  const network = await client({ storagePath: storagePath2, fetchImpl: offline.impl }).getAccessToken();
  assert.equal(network.ok, false);
  assert.equal(network.errorKind, "network");
  assert.match(network.message, /网络|连接/u);
});

// ── 白名单 IP 提取 ────────────────────────────────────────────────────────────

test("从 errmsg 里提取白名单 IP（40164 带 ipv6 的形态）", () => {
  assert.equal(
    extractWhitelistIp("invalid ip 223.104.3.15 ipv6 ::ffff:223.104.3.15, not in whitelist"),
    "223.104.3.15",
  );
  assert.equal(extractWhitelistIp("invalid ip 1.2.3.4, not in whitelist"), "1.2.3.4");
  // 61004 的官方文案形态。
  assert.equal(extractWhitelistIp("ip 223.104.3.15 not in whitelist"), "223.104.3.15");
  // 只有 ipv6 时也要能给出可读的值（去掉 v4-mapped 前缀）。
  assert.equal(extractWhitelistIp("invalid ip ::ffff:223.104.3.15 not in whitelist"), "223.104.3.15");
  assert.equal(extractWhitelistIp("not in whitelist"), undefined);
});

test("白名单错误要把 IP 回显出来（用户才能照抄进后台）", async () => {
  const storagePath = await tempStoragePath();
  const { impl } = scriptedFetch(() =>
    jsonResponse({
      errcode: 40164,
      errmsg: "invalid ip 223.104.3.15 ipv6 ::ffff:223.104.3.15, not in whitelist",
    }),
  );
  const result = await client({ storagePath, fetchImpl: impl }).getAccessToken();
  assert.equal(result.errorKind, "ip_whitelist");
  assert.equal(result.ip, "223.104.3.15");
  assert.match(result.message, /223\.104\.3\.15/u);
});

// ── token 缓存 ───────────────────────────────────────────────────────────────

test("同一实例连续两次取凭据只打 1 次 token 接口", async () => {
  const storagePath = await tempStoragePath();
  const { impl, calls } = scriptedFetch(okTokenHandler());
  const instance = client({ storagePath, fetchImpl: impl });
  await instance.getAccessToken();
  await instance.getAccessToken();
  assert.equal(tokenCalls(calls).length, 1);
});

test("并发取凭据只打 1 次（单飞锁）", async () => {
  const storagePath = await tempStoragePath();
  let resolved = 0;
  const { impl, calls } = scriptedFetch(async () => {
    resolved += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 7200 });
  });
  const instance = client({ storagePath, fetchImpl: impl });
  const results = await Promise.all([
    instance.getAccessToken(),
    instance.getAccessToken(),
    instance.getAccessToken(),
  ]);
  assert.equal(resolved, 1);
  assert.equal(tokenCalls(calls).length, 1);
  assert.deepEqual(
    results.map((result) => result.data?.accessToken),
    [ACCESS_TOKEN, ACCESS_TOKEN, ACCESS_TOKEN],
  );
});

test("缓存用返回的 expires_in，且提前 5 分钟刷新（不硬编码 7200）", async () => {
  const storagePath = await tempStoragePath();
  let clock = 1_000_000;
  const { impl, calls } = scriptedFetch(() =>
    jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 345 }),
  );
  const instance = client({ storagePath, fetchImpl: impl, now: () => clock });

  await instance.getAccessToken();
  assert.equal(tokenCalls(calls).length, 1);

  // 剩 315s > 300s 余量 → 复用缓存。
  clock += 30_000;
  await instance.getAccessToken();
  assert.equal(tokenCalls(calls).length, 1);

  // 剩 285s < 300s 余量 → 必须重新获取。若硬编码 7200 这里不会刷新。
  clock += 30_000;
  await instance.getAccessToken();
  assert.equal(tokenCalls(calls).length, 2);
});

test("凭据落盘缓存：新实例复用同一账号的 token，且写入 cache 路径", async () => {
  const storagePath = await tempStoragePath();
  const first = scriptedFetch(okTokenHandler());
  await client({ storagePath, fetchImpl: first.impl }).getAccessToken();
  assert.equal(tokenCalls(first.calls).length, 1);

  const cacheFile = path.join(storagePath, WECHAT_MP_TOKEN_CACHE);
  const raw = JSON.parse(await readFile(cacheFile, "utf8"));
  assert.equal(raw.appId, APP_ID);
  assert.equal(raw.accessToken, ACCESS_TOKEN);

  const second = scriptedFetch(okTokenHandler());
  const reused = await client({ storagePath, fetchImpl: second.impl }).getAccessToken();
  assert.equal(reused.ok, true);
  assert.equal(reused.data?.accessToken, ACCESS_TOKEN);
  assert.equal(tokenCalls(second.calls).length, 0, "同一账号应复用落盘缓存");
});

test("落盘缓存按 AppID 隔离：换账号绝不复用别人的 token", async () => {
  const storagePath = await tempStoragePath();
  const first = scriptedFetch(okTokenHandler());
  await client({ storagePath, fetchImpl: first.impl }).getAccessToken();

  const other = scriptedFetch(() => jsonResponse({ access_token: "another-token", expires_in: 7200 }));
  const result = await client({ storagePath, appId: "wxOTHERACCOUNT", fetchImpl: other.impl }).getAccessToken();
  assert.equal(result.data?.accessToken, "another-token");
  assert.equal(tokenCalls(other.calls).length, 1, "换 AppID 必须重新换取凭据");
});

// ── 脱敏 ─────────────────────────────────────────────────────────────────────

test("网络异常的文案里不出现 AppSecret（回退路径的 URL 带 secret）", async () => {
  const storagePath = await tempStoragePath();
  const { impl } = scriptedFetch((url) => {
    if (url.includes("/cgi-bin/stable_token")) return jsonResponse({ errcode: -1 }, 500);
    // 模拟底层把这个带 secret 的 URL 塞进错误消息。
    throw new Error(`connect ECONNREFUSED ${url}`);
  });
  const result = await client({ storagePath, fetchImpl: impl }).getAccessToken();
  assert.equal(result.ok, false);
  assert.equal(result.message.includes(APP_SECRET), false, "消息里泄露了 AppSecret");
  assert.equal(JSON.stringify(result).includes(APP_SECRET), false);
});

test("后续接口的失败文案里不出现 access_token", async () => {
  const storagePath = await tempStoragePath();
  const { impl } = scriptedFetch((url) => {
    if (isTokenRequest(url)) return jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 7200 });
    throw new Error(`connect ECONNREFUSED ${url}`);
  });
  const report = await client({ storagePath, fetchImpl: impl }).verifyAccount();
  assert.equal(report.ok, false);
  assert.equal(JSON.stringify(report).includes(ACCESS_TOKEN), false, "报告里泄露了 access_token");
  assert.equal(JSON.stringify(report).includes(APP_SECRET), false);
});

// ── verifyAccount ────────────────────────────────────────────────────────────

test("verifyAccount 逐项返回三项结论，全通过才 ok", async () => {
  const storagePath = await tempStoragePath();
  const { impl, calls } = scriptedFetch((url) => {
    if (isTokenRequest(url)) return jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 7200 });
    return jsonResponse({ total_count: 0 });
  });
  const report = await client({ storagePath, fetchImpl: impl }).verifyAccount();

  assert.equal(report.ok, true);
  assert.equal(report.credentials.ok, true);
  assert.equal(report.ipWhitelist.ok, true);
  assert.equal(report.draftPermission.ok, true);
  // draft/count 是 GET，且必须带 access_token。
  const countCall = calls.find((call) => call.url.includes("/cgi-bin/draft/count"));
  assert.ok(countCall, "应调用 /cgi-bin/draft/count");
  assert.equal(countCall.method, "GET");
  assert.match(countCall.url, /access_token=/u);
});

test("凭据有效但缺草稿箱权限时：逐项独立，凭据项仍为 ok（这就是可行性判据）", async () => {
  const storagePath = await tempStoragePath();
  const { impl } = scriptedFetch((url) => {
    if (isTokenRequest(url)) return jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 7200 });
    return jsonResponse({ errcode: 48001, errmsg: "api unauthorized" });
  });
  const report = await client({ storagePath, fetchImpl: impl }).verifyAccount();

  assert.equal(report.ok, false);
  assert.equal(report.credentials.ok, true, "凭据本身是好的");
  assert.equal(report.draftPermission.ok, false);
  assert.equal(report.draftPermission.errorKind, "permission");
  assert.match(report.draftPermission.message, /权限/u);
});

test("凭据就换取失败时，不假装后面的检查通过", async () => {
  const storagePath = await tempStoragePath();
  const { impl, calls } = scriptedFetch(() => jsonResponse({ errcode: 40164, errmsg: "invalid ip 1.2.3.4 not in whitelist" }));
  const report = await client({ storagePath, fetchImpl: impl }).verifyAccount();

  assert.equal(report.ok, false);
  assert.equal(report.credentials.ok, false);
  assert.equal(report.ipWhitelist.ok, false);
  assert.equal(report.ipWhitelist.ip, "1.2.3.4");
  // 拿不到 token 就不该再去打 draft/count（那是必然失败的噪声）。
  assert.equal(calls.some((call) => call.url.includes("/cgi-bin/draft/count")), false);
});

// ── 三个写接口：封面 / 正文图 / 草稿 ──────────────────────────────────────────
//
// 依据官方文档（2026-09-23 逐条核对，见 spec §1.3）：
// - 封面：`POST /cgi-bin/material/add_material?type=image`，form-data 字段名 `media`，返回 `media_id`（永久素材）；
// - 正文图：`POST /cgi-bin/media/uploadimg`，字段名同为 `media`，返回 `url`（微信托管，**不是 media_id**），
//   且**仅收 jpg/png 且 <1MB** —— 正文里写外链图会被官方过滤，所以这一步不可省；
// - 草稿：`POST /cgi-bin/draft/add`，JSON body `{articles:[{article_type:"news", title, content, thumb_media_id, …}]}`，
//   `thumb_media_id` 对 news **必填且必须是永久素材 MediaID**。

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

/** token 由这里统一应答，其余 URL 交给 `byPath`。 */
function writeHandler(byPath: (url: string) => Response): (url: string) => Response {
  return (url: string) => {
    if (isTokenRequest(url)) return jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 7200 });
    return byPath(url);
  };
}

/** 只看真正的业务调用（排除换取凭据）。 */
function writeCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => !isTokenRequest(call.url));
}

/**
 * multipart 里那个文件字段。
 *
 * ⚠️ 必须**投影成普通对象**再断言：Node 的 `File` 把 `name`/`type`/`size` 放在原型上，
 * `assert.deepEqual` 只比较自有可枚举属性，直接比会拿一个满是 `Symbol(...)` 的 File 去比。
 */
function mediaPart(call: RecordedCall | undefined): { name: string; type: string; size: number } {
  const part = call?.form?.get("media");
  assert.ok(part, "multipart 里必须有 media 字段");
  const file = part as unknown as { name?: string; type?: string; size: number };
  return { name: file.name ?? "", type: file.type ?? "", size: file.size };
}

test("封面走永久素材接口（type=image），multipart 字段名是 media 且保留文件名", async () => {
  const { impl, calls } = scriptedFetch(
    writeHandler(() => jsonResponse({ media_id: "cover-media-id", url: "https://mmbiz.qpic.cn/x" })),
  );
  const result = await client({ fetchImpl: impl }).uploadCoverImage({
    bytes: JPEG_BYTES,
    filename: "cover.jpg",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.mediaId, "cover-media-id");
  const call = writeCalls(calls)[0];
  assert.equal(call.method, "POST");
  assert.match(call.url, /\/cgi-bin\/material\/add_material\?/u);
  assert.match(call.url, /type=image/u);
  assert.match(call.url, /access_token=/u);
  // 微信按**文件名扩展名**判格式（40113 就是「扩展名说谎」），所以名字必须原样送达。
  assert.deepEqual(mediaPart(call), { name: "cover.jpg", type: "image/jpeg", size: JPEG_BYTES.byteLength });
});

test("正文图走 media/uploadimg，返回微信托管 URL（不是 media_id）", async () => {
  const hosted = "https://mmbiz.qpic.cn/mmbiz_jpg/abc/0?wx_fmt=jpeg";
  const { impl, calls } = scriptedFetch(writeHandler(() => jsonResponse({ url: hosted })));
  const result = await client({ fetchImpl: impl }).uploadContentImage({
    bytes: PNG_BYTES,
    filename: "body.png",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.url, hosted);
  assert.deepEqual(Object.keys(result.data ?? {}), ["url"]);
  const call = writeCalls(calls)[0];
  assert.match(call.url, /\/cgi-bin\/media\/uploadimg\?/u);
  // uploadimg 没有 type 参数（那是 add_material 的）。
  assert.doesNotMatch(call.url, /type=image/u);
  assert.equal(mediaPart(call).name, "body.png");
  assert.equal(mediaPart(call).type, "image/png");
});

test("正文图只收 jpg/png：webp 在上传前就被拒，一个请求都不发", async () => {
  const { impl, calls } = scriptedFetch(() => {
    throw new Error("格式不合规时不该发出任何请求（连 token 也不该换）");
  });

  await assert.rejects(
    () => client({ fetchImpl: impl }).uploadContentImage({ bytes: JPEG_BYTES, filename: "shot.webp" }),
    (error: unknown) => {
      assert.ok(error instanceof WechatMpError);
      assert.match(error.message, /jpg/iu);
      assert.match(error.message, /png/iu);
      // 只说「格式不对」不够：要说明**这个接口**只收什么。
      assert.match(error.message, /uploadimg|正文图/u);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("封面格式比正文图宽：bmp/gif/png/jpg 都收，webp 仍被拒，扩展名大小写不敏感", async () => {
  for (const filename of ["cover.bmp", "cover.gif", "cover.png", "cover.JPG"]) {
    const { impl } = scriptedFetch(writeHandler(() => jsonResponse({ media_id: "m" })));
    const result = await client({ fetchImpl: impl }).uploadCoverImage({ bytes: JPEG_BYTES, filename });
    assert.equal(result.ok, true, `${filename} 应被接受`);
  }

  const { impl, calls } = scriptedFetch(() => {
    throw new Error("不该发出请求");
  });
  await assert.rejects(
    () => client({ fetchImpl: impl }).uploadCoverImage({ bytes: JPEG_BYTES, filename: "cover.webp" }),
    WechatMpError,
  );
  assert.equal(calls.length, 0);
});

test("空文件与没有扩展名的文件都在本地被拒（不浪费一次上传）", async () => {
  const { impl, calls } = scriptedFetch(() => {
    throw new Error("不该发出请求");
  });
  const c = client({ fetchImpl: impl });

  await assert.rejects(
    () => c.uploadCoverImage({ bytes: new Uint8Array(), filename: "cover.jpg" }),
    /空/u,
  );
  await assert.rejects(() => c.uploadCoverImage({ bytes: JPEG_BYTES, filename: "cover" }), WechatMpError);
  await assert.rejects(() => c.uploadContentImage({ bytes: JPEG_BYTES, filename: "  " }), WechatMpError);
  assert.equal(calls.length, 0);
});

test("给了 maxBytes 就本地拦住超限图，且文案给出实际大小与上限", async () => {
  const { impl, calls } = scriptedFetch(() => {
    throw new Error("超限时不该发出请求");
  });
  const twoMb = new Uint8Array(2 * 1024 * 1024);

  await assert.rejects(
    () =>
      client({ fetchImpl: impl }).uploadContentImage({
        bytes: twoMb,
        filename: "big.jpg",
        maxBytes: 1024 * 1024,
      }),
    (error: unknown) => {
      assert.ok(error instanceof WechatMpError);
      assert.match(error.message, /2\.0\s*MB/u);
      assert.match(error.message, /1\.0\s*MB/u);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("上传接口的报错走同一套分类与文案（48001 → 权限，不是另写一份）", async () => {
  const { impl } = scriptedFetch(
    writeHandler(() => jsonResponse({ errcode: 48001, errmsg: "api unauthorized" })),
  );
  const result = await client({ fetchImpl: impl }).uploadContentImage({
    bytes: PNG_BYTES,
    filename: "body.png",
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 48001);
  assert.equal(result.errorKind, "permission");
  assert.match(result.message, /权限/u);
});

test("上传响应缺 media_id / url 时判 invalid_response，绝不拿 undefined 冒充成功", async () => {
  const { impl: coverImpl } = scriptedFetch(writeHandler(() => jsonResponse({ url: "https://mmbiz.qpic.cn/x" })));
  const cover = await client({ fetchImpl: coverImpl }).uploadCoverImage({
    bytes: JPEG_BYTES,
    filename: "cover.jpg",
  });
  assert.equal(cover.ok, false);
  assert.equal(cover.errorKind, "invalid_response");

  const { impl: bodyImpl } = scriptedFetch(writeHandler(() => jsonResponse({ media_id: "m" })));
  const body = await client({ fetchImpl: bodyImpl }).uploadContentImage({
    bytes: PNG_BYTES,
    filename: "body.png",
  });
  assert.equal(body.ok, false);
  assert.equal(body.errorKind, "invalid_response");
});

test("createDraft 的 payload 是 articles[] + article_type=news + thumb_media_id", async () => {
  const { impl, calls } = scriptedFetch(writeHandler(() => jsonResponse({ media_id: "draft-media-id" })));
  const result = await client({ fetchImpl: impl }).createDraft({
    title: "标题",
    content: "<p>正文</p>",
    thumbMediaId: "cover-media-id",
    author: "作者",
    digest: "摘要",
    contentSourceUrl: "https://example.com/post",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.mediaId, "draft-media-id");
  const call = writeCalls(calls)[0];
  assert.equal(call.method, "POST");
  assert.match(call.url, /\/cgi-bin\/draft\/add\?/u);
  assert.match(call.url, /access_token=/u);

  const payload = JSON.parse(call.body ?? "{}") as { articles: Array<Record<string, unknown>> };
  assert.equal(payload.articles.length, 1);
  const article = payload.articles[0];
  assert.equal(article.article_type, "news");
  assert.equal(article.title, "标题");
  assert.equal(article.content, "<p>正文</p>");
  assert.equal(article.thumb_media_id, "cover-media-id");
  assert.equal(article.author, "作者");
  assert.equal(article.digest, "摘要");
  assert.equal(article.content_source_url, "https://example.com/post");
});

test("createDraft 不给可选字段时，payload 里就不出现这些键（不塞 undefined/空串）", async () => {
  const { impl, calls } = scriptedFetch(writeHandler(() => jsonResponse({ media_id: "d" })));
  const result = await client({ fetchImpl: impl }).createDraft({
    title: "标题",
    content: "<p>正文</p>",
    thumbMediaId: "cover-media-id",
  });
  assert.equal(result.ok, true);

  const article = (JSON.parse(writeCalls(calls)[0].body ?? "{}") as {
    articles: Array<Record<string, unknown>>;
  }).articles[0];
  for (const key of ["author", "digest", "content_source_url"]) {
    assert.equal(key in article, false, `${key} 未提供时不该出现在 payload 里`);
  }
});

test("本轮只做图文消息（news）：payload 不带 image_info，也不发评论字段", async () => {
  // 这三条是**刻意的决定**，不是遗漏：newspic（图片消息）本轮不做（spec §11）；
  // 评论字段我们目前不发（不填 = 平台默认：不打开评论）。别顺手加。
  const { impl, calls } = scriptedFetch(writeHandler(() => jsonResponse({ media_id: "d" })));
  await client({ fetchImpl: impl }).createDraft({
    title: "标题",
    content: "<p>正文</p>",
    thumbMediaId: "cover-media-id",
  });

  const article = (JSON.parse(writeCalls(calls)[0].body ?? "{}") as {
    articles: Array<Record<string, unknown>>;
  }).articles[0];
  assert.equal(article.article_type, "news");
  assert.equal("image_info" in article, false, "newspic 本轮不做，不该出现 image_info");
  assert.equal("need_open_comment" in article, false);
  assert.equal("only_fans_can_comment" in article, false);
});

test("createDraft 的必填项为空白时在本地就拒（一个请求都不发）", async () => {
  const { impl, calls } = scriptedFetch(() => {
    throw new Error("不该发出请求");
  });
  const c = client({ fetchImpl: impl });
  const base = { title: "标题", content: "<p>正文</p>", thumbMediaId: "cover-media-id" };

  await assert.rejects(() => c.createDraft({ ...base, title: "   " }), /标题/u);
  await assert.rejects(() => c.createDraft({ ...base, content: "  " }), /正文/u);
  await assert.rejects(() => c.createDraft({ ...base, thumbMediaId: " " }), /封面|thumb/iu);
  assert.equal(calls.length, 0);
});

test("三个写接口共用同一份凭据（同一实例只换一次 token）", async () => {
  const { impl, calls } = scriptedFetch(writeHandler((url) =>
    url.includes("/cgi-bin/draft/add")
      ? jsonResponse({ media_id: "draft" })
      : url.includes("/cgi-bin/media/uploadimg")
        ? jsonResponse({ url: "https://mmbiz.qpic.cn/y" })
        : jsonResponse({ media_id: "cover" }),
  ));
  const c = client({ fetchImpl: impl });
  await c.uploadCoverImage({ bytes: JPEG_BYTES, filename: "cover.jpg" });
  await c.uploadContentImage({ bytes: PNG_BYTES, filename: "body.png" });
  await c.createDraft({ title: "标题", content: "<p>正文</p>", thumbMediaId: "cover" });

  // 每次调用都换一次凭据会白烧 2000/日 的额度，还会与用户其它工具互相顶掉 token。
  assert.equal(tokenCalls(calls).length, 1);
  assert.equal(writeCalls(calls).length, 3);
});

test("写接口的失败文案里不出现 access_token（multipart 走的是同一套脱敏）", async () => {
  const { impl } = scriptedFetch((url) => {
    if (isTokenRequest(url)) return jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 7200 });
    throw new Error(`connect ECONNREFUSED ${url}`);
  });
  const c = client({ fetchImpl: impl });

  const cover = await c.uploadCoverImage({ bytes: JPEG_BYTES, filename: "cover.jpg" });
  assert.equal(cover.ok, false);
  assert.equal(JSON.stringify(cover).includes(ACCESS_TOKEN), false, "上传失败文案泄露了 access_token");

  const draft = await c.createDraft({ title: "标题", content: "<p>正文</p>", thumbMediaId: "c" });
  assert.equal(draft.ok, false);
  assert.equal(draft.message.includes(ACCESS_TOKEN), false);
  assert.match(draft.message, /\*\*\*/u, "脱敏后应留下 *** 痕迹");
});

test("微信返回非字符串或空白 ID/URL 时不能当成上传或建草稿成功", async () => {
  for (const value of [123, {}, "   "]) {
    const { impl } = scriptedFetch(writeHandler(() => jsonResponse({ media_id: value, url: value })));
    const c = client({ fetchImpl: impl });
    assert.equal((await c.uploadCoverImage({ bytes: JPEG_BYTES, filename: "cover.jpg" })).errorKind, "invalid_response");
    assert.equal((await c.uploadContentImage({ bytes: PNG_BYTES, filename: "body.png" })).errorKind, "invalid_response");
    assert.equal((await c.createDraft({ title: "标题", content: "<p>正文</p>", thumbMediaId: "cover" })).errorKind, "invalid_response");
  }
});


test("updateDraft locks the original media ID and first article, never adds or publishes", async () => {
  const { impl, calls } = scriptedFetch(url => isTokenRequest(url) ? jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 7200 }) : jsonResponse({ errcode: 0, errmsg: "ok" }));
  const c = client({ fetchImpl: impl });
  const result = await c.updateDraft("existing-draft", { title:"改排版", content:"<p>正文</p>", thumbMediaId:"cover", author:"作者" });
  assert.equal(result.ok, true); assert.equal(result.data?.mediaId, "existing-draft");
  const writes = calls.filter(call => !isTokenRequest(call.url));
  assert.equal(writes.length, 1); assert.equal(new URL(writes[0].url).pathname, "/cgi-bin/draft/update");
  assert.deepEqual(JSON.parse(writes[0].body!), { media_id:"existing-draft", index:0, articles:{ article_type:"news", title:"改排版", content:"<p>正文</p>", thumb_media_id:"cover", author:"作者" } });
  await assert.rejects(c.updateDraft("", {title:"标题",content:"<p>正文</p>",thumbMediaId:"cover"}), /草稿/);
  assert.equal(calls.length, 2);
});

test("updateDraft requires explicit errcode zero and never retries ambiguous responses", async () => {
  for (const response of [{}, {errcode:"0"}, {errcode:48001,errmsg:"unauthorized"}]) {
    const {impl,calls}=scriptedFetch(url => isTokenRequest(url) ? jsonResponse({access_token:ACCESS_TOKEN,expires_in:7200}) : jsonResponse(response));
    const result=await client({fetchImpl:impl}).updateDraft("existing-draft",{title:"标题",content:"<p>正文</p>",thumbMediaId:"cover"});
    assert.equal(result.ok,false);assert.equal(calls.filter(call=>!isTokenRequest(call.url)).length,1);
  }
});

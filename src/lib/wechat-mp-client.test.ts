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

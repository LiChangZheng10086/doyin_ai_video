/**
 * 「像真凭据的东西不许进仓库」这条纪律的**扫描器**用例。
 *
 * 立项原因（2026-09-20 实际发生）：公众号用例里写了一个 `wx` 开头 + 16 位十六进制的**占位值**，
 * 形态恰好命中 GitHub secret scanning 的「腾讯微信 AppID」规则，推送后报了一条误报。
 * 误报的代价不只是吓一跳 —— 它会训练人忽略这类告警。所以把判断挪到**本地提交前**。
 *
 * ⚠️ 本文件自身**不能写出那个字面量**（否则扫描器扫到自己就命中）——
 * 用例里的「像凭据的串」一律用 `join`/拼接构造，这既是技巧也是纪律。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { redact, scanText, type SecretFinding } from "./secret-scan.js";

/** 把字面量拆开构造：本文件里绝不出现完整的「像凭据」的串。 */
const shape = (...parts: string[]) => parts.join("");

const lineOf = (findings: SecretFinding[], index = 0): SecretFinding => findings[index]!;

test("命中：微信/腾讯 AppID 形态（就是触发 GitHub 误报的那个）", () => {
  const text = `const APP_ID = "${shape("wx", "1234567890abcdef")}";`;
  const findings = scanText(text, "src/lib/example.test.ts");

  assert.equal(findings.length, 1);
  assert.equal(lineOf(findings).line, 1);
  assert.match(lineOf(findings).rule, /wechat-appid/u);
});

test("命中：常见的密钥/令牌形态", () => {
  const cases: Array<[string, RegExp]> = [
    [`const key = "${shape("sk-", "abcdefghijklmnopqrstuvwxyz012345")}";`, /openai-key/u],
    [`token: "${shape("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789")}"`, /github-token/u],
    [`aws = "${shape("AKIA", "IOSFODNN7EXAMPLE")}"`, /aws-access-key/u],
    [`google = "${shape("AIza", "SyA1234567890abcdefghijklmnopqrstuvwxyz")}"`, /google-api-key/u],
    [`const s = "${shape("xoxb", "-123456789012-abcdefghijklmnop")}";`, /slack-token/u],
    [`jwt = "${shape("eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".abcdefghijklmnop")}"`, /jwt/u],
    // 私有密钥头也**动态构造**：本文件的纪律是「不写出会被自己命中的字面量」。
    [shape("-----BEGIN ", "RSA PRIVATE KEY-----"), /private-key/u],
  ];

  for (const [text, rule] of cases) {
    const findings = scanText(text, "src/lib/example.ts");
    assert.equal(findings.length, 1, `未命中：${text.slice(0, 24)}…`);
    assert.match(lineOf(findings).rule, rule);
  }
});

test("命中：赋值形态 + 看起来像真的值（cookie / token / secret 都算）", () => {
  const text = [
    `const session = "sessionid=${shape("a1b2c3d4e5f60718", "293a4b5c6d7e8f90")}";`,
    `const apiKey = "${shape("Zx9", "Qw8Er7Ty6Ui5Op4As3Df2Gh1")}";`,
  ].join("\n");
  const findings = scanText(text, "src/lib/example.ts");

  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((item) => item.line), [1, 2]);
});

test("放行：一眼可辨的假值（test- / fake- / example- / 占位符）", () => {
  const text = [
    'const APP_ID = "test-app-id";',
    'const APP_SECRET = "test-app-secret";',
    'const ACCESS_TOKEN = "test-access-token";',
    'const apiKey = "fake-key-for-tests-0123456789";',
    'const token = "example-token";',
    'const secret = "your-secret-here";',
    'const id = "<APP_ID>";',
    'const other = "{{access_token}}";',
    'const placeholder = "CHANGEME";',
  ].join("\n");

  assert.deepEqual(scanText(text, "src/lib/example.test.ts"), []);
});

// 这条是**刻意的严格**：形态规则（微信 AppID / OpenAI key / GitHub token / AWS / Slack / Google…）
// 一律不看值像不像假值 —— 因为要跟 GitHub secret scanning 的判定对齐。否则会出现最坏的情况：
// 本地放行、GitHub 照报（2026-09-20 那次误报正是这么来的）。想通过就把假值改成可读串。
test("形态规则与 GitHub 判定对齐：哪怕值是 xxx 也照报（改假值，而不是往白名单加词）", () => {
  const text = `const key = "${shape("sk-", "x".repeat(24))}";`;
  const findings = scanText(text, "src/lib/example.test.ts");

  assert.equal(findings.length, 1);
  assert.match(lineOf(findings).rule, /openai-key/u);
});

test("放行：散文里提到字段名但没有值（文档/注释不能被误伤）", () => {
  const text = [
    "关键认证 Cookie 包括：`sessionid`, `sid_guard`, `passport_csrf_token`, `odin_tt`, `ttwid`",
    'placeholder="sessionid=xxx; sid_guard=xxx; ..."',
    "// 环境变量：SAU_BINARY / SAU_BASE_DIR / TOUTIAO_BROWSER_BINARY",
    "const field = 'appSecret';",
  ].join("\n");

  assert.deepEqual(scanText(text, "src/lib/example.ts"), []);
});

test("放行：注释里的显式豁免（只在形态无法回避时用，优先改名）", () => {
  const text = `const sample = "${shape("wx", "1234567890abcdef")}"; // secret-scan:allow 文档举例`;
  assert.deepEqual(scanText(text, "docs/example.md"), []);
});

test("上报内容必须**打码**：不能把命中的串原样打进日志（日志本身也是泄露面）", () => {
  const raw = shape("wx", "1234567890abcdef");
  const findings = scanText(`const APP_ID = "${raw}";`, "src/lib/example.ts");

  assert.equal(lineOf(findings).match, redact(raw));
  assert.equal(lineOf(findings).match.includes("1234567890"), false, "中段不该出现");
  assert.match(lineOf(findings).match, /^wx12…cdef$/u);
});

test("行号与规则名可用于定位：多行文本里只报命中行", () => {
  const text = ["// 注释", "const a = 1;", `const APP_ID = "${shape("wx", "1234567890abcdef")}";`, "const b = 2;"].join("\n");
  const findings = scanText(text, "src/lib/example.ts");

  assert.equal(findings.length, 1);
  assert.equal(lineOf(findings).line, 3);
  assert.equal(lineOf(findings).file, "src/lib/example.ts");
});

// ─── 误报回归：第一版规则在本仓扫出 104 处「命中」，几乎全是标识符/表达式 ──────────
//
// 吵的检查等于没有检查（人会直接绕过它），所以这些形态必须放行；同时真值仍要被抓到。

test("误报回归：赋值规则只认**带引号的字面量**，标识符与表达式一律放行", () => {
  const text = [
    "const token = fixtureToken;",
    "const apiKey = process.env.DEEPSEEK_API_KEY;",
    "api_key = os.environ['DEEPSEEK_API_KEY'];",
    "ApiKey=Environment",                       // 文档里的写法（不带引号）
    "  token: bootstrapToken,",                  // 对象字段指向变量
    'const credential = "clientSecret";',        // 带引号但没数字 → 像名字不像凭据
    'const token = "bootstrap-token-value";',    // 同上，且含 value 提示词
  ].join("\n");

  assert.deepEqual(scanText(text, "docs/example.md"), []);
});

test("误报回归：真值仍然要抓到（带引号 + 含数字 + 不像假值）", () => {
  // 这个「像真的」的值同样**动态构造** —— 写字面量的话，本文件会被自己扫出来
  //（这不是假设：第一版就是这么被抓的，`npm run check` 直接失败）。
  const text = `const apiKey = "${shape("Zx9Qw8", "Er7Ty6Ui5Op4As3Df2Gh1")}";`;
  const findings = scanText(text, "src/lib/example.ts");

  assert.equal(findings.length, 1);
  assert.equal(lineOf(findings).rule, "credential-looking-value");
});

test("自加的规则（抖音 cookie / Bearer）要看假值白名单：fixture 不该被误报", () => {
  const text = [
    'assert.match(header, /^sessionid=refreshed-session-id; /u);',   // 上一条实测误报
    "const cookie = 'sessionid=fake-session-id';",
    'const header = "Bearer test-token-value";',
  ].join("\n");

  assert.deepEqual(scanText(text, "src/lib/sau-runner.test.ts"), []);
});

test("自加的规则对**像真的** cookie 值仍然报（含数字的长串）", () => {
  const text = `const cookie = "sessionid=${shape("a1b2c3d4e5f60718", "293a4b5c6d7e8f90")}";`;
  const findings = scanText(text, "src/lib/example.ts");

  assert.equal(findings.length, 1);
  assert.equal(lineOf(findings).rule, "douyin-cookie");
});

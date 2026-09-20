/**
 * 本地凭据扫描：**提交前**拦住「看起来像真凭据」的串。
 *
 * 立项原因（2026-09-20 实际发生）：`wechat-mp-client.test.ts` 里写了一个
 * 「`wx` 开头 + 16 位十六进制」的**占位值**（十六进制部分就是键盘顺序，纯属随手敲的假值），
 * 形态恰好命中 GitHub secret scanning 的「腾讯微信 AppID」规则 → 推送后报警。
 * 那不是真泄露（`APP_SECRET` 一直是 `fake-secret-…`，真泄露的前提是两者成对），
 * 但**误报也要在源头掐掉**：它会长期挂在 Security 里，而且会训练人忽略这类告警。
 *
 * 设计取舍：
 * - **不做「像不像随机串」的熵判断**：那类启发式在中文注释、哈希、base64 图片上误报率高，
 *   而误报正是我们要消灭的东西。这里只用**已知凭据形态** + **赋值形态 + 值不像假值**两条规则。
 * - **假值白名单是固定的可读词**（test-/fake-/example-/placeholder/xxx/`<…>`/`{{…}}` 等）：
 *   想通过扫描，就把假值改得**一眼可辨**，而不是往白名单里塞更多词。
 * - **上报一律打码**（`wx12…cdef`）：日志和 CI 输出本身就是泄露面。
 * - 确需保留形态时，在该行写 `secret-scan:allow` 并在旁边说明为什么 —— 但**优先改名**。
 */

export interface SecretFinding {
  file: string;
  /** 1 基行号。 */
  line: number;
  /** 命中的规则名（用于说明「像什么」）。 */
  rule: string;
  /** **已打码**的命中片段。 */
  match: string;
}

/** 显式豁免标记（写在同一行）。 */
export const ALLOW_MARKER = "secret-scan:allow";

/**
 * 一眼可辨的假值特征。**只收可读词**，不收「像随机串」的东西 ——
 * 后者正是我们要拦的（`1234567890abcdef` 那种随手敲的串不算可读词）。
 */
const FAKE_VALUE_HINTS = [
  "fake", "test", "dummy", "sample", "example", "placeholder", "your", "xxx", "redacted",
  "changeme", "todo", "none", "null", "undefined", "empty", "unknown", "here", "notreal",
  // 实测里被误报过的「可读假值」与「表达式」，一律放行：
  "fixture", "environ", "process", "getenv", "config", "value", "prev", "boot", "local",
  "<", ">", "{{", "}}", "*",
];

/** 高置信度形态：命中即报，不看值像不像假值（GitHub 也是这么判的）。 */
// ⚠️ 定长量词后**不要**再加 `\b`：`AIza[0-9A-Za-z_-]{35}\b` 只在长度**恰好** 35 时成立，
// 多一位就整体不匹配（写下这条时正踩了这个坑：测试值 39 位，扫描直接漏掉）。
// 凭据扫描宁可宽一点：命中后人来判断，漏掉才是真出事的那个方向。
//
// **两类规则，判定口径不同**（这是被两次实测校准出来的）：
// - `githubAligned: true` —— GitHub secret scanning 也有对应检测器的形态。**不看假值白名单**：
//   否则会出现最坏情况「本地放行、GitHub 照报」（2026-09-20 那次误报就是这么来的）。
//   想通过就把假值改成可读串。
// - `githubAligned: false` —— 我们自己加的（抖音 cookie、Bearer）。这些 GitHub 不会报，
//   所以**要看假值白名单与「值像不像真凭据」**，否则纯属自找噪音
//   （实测：`sessionid=refreshed-session-id` 这类测试 fixture 会被误报）。
const SHAPE_RULES: Array<{ rule: string; pattern: RegExp; githubAligned: boolean; valueGroup: number }> = [
  { rule: "wechat-appid", pattern: /\bwx[0-9a-f]{16}/u, githubAligned: true, valueGroup: 0 },
  { rule: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/u, githubAligned: true, valueGroup: 0 },
  { rule: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/u, githubAligned: true, valueGroup: 0 },
  { rule: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/u, githubAligned: true, valueGroup: 0 },
  { rule: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}/u, githubAligned: true, valueGroup: 0 },
  { rule: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/u, githubAligned: true, valueGroup: 0 },
  { rule: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/u, githubAligned: true, valueGroup: 0 },
  { rule: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u, githubAligned: true, valueGroup: 0 },
  { rule: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u, githubAligned: true, valueGroup: 0 },
  {
    rule: "douyin-cookie",
    pattern: /\b(?:sessionid|sid_guard|sid_tt|passport_csrf_token|ttwid|odin_tt)=([A-Za-z0-9%._-]{16,})/u,
    githubAligned: false,
    valueGroup: 1,
  },
  {
    rule: "bearer-token",
    pattern: /\bBearer\s+([A-Za-z0-9._-]{20,})/u,
    githubAligned: false,
    valueGroup: 1,
  },
];

/**
 * 赋值形态：`字段名: "值"` —— **值必须带引号**。
 *
 * 收紧是被实测逼出来的：第一版允许不带引号，于是在本仓扫出 104 处「命中」，
 * 几乎全是 `token: fixtureToken`、`api_key=process.env.DEEPSEEK_API_KEY`、
 * `ApiKey=Environment` 这类**标识符与表达式**。吵的检查等于没有检查 —— 人会直接绕过它。
 *
 * 现在的判定（全部满足才报）：
 * 1. 值是**带引号的字面量**（表达式/标识符天然被排除）；
 * 2. 值里**有数字**（真凭据几乎都含数字；纯字母的多半是 `bootstrapToken` 这种名字）；
 * 3. 值**不是** `ENV_VAR` 风格的全大写串，也**不含 `.`**（成员访问/路径）；
 * 4. 值不命中可读假值白名单（`fake` / `test` / `fixture` / `{{…}}` …）。
 *
 * 代价：不含数字的真凭据会被漏掉。这是**有意的取舍** —— 形态规则（`sk-` / `wx…` /
 * `ghp_` …）负责那些，通用规则宁可少报也不引入误报。
 */
const ASSIGNMENT_RULE = "credential-looking-value";
const ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|`
  + String.raw`secret|token|password|passwd|credential|private[_-]?key)\b\s*[:=]\s*`
  + String.raw`(["'])([^"'\n]{16,})\2`,
  "iu",
);

function looksFake(value: string): boolean {
  const lower = value.toLowerCase();
  return FAKE_VALUE_HINTS.some((hint) => lower.includes(hint));
}

/** 值像不像「真的凭据字面量」（见上面 1–4 条）。 */
function looksLikeSecretValue(value: string): boolean {
  if (looksFake(value)) return false;
  if (!/\d/u.test(value)) return false;
  if (/^[A-Z0-9_]+$/u.test(value)) return false;
  if (value.includes(".")) return false;
  return true;
}

/** 打码：只留头 4 尾 4，中段用 `…`（日志/CI 输出本身也是泄露面）。 */
export function redact(value: string): string {
  if (value.length <= 10) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** 扫描一段文本，返回按行序排列的命中项。纯函数，便于单测与在别处复用。 */
export function scanText(text: string, file: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = (text ?? "").split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.includes(ALLOW_MARKER)) continue;

    for (const { rule, pattern, githubAligned, valueGroup } of SHAPE_RULES) {
      const hit = pattern.exec(line);
      if (!hit) continue;
      // 非 GitHub 对齐的规则要看「值像不像真凭据」：这些形态 GitHub 不会报，
      // 误报纯属自找麻烦（实测被 `sessionid=refreshed-session-id` 这类 fixture 误报过）。
      if (!githubAligned && !looksLikeSecretValue(hit[valueGroup] ?? hit[0])) continue;
      findings.push({ file, line: index + 1, rule, match: redact(hit[0]) });
      break; // 一行只报一次：同一行可能同时命中多条规则，报最具体的即可
    }
    if (findings.at(-1)?.line === index + 1) continue;

    const assignment = ASSIGNMENT_PATTERN.exec(line);
    if (assignment && looksLikeSecretValue(assignment[3]!)) {
      findings.push({
        file,
        line: index + 1,
        rule: ASSIGNMENT_RULE,
        match: `${assignment[1]}=${redact(assignment[3]!)}`,
      });
    }
  }

  return findings;
}

/** 给人和 CI 看的一行说明（含可照做的修法）。 */
export function formatFinding(finding: SecretFinding): string {
  return `${finding.file}:${finding.line}  [${finding.rule}] ${finding.match}`;
}

/** 命中时的统一指引：**优先把假值改成一眼可辨的**，而不是往白名单里加词。 */
export const REMEDIATION = [
  "像真凭据的串不许进仓库（本地检查，对应 GitHub secret scanning）。",
  "修法：把假值改成一眼可辨的（test-app-id / fake-secret / example-token / <APP_ID> / {{token}}），",
  "不要用「看起来像真的」的随机串。确需保留形态时在该行写 `secret-scan:allow` 并说明原因。",
  "若命中的是**真**凭据：先撤销/轮换，再改代码 —— 仅仅删掉字符串是不够的（历史里还在）。",
].join("\n");

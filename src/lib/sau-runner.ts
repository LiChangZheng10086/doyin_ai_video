/**
 * social-auto-upload（sau）CLI 执行器
 *
 * 与项目里 yt-dlp / whisper-cli / hyperframes 同模式：把外部引擎包成一层薄封装，
 * 由调用方注入 `sauBinary` / `sauBaseDir`，测试用临时目录里的假 CLI 跑，
 * **绝不联网、绝不触碰真实抖音**。
 *
 * 上游契约（2026-09-17 从 `dreammis/social-auto-upload@main` 源码逐条确认，非猜测）：
 *
 * ```
 * sau douyin check --account <name>          # 打印 valid/invalid，退出码 0/1
 * sau douyin upload-note --account <name> \
 *     --images <img1> <img2> ...             # nargs="+", 必填, ≤35 张
 *     --title <T>                            # 必填, ≤20 字符
 *     --note <N> | --notef <file>            # ≤1000 字符
 *     [--tags t1,t2] [--bgm 名称] [--schedule <时间>]
 * ```
 *
 * 账号文件与验证码文件都相对 `BASE_DIR`（= `conf.py` 所在目录，即 `sauBaseDir`）：
 * `resolve_runtime_home()` 就是 `Path(BASE_DIR)`，`resolve_account_file()` 拼
 * `cookies/<platform>_<account>.json`，验证码走 `verify_code.txt`。
 *
 * 验证码通路的关键事实：上游 `_read_verify_code()` **先读文件、再回退到 stdin**，
 * 而 `stdin` 不是 TTY 时直接返回空串。所以我们以 `stdio[0]="ignore"` 启动子进程不会
 * 卡在 `input()`，**写文件是唯一可靠的投喂方式**；上游验证通过后会自行删除该文件。
 *
 * 关于 `sauBinary`：本 runner 的每条通路都要驱动 `sau`，因此**缺少 `sauBinary` 时所有
 * 公开方法一律以「未配置」明确报错**，不静默产出半成品（例如孤立的账号文件）。
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CommandError, runCommand } from "./command.js";
import { getCookiePath } from "./douyin-cookie.js";

/** 上游 `DouYinNote.validate_upload_args()` 的三条硬限制。 */
export const SAU_NOTE_MAX_TITLE = 20;
export const SAU_NOTE_MAX_LENGTH = 1000;
export const SAU_NOTE_MAX_IMAGES = 35;

const DEFAULT_ACCOUNT_NAME = "mine";
const DOUYIN_COOKIE_DOMAIN = ".douyin.com";

/**
 * `check` 要启动 patchright chromium 并最多重试 3 次（上游每次 goto 超时 90s），
 * 所以预检也要给足时间，不能按「一条命令」估。
 */
const CHECK_TIMEOUT_MS = 300_000;
/** 上传是分钟级：传图 + 填文案 + 发布循环。 */
const UPLOAD_TIMEOUT_MS = 900_000;

/**
 * 上游在发布循环里等验证码时会打这两条 warning；第三条是它的交互式提问文案。
 * 命中任意一条即认为「需要短信验证码」。
 */
const VERIFICATION_MARKERS = [
  "检测到短信验证码弹窗",
  "等待验证码输入",
  "请输入抖音短信验证码",
];

/**
 * 未配置时给操作者的**可执行安装指引**。
 *
 * Global Constraints 要求这里必须覆盖 spec §1.2 的三个坑 —— 只说「未配置」等于把用户
 * 丢进一个 970MB 的坑里自己踩。三条都来自 2026-09-17 的实测，不是推测。
 */
export const SAU_INSTALL_GUIDANCE = [
  "未配置抖音自动发布引擎：需要外部 social-auto-upload（github.com/dreammis/social-auto-upload）的 sau CLI。",
  "安装前请注意三个已知坑：",
  "① 按官方步骤装完 CLI 可能起不来 —— pyproject 只声明了 patchright，但仍有 7 个 uploader 与 myUtils 在 import playwright，需手动补装 playwright；",
  "② Python 版本要求 >=3.10,<3.13，本机若是 3.13 需另装 3.12；",
  "③ 仓库 + venv + patchright chromium 约占 970MB。",
  "装好后配置 SAU_BINARY（sau 可执行文件路径）与 SAU_BASE_DIR（含 conf.py 的仓库根目录），然后重启后端。",
].join("");

/** 上游 `print("valid" if is_valid else "invalid")`：`invalid` 里含 `valid` 子串，必须用词边界。 */
const VALID_OUTPUT_PATTERN = /\bvalid\b/iu;

export type SauRunnerErrorCode =
  | "sau_not_configured"
  | "sau_invalid_arguments"
  | "sau_cookie_unavailable"
  | "sau_account_file_unreadable";

const ERROR_MESSAGES: Record<SauRunnerErrorCode, string> = {
  sau_not_configured: "",
  sau_invalid_arguments: "",
  sau_cookie_unavailable: "",
  sau_account_file_unreadable: "",
};

export class SauRunnerError extends Error {
  readonly status = 422;

  constructor(readonly code: SauRunnerErrorCode, message: string) {
    super(message || ERROR_MESSAGES[code]);
    this.name = "SauRunnerError";
  }
}

export interface SauCommandRunner {
  run(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      captureStdout?: boolean;
      captureStderr?: boolean;
      timeoutMs?: number;
    },
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface SauRunnerConfig {
  /** `sau` 可执行文件路径（env: `SAU_BINARY`）。 */
  sauBinary?: string;
  /** sau 仓库根目录（含 `conf.py`）（env: `SAU_BASE_DIR`）。 */
  sauBaseDir?: string;
  /** 我们自己的 Cookie 头文件；缺省用项目唯一的 `douyin-cookie.ts` 路径。 */
  cookieFilePath?: string;
  /** sau 账号名，决定 `cookies/douyin_<name>.json`。 */
  accountName?: string;
  /** 注入子进程执行器（测试用）。 */
  commandRunner?: SauCommandRunner;
}

export interface SauResult {
  ok: boolean;
  /** 进程退出码；超时 / 无法启动时为 -1。 */
  exitCode: number;
  /** stdout 与 stderr 合并后的原文，供审计与 `autoPublish.message` 使用。 */
  output: string;
  /** 上游是否在等短信验证码（需要写 `verify_code.txt`）。 */
  needsVerificationCode: boolean;
}

export interface SauUploadNoteInput {
  imagePaths: string[];
  title: string;
  note: string;
  tags: string[];
}

export interface SauStorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

export interface SauStorageState {
  cookies: SauStorageStateCookie[];
  origins: unknown[];
}

export class SauRunner {
  readonly cookieFilePath: string;
  readonly accountName: string;
  private readonly sauBinary?: string;
  private readonly sauBaseDir?: string;
  private readonly runner: SauCommandRunner;

  constructor(config: SauRunnerConfig = {}) {
    this.sauBinary = firstNonBlank(config.sauBinary);
    this.sauBaseDir = firstNonBlank(config.sauBaseDir);
    this.cookieFilePath = firstNonBlank(config.cookieFilePath) ?? getCookiePath();
    this.accountName = firstNonBlank(config.accountName) ?? DEFAULT_ACCOUNT_NAME;
    this.runner = config.commandRunner ?? { run: runCommand };
  }

  get accountFilePath(): string {
    return path.join(this.requireBaseDir(), "cookies", `douyin_${this.accountName}.json`);
  }

  get verifyCodeFilePath(): string {
    return path.join(this.requireBaseDir(), "verify_code.txt");
  }

  /** 供调用方在任何写入之前先行确认引擎可用（缺 `sauBinary` 即抛「未配置」）。 */
  assertConfigured(): void {
    this.requireBinary();
    this.requireBaseDir();
  }

  /** 登录态预检。`ok` 的语义是「登录态有效」，因此退出码 0 但没有 `valid` 也算失败（fail closed）。 */
  async checkLogin(): Promise<SauResult> {
    this.requireBinary();
    const result = await this.run(["douyin", "check", "--account", this.accountName], CHECK_TIMEOUT_MS);
    return { ...result, ok: result.exitCode === 0 && VALID_OUTPUT_PATTERN.test(result.output) };
  }

  /** 把我们的 Cookie 头转成 Playwright `storage_state` 写到 sau 的账号文件（权限 600）。 */
  async prepareAccountFile(): Promise<string> {
    this.requireBinary();
    const header = await readCookieHeaderFile(this.cookieFilePath);
    const state = cookieHeaderToStorageState(header);
    if (state.cookies.length === 0) {
      throw new SauRunnerError(
        "sau_cookie_unavailable",
        `抖音 Cookie 文件为空或格式不可用（${this.cookieFilePath}），无法生成 sau 账号文件；请先完成扫码登录。`,
      );
    }

    const accountFile = this.accountFilePath;
    await mkdir(path.dirname(accountFile), { recursive: true, mode: 0o700 });
    await writeFile(accountFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // writeFile 的 mode 只在创建时生效，已存在的文件必须显式收紧。
    await chmod(accountFile, 0o600);
    return accountFile;
  }

  /** 把 sau 跑完回写的账号文件转回 Cookie 头，覆盖我们自己的 cookie 文件。 */
  async syncBackCookies(): Promise<string> {
    this.requireBinary();
    const accountFile = this.accountFilePath;
    let raw: string;
    try {
      raw = await readFile(accountFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SauRunnerError(
          "sau_account_file_unreadable",
          `未找到 sau 账号文件（${accountFile}），无法回写 Cookie。`,
        );
      }
      throw new SauRunnerError("sau_account_file_unreadable", `sau 账号文件不可读取（${accountFile}）。`);
    }

    const header = storageStateToCookieHeader(parseStorageState(raw));
    if (header.length === 0) {
      throw new SauRunnerError(
        "sau_account_file_unreadable",
        `sau 账号文件里没有可用 Cookie（${accountFile}），拒绝用空内容覆盖本地登录态。`,
      );
    }
    await writeFile(this.cookieFilePath, header, "utf8");
    return header;
  }

  /**
   * 提交一条抖音图文。
   *
   * 本地先按上游同款硬限制校验，免得把注定失败的请求送进浏览器流程
   * （上游在启动浏览器之后才 validate，失败代价高）。
   */
  async runUploadNote(input: SauUploadNoteInput): Promise<SauResult> {
    this.requireBinary();
    const imagePaths = input.imagePaths.filter((imagePath) => isNonBlankString(imagePath));
    if (imagePaths.length === 0) {
      throw new SauRunnerError("sau_invalid_arguments", "图文发布至少需要一张图片。");
    }
    if (imagePaths.length > SAU_NOTE_MAX_IMAGES) {
      throw new SauRunnerError(
        "sau_invalid_arguments",
        `图文发布最多支持 ${SAU_NOTE_MAX_IMAGES} 张图片，当前 ${imagePaths.length} 张。`,
      );
    }
    const title = input.title ?? "";
    if (title.trim().length === 0) {
      throw new SauRunnerError("sau_invalid_arguments", "图文发布的标题不能为空。");
    }
    if (title.length > SAU_NOTE_MAX_TITLE) {
      throw new SauRunnerError(
        "sau_invalid_arguments",
        `图文标题不能超过 ${SAU_NOTE_MAX_TITLE} 字符，当前 ${title.length} 字符。`,
      );
    }
    const note = input.note ?? "";
    if (note.length > SAU_NOTE_MAX_LENGTH) {
      throw new SauRunnerError(
        "sau_invalid_arguments",
        `图文正文不能超过 ${SAU_NOTE_MAX_LENGTH} 字符，当前 ${note.length} 字符。`,
      );
    }

    const args = ["douyin", "upload-note", "--account", this.accountName, ...optionArg("--images", imagePaths)];
    args.push(...optionArg("--title", title));
    if (note.length > 0) args.push(...optionArg("--note", note));
    const tags = input.tags.filter((tag) => isNonBlankString(tag));
    if (tags.length > 0) args.push(...optionArg("--tags", tags.join(",")));

    return this.run(args, UPLOAD_TIMEOUT_MS);
  }

  private async run(args: string[], timeoutMs: number): Promise<SauResult> {
    const sauBinary = this.requireBinary();
    try {
      const { stdout, stderr } = await this.runner.run(sauBinary, args, {
        captureStdout: true,
        captureStderr: true,
        timeoutMs,
      });
      return buildResult(0, stdout, stderr);
    } catch (error) {
      if (error instanceof CommandError) {
        const output = combineOutput(error.stdout, error.stderr);
        return {
          ok: false,
          exitCode: error.exitCode ?? -1,
          // 超时 / 无法启动时没有任何输出，此时把错误本身当作 output，别丢信息。
          output: output.length > 0 ? output : error.message,
          needsVerificationCode: mentionsVerificationCode(output),
        };
      }
      return {
        ok: false,
        exitCode: -1,
        output: error instanceof Error ? error.message : String(error),
        needsVerificationCode: false,
      };
    }
  }

  private requireBinary(): string {
    if (!this.sauBinary) {
      throw new SauRunnerError(
        "sau_not_configured",
        `未配置 sau 可执行文件（sauBinary / SAU_BINARY）。${SAU_INSTALL_GUIDANCE}`,
      );
    }
    return this.sauBinary;
  }

  private requireBaseDir(): string {
    if (!this.sauBaseDir) {
      throw new SauRunnerError(
        "sau_not_configured",
        `未配置 sau 仓库目录（sauBaseDir / SAU_BASE_DIR）。${SAU_INSTALL_GUIDANCE}`,
      );
    }
    return this.sauBaseDir;
  }
}

/**
 * 解析 Cookie 头字符串（`name=value; name2=value2`）为 name/value 对。
 *
 * 只按**第一个** `=` 切分，因此 base64 之类的值里带 `=` 不会被截断；
 * 没有 `=` 或名字为空的段直接跳过。
 */
export function parseCookieHeader(header: string): Array<{ name: string; value: string }> {
  const pairs: Array<{ name: string; value: string }> = [];
  for (const segment of (header ?? "").split(";")) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    if (name.length === 0) continue;
    pairs.push({ name, value: trimmed.slice(separator + 1).trim() });
  }
  return pairs;
}

/**
 * Cookie 头 → Playwright `storage_state`。
 *
 * 字段形状与默认值照抄上游 `export_douyin_cookie.sh`：`path="/"`、`expires=-1`（会话
 * Cookie）、`httpOnly=false`、`secure=true`、`sameSite="Lax"`，域固定 `.douyin.com`。
 */
export function cookieHeaderToStorageState(
  header: string,
  domain: string = DOUYIN_COOKIE_DOMAIN,
): SauStorageState {
  return {
    cookies: parseCookieHeader(header).map(({ name, value }) => ({
      name,
      value,
      domain,
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    })),
    origins: [],
  };
}

/**
 * `storage_state` → Cookie 头。
 *
 * 同名 Cookie 只保留一条（先取 `douyin.com` 域的那条），因为 Cookie 头没有域概念，
 * 同名重复会让请求带上一组歧义值。
 */
export function storageStateToCookieHeader(state: SauStorageState): string {
  const byName = new Map<string, SauStorageStateCookie>();
  for (const cookie of state.cookies ?? []) {
    if (!isNonBlankString(cookie?.name) || typeof cookie.value !== "string") continue;
    const name = cookie.name.trim();
    const existing = byName.get(name);
    if (!existing || (!isDouyinDomain(existing.domain) && isDouyinDomain(cookie.domain))) {
      byName.set(name, cookie);
    }
  }
  return [...byName.values()].map((cookie) => `${cookie.name.trim()}=${cookie.value}`).join("; ");
}

function isDouyinDomain(domain: unknown): boolean {
  if (typeof domain !== "string") return false;
  // 注意不能用 includes("douyin.com")：`iesdouyin.com` 是另一个站点，却含该子串。
  const normalized = domain.trim().toLowerCase().replace(/^\./u, "");
  return normalized === "douyin.com" || normalized.endsWith(".douyin.com");
}

function parseStorageState(raw: string): SauStorageState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SauRunnerError(
      "sau_account_file_unreadable",
      "sau 账号文件不是合法 JSON，无法回写 Cookie。",
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.cookies)) {
    throw new SauRunnerError(
      "sau_account_file_unreadable",
      "sau 账号文件缺少 cookies 字段，无法回写 Cookie。",
    );
  }
  return {
    cookies: parsed.cookies
      .map(normalizeStateCookie)
      .filter((cookie): cookie is SauStorageStateCookie => cookie !== undefined),
    origins: [],
  };
}

function normalizeStateCookie(value: unknown): SauStorageStateCookie | undefined {
  if (!isRecord(value) || !isNonBlankString(value.name)) return undefined;
  return {
    name: value.name,
    value: typeof value.value === "string" ? value.value : "",
    domain: typeof value.domain === "string" ? value.domain : DOUYIN_COOKIE_DOMAIN,
    path: typeof value.path === "string" ? value.path : "/",
    expires: typeof value.expires === "number" ? value.expires : -1,
    httpOnly: value.httpOnly === true,
    secure: value.secure !== false,
    sameSite: typeof value.sameSite === "string" ? value.sameSite : "Lax",
  };
}

/**
 * `--opt value` / `--opt=value` 的取舍。
 *
 * 上游用的是 argparse：值以 `-` 开头时，`--note <值>` 会被当成「少了一个参数」而报错，
 * 而 `--note=<值>` 作为单个 token 可安全携带任意内容。因此只在必要时切换写法，
 * 其余情况保持上游文档里的两 token 形式。
 */
function optionArg(name: string, value: string | string[]): string[] {
  if (Array.isArray(value)) return [name, ...value];
  return value.startsWith("-") ? [`${name}=${value}`] : [name, value];
}

async function readCookieHeaderFile(cookieFilePath: string): Promise<string> {
  try {
    return (await readFile(cookieFilePath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SauRunnerError(
        "sau_cookie_unavailable",
        `未找到抖音 Cookie 文件（${cookieFilePath}），请先完成扫码登录。`,
      );
    }
    throw new SauRunnerError(
      "sau_cookie_unavailable",
      `抖音 Cookie 文件不可读取（${cookieFilePath}），请检查文件权限。`,
    );
  }
}

function combineOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter((part) => part.length > 0).join("\n");
}

function mentionsVerificationCode(output: string): boolean {
  return VERIFICATION_MARKERS.some((marker) => output.includes(marker));
}

function buildResult(exitCode: number, stdout: string, stderr: string): SauResult {
  const output = combineOutput(stdout, stderr);
  return {
    ok: exitCode === 0,
    exitCode,
    output,
    needsVerificationCode: mentionsVerificationCode(output),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (isNonBlankString(value)) return value;
  }
  return undefined;
}

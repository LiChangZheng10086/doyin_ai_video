import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getCookiePath } from "./douyin-cookie.js";
import {
  SauRunner,
  SauRunnerError,
  cookieHeaderToStorageState,
  storageStateToCookieHeader,
  type SauRunnerConfig,
} from "./sau-runner.js";

/** 假凭据，形状与真实 Cookie 头一致（59 段量级），但值全是假的。 */
const COOKIE_HEADER = [
  "sessionid=fake-session-id",
  "sessionid_ss=fake-session-id-ss",
  "sid_guard=fake-sid-guard",
  "uid_tt=fake-uid-tt",
  "sid_tt=fake-sid-tt",
  "ttwid=fake-ttwid",
].join("; ");

/** 上游 `DouYinNote.validate_upload_args` 的三条硬限制（已从源码确认）。 */
const MAX_TITLE = 20;
const MAX_NOTE = 1000;
const MAX_IMAGES = 35;

let stubCounter = 0;

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * 在临时目录写一个假 CLI（shell stub）并 chmod +x。
 * 测试**绝不联网、绝不调用真实 sau、绝不触碰真实抖音**。
 */
async function stubSau(
  directory: string,
  options: { stdout?: string; stderr?: string; exitCode?: number; argvFile?: string } = {},
): Promise<string> {
  stubCounter += 1;
  const stubPath = path.join(directory, `sau-stub-${stubCounter}.sh`);
  const lines = ["#!/bin/sh"];
  if (options.argvFile) lines.push(`printf '%s\\n' "$@" > ${shQuote(options.argvFile)}`);
  for (const line of (options.stdout ?? "").split("\n")) {
    if (line.length > 0) lines.push(`printf '%s\\n' ${shQuote(line)}`);
  }
  for (const line of (options.stderr ?? "").split("\n")) {
    if (line.length > 0) lines.push(`printf '%s\\n' ${shQuote(line)} >&2`);
  }
  lines.push(`exit ${options.exitCode ?? 0}`);
  await writeFile(stubPath, `${lines.join("\n")}\n`, "utf8");
  await chmod(stubPath, 0o755);
  return stubPath;
}

async function sauFixture(overrides: Partial<SauRunnerConfig> = {}) {
  const workDir = await realpath(await mkdtemp(path.join(tmpdir(), "sau-runner-")));
  const sauBaseDir = path.join(workDir, "sau");
  await mkdir(sauBaseDir, { recursive: true });
  const cookieFilePath = path.join(workDir, "douyin-cookie.txt");
  await writeFile(cookieFilePath, COOKIE_HEADER, "utf8");
  return {
    workDir,
    sauBaseDir,
    cookieFilePath,
    accountFile: path.join(sauBaseDir, "cookies", "douyin_mine.json"),
    config: { sauBaseDir, cookieFilePath, accountName: "mine", ...overrides } satisfies SauRunnerConfig,
  };
}

async function readArgv(argvFile: string): Promise<string[]> {
  return (await readFile(argvFile, "utf8")).split("\n").filter((line) => line.length > 0);
}

function stateCookie(name: string, value: string, domain: string) {
  return {
    name,
    value,
    domain,
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
  };
}

async function readAccountFile(accountFile: string): Promise<{
  cookies: Array<Record<string, unknown>>;
  origins: unknown[];
}> {
  return JSON.parse(await readFile(accountFile, "utf8")) as {
    cookies: Array<Record<string, unknown>>;
    origins: unknown[];
  };
}

test("checkLogin reports ok when the CLI prints valid and exits zero", async () => {
  const { workDir, config } = await sauFixture();
  const argvFile = path.join(workDir, "argv.txt");
  const sauBinary = await stubSau(workDir, { stdout: "valid", exitCode: 0, argvFile });
  const runner = new SauRunner({ ...config, sauBinary });

  const result = await runner.checkLogin();

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.needsVerificationCode, false);
  assert.match(result.output, /valid/u);
  assert.deepEqual(await readArgv(argvFile), ["douyin", "check", "--account", "mine"]);
});

test("checkLogin reports not ok for invalid without matching the valid substring", async () => {
  const { workDir, config } = await sauFixture();
  const sauBinary = await stubSau(workDir, { stdout: "invalid", exitCode: 1 });
  const runner = new SauRunner({ ...config, sauBinary });

  const result = await runner.checkLogin();

  // `invalid`.includes("valid") === true，所以判定不能是朴素的 /valid/。
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.trim(), "invalid");
});

test("checkLogin fails closed when the CLI exits zero without printing valid", async () => {
  const { workDir, config } = await sauFixture();
  const sauBinary = await stubSau(workDir, { stdout: "something else", exitCode: 0 });
  const runner = new SauRunner({ ...config, sauBinary });

  assert.equal((await runner.checkLogin()).ok, false);
});

test("every entry point refuses to run when sauBinary is not configured", async () => {
  const { sauBaseDir, cookieFilePath } = await sauFixture();
  const runner = new SauRunner({ sauBaseDir, cookieFilePath, accountName: "mine" });

  for (const call of [
    () => runner.checkLogin(),
    () => runner.prepareAccountFile(),
    () => runner.syncBackCookies(),
    () => runner.runUploadNote({ imagePaths: ["/tmp/a.png"], title: "标题", note: "正文", tags: [] }),
  ]) {
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(error instanceof SauRunnerError);
      assert.equal(error.code, "sau_not_configured");
      assert.match(error.message, /未配置/u);
      // Global Constraints：必须带上 spec §1.2 的三个安装坑，否则用户会掉进一个 970MB 的坑里
      assert.match(error.message, /playwright/u);
      assert.match(error.message, /3\.12/u);
      assert.match(error.message, /970MB/u);
      assert.match(error.message, /SAU_BASE_DIR/u);
      return true;
    });
  }
});

test("prepareAccountFile converts our cookie header into a 600 mode Playwright storage state", async () => {
  const { workDir, config, accountFile } = await sauFixture();
  // 故意不提供 sauBinary：准备凭据是纯文件转换，不应调用 CLI。
  const sauBinary = await stubSau(workDir, { exitCode: 3 });
  const runner = new SauRunner({ ...config, sauBinary });

  const preparedPath = await runner.prepareAccountFile();

  assert.equal(preparedPath, accountFile);
  const state = await readAccountFile(accountFile);
  assert.deepEqual(state.origins, []);
  assert.equal(state.cookies.length, 6);
  assert.equal((await stat(accountFile)).mode & 0o777, 0o600);
  for (const cookie of state.cookies) {
    assert.equal(cookie.domain, ".douyin.com");
    assert.equal(cookie.path, "/");
    assert.equal(cookie.expires, -1);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, false);
    assert.equal(cookie.sameSite, "Lax");
    assert.equal(typeof cookie.name, "string");
    assert.equal(typeof cookie.value, "string");
  }
  const session = state.cookies.find((cookie) => cookie.name === "sessionid");
  assert.equal(session?.value, "fake-session-id");
});

test("prepareAccountFile refuses an empty or unusable cookie file instead of writing a useless state", async () => {
  const { workDir, config, cookieFilePath, accountFile } = await sauFixture();
  const runner = new SauRunner({ ...config, sauBinary: await stubSau(workDir, {}) });

  await writeFile(cookieFilePath, "   \n", "utf8");
  await assert.rejects(runner.prepareAccountFile(), (error: unknown) => {
    assert.ok(error instanceof SauRunnerError);
    assert.match(error.message, /Cookie/u);
    return true;
  });
  await assert.rejects(stat(accountFile), { code: "ENOENT" });

  // 没有可解析的 name=value 段同样拒绝。
  await writeFile(cookieFilePath, "this-is-not-a-cookie-header", "utf8");
  await assert.rejects(runner.prepareAccountFile(), (error: unknown) => error instanceof SauRunnerError);
});

test("syncBackCookies writes refreshed tokens back as a cookie header and round-trips", async () => {
  const { workDir, config, cookieFilePath, accountFile } = await sauFixture();
  const runner = new SauRunner({ ...config, sauBinary: await stubSau(workDir, {}) });
  await runner.prepareAccountFile();

  // 模拟 sau 跑完回写的 storage_state：sessionid 被刷新，并多了一个新 cookie。
  const state = await readAccountFile(accountFile);
  state.cookies = state.cookies.map((cookie) => (
    cookie.name === "sessionid" ? { ...cookie, value: "refreshed-session-id" } : cookie
  ));
  state.cookies.push({
    name: "odin_tt",
    value: "fresh-odin",
    domain: ".douyin.com",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
  });
  await writeFile(accountFile, JSON.stringify(state), "utf8");

  const header = await runner.syncBackCookies();

  assert.equal(await readFile(cookieFilePath, "utf8"), header);
  assert.match(header, /^sessionid=refreshed-session-id; /u);
  assert.match(header, /; odin_tt=fresh-odin$/u);
  assert.doesNotMatch(header, /\{|\}|"cookies"/u);
  // 往返语义等价：再转一次 storage_state 得到同一组 name/value。
  const roundTripped = cookieHeaderToStorageState(header);
  assert.deepEqual(
    roundTripped.cookies.map((cookie) => [cookie.name, cookie.value]),
    state.cookies.map((cookie) => [cookie.name, cookie.value]),
  );
  // 原来的 cookie 文件不是 JSON，回写后也不该变成 JSON。
  assert.doesNotMatch(await readFile(cookieFilePath, "utf8"), /^\{/u);
});

test("unmodified round-trip preserves the original cookie pairs in order", async () => {
  const { workDir, config, cookieFilePath } = await sauFixture();
  const runner = new SauRunner({ ...config, sauBinary: await stubSau(workDir, {}) });

  await runner.prepareAccountFile();
  const header = await runner.syncBackCookies();

  const original = cookieHeaderToStorageState(COOKIE_HEADER);
  const roundTripped = cookieHeaderToStorageState(header);
  assert.deepEqual(roundTripped.cookies, original.cookies);
  assert.equal(await readFile(cookieFilePath, "utf8"), COOKIE_HEADER);
});

test("runUploadNote detects the upstream verification code prompt", async () => {
  const { workDir, config } = await sauFixture();
  const sauBinary = await stubSau(workDir, {
    stdout: [
      "🏃 小人开始搬运图文，共 11 张图片",
      "📱 检测到短信验证码弹窗",
      "⏳ 等待验证码输入；可在交互终端直接输入，或写入文件: /sau/verify_code.txt",
    ].join("\n"),
    exitCode: 1,
  });
  const runner = new SauRunner({ ...config, sauBinary });

  const result = await runner.runUploadNote({
    imagePaths: ["/tmp/01.png", "/tmp/02.png"],
    title: "标题",
    note: "正文",
    tags: [],
  });

  assert.equal(result.needsVerificationCode, true);
  assert.equal(result.ok, false);
  assert.match(result.output, /检测到短信验证码弹窗/u);
});

test("runUploadNote keeps the CLI output for both success and failure", async () => {
  const { workDir, config } = await sauFixture();
  const okBinary = await stubSau(workDir, { stdout: "🥳 图文发布成功，小人开心收工", exitCode: 0 });
  const okRunner = new SauRunner({ ...config, sauBinary: okBinary });

  const ok = await okRunner.runUploadNote({ imagePaths: ["/tmp/a.png"], title: "标题", note: "", tags: [] });
  assert.equal(ok.ok, true);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.needsVerificationCode, false);
  assert.match(ok.output, /图文发布成功/u);

  const failBinary = await stubSau(workDir, { stdout: "❌ 发布失败：元素未找到", stderr: "Traceback", exitCode: 1 });
  const failRunner = new SauRunner({ ...config, sauBinary: failBinary });

  const failed = await failRunner.runUploadNote({ imagePaths: ["/tmp/a.png"], title: "标题", note: "", tags: [] });
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 1);
  assert.match(failed.output, /发布失败：元素未找到/u);
  assert.match(failed.output, /Traceback/u);
});

test("runUploadNote reports a clear failure when the binary cannot be launched", async () => {
  const { config } = await sauFixture();
  const runner = new SauRunner({ ...config, sauBinary: "/nonexistent/sau-binary" });

  const result = await runner.runUploadNote({ imagePaths: ["/tmp/a.png"], title: "标题", note: "", tags: [] });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, -1);
  assert.equal(result.needsVerificationCode, false);
  assert.ok(result.output.length > 0);
});

test("runUploadNote assembles the upstream argv with every image and flag", async () => {
  const { workDir, config } = await sauFixture();
  const argvFile = path.join(workDir, "argv.txt");
  const sauBinary = await stubSau(workDir, { stdout: "ok", exitCode: 0, argvFile });
  const runner = new SauRunner({ ...config, sauBinary });
  const imagePaths = Array.from({ length: 11 }, (_, index) => `/pkg/images/${String(index + 1).padStart(2, "0")}.png`);

  await runner.runUploadNote({
    imagePaths,
    title: "图文标题",
    note: "图文正文",
    tags: ["内容创作", "效率"],
  });

  const argv = await readArgv(argvFile);
  assert.deepEqual(argv.slice(0, 4), ["douyin", "upload-note", "--account", "mine"]);
  const imagesIndex = argv.indexOf("--images");
  assert.notEqual(imagesIndex, -1);
  assert.deepEqual(argv.slice(imagesIndex + 1, imagesIndex + 1 + imagePaths.length), imagePaths);
  assert.equal(argv[imagesIndex + 1 + imagePaths.length], "--title");
  assert.equal(argv[imagesIndex + 2 + imagePaths.length], "图文标题");
  assert.equal(argv[imagesIndex + 3 + imagePaths.length], "--note");
  assert.equal(argv[imagesIndex + 4 + imagePaths.length], "图文正文");
  assert.equal(argv[imagesIndex + 5 + imagePaths.length], "--tags");
  assert.equal(argv[imagesIndex + 6 + imagePaths.length], "内容创作,效率");
  assert.equal(argv.length, imagesIndex + 7 + imagePaths.length);
});

test("runUploadNote omits empty tags and keeps a leading-dash note parseable", async () => {
  const { workDir, config } = await sauFixture();
  const argvFile = path.join(workDir, "argv.txt");
  const sauBinary = await stubSau(workDir, { stdout: "ok", exitCode: 0, argvFile });
  const runner = new SauRunner({ ...config, sauBinary });

  await runner.runUploadNote({
    imagePaths: ["/tmp/a.png"],
    title: "-要点标题",
    note: "-要点正文",
    tags: [],
  });

  const argv = await readArgv(argvFile);
  assert.equal(argv.includes("--tags"), false);
  // 以 `-` 开头的值按 `--note <值>` 传入会被上游 argparse 当成选项而报错
  // （已用上游 argparse 定义实测：`-要点` / `-abc` / 值本身是 `--note` 都会被拒），
  // 因此改用 `--note=<值>` 形式 —— 仍是同一个 argv 里的同一个选项名。
  assert.equal(argv.includes("--note"), false);
  assert.ok(argv.includes("--note=-要点正文"));
  assert.ok(argv.includes("--title=-要点标题"));
});

test("runUploadNote rejects arguments the upstream hard limits would refuse", async () => {
  const { workDir, config } = await sauFixture();
  const runner = new SauRunner({ ...config, sauBinary: await stubSau(workDir, { stdout: "ok" }) });

  await assert.rejects(
    runner.runUploadNote({ imagePaths: [], title: "标题", note: "", tags: [] }),
    (error: unknown) => error instanceof SauRunnerError,
  );
  await assert.rejects(
    runner.runUploadNote({
      imagePaths: Array.from({ length: MAX_IMAGES + 1 }, (_, index) => `/tmp/${index}.png`),
      title: "标题",
      note: "",
      tags: [],
    }),
    (error: unknown) => error instanceof SauRunnerError,
  );
  await assert.rejects(
    runner.runUploadNote({ imagePaths: ["/tmp/a.png"], title: "标".repeat(MAX_TITLE + 1), note: "", tags: [] }),
    (error: unknown) => error instanceof SauRunnerError,
  );
  await assert.rejects(
    runner.runUploadNote({
      imagePaths: ["/tmp/a.png"],
      title: "标题",
      note: "正".repeat(MAX_NOTE + 1),
      tags: [],
    }),
    (error: unknown) => error instanceof SauRunnerError,
  );
});

test("keeps one cookie per name when sau returns the same name for several domains", async () => {
  const header = storageStateToCookieHeader({
    cookies: [
      stateCookie("sessionid", "from-iesdouyin", ".iesdouyin.com"),
      stateCookie("sessionid", "from-douyin", ".douyin.com"),
      stateCookie("ttwid", "only-one", ".douyin.com"),
    ],
    origins: [],
  });

  // Cookie 头没有域概念，同名保留一条（优先 douyin.com 域），避免带上歧义值。
  assert.equal(header, "sessionid=from-douyin; ttwid=only-one");
});

test("uses the shared cookie path and the documented account file layout by default", async () => {
  const runner = new SauRunner({ sauBaseDir: "/sau" });

  assert.equal(runner.cookieFilePath, getCookiePath());
  assert.equal(runner.accountName, "mine");
  assert.equal(runner.accountFilePath, path.join("/sau", "cookies", "douyin_mine.json"));
  assert.equal(runner.verifyCodeFilePath, path.join("/sau", "verify_code.txt"));
});

test("passes generous timeouts and captures both streams for the real command runner", async () => {
  const { workDir, config } = await sauFixture();
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const runner = new SauRunner({
    ...config,
    sauBinary: "/sau/bin/sau",
    commandRunner: {
      run: async (command, args, options) => {
        calls.push({ command, args, options: options ?? {} });
        return { stdout: "valid", stderr: "" };
      },
    },
  });

  await runner.checkLogin();
  await runner.runUploadNote({ imagePaths: ["/tmp/a.png"], title: "标题", note: "", tags: [] });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "/sau/bin/sau");
  assert.equal(calls[0].options.captureStdout, true);
  assert.equal(calls[0].options.captureStderr, true);
  // 预检要启动浏览器，上传是分钟级，两个超时都必须给足。
  assert.ok(Number(calls[0].options.timeoutMs) >= 60_000);
  assert.ok(Number(calls[1].options.timeoutMs) >= 300_000);
});

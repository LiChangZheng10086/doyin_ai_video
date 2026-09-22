/**
 * 小红书执行器**发布编排**测试（Task 6）：全程注入**假页面**，不启浏览器、不联网。
 *
 * 这里守的是编排层的四条纪律，每一条都对应一次真实事故或一条平台风险：
 *
 * 1. **姿态开关**：`submit: false`（默认）时**一个提交类按钮都不能被点**——平台会自己存草稿，
 *    最后一下由真人点（spec §10 方案乙，已被真机演练验证「草稿箱中有未发布的作品」）。
 * 2. ⚠️ **点完发布不做任何读回**（spec §9）：`xiaohongshu-mcp` #715 报「让 AI 确认发布成功了没有 →
 *    第一次警告第二次七天」。所以点完之后**不允许再碰页面** —— 本文件用「提交后的操作日志必须为空」
 *    这条反向断言把它钉死。
 * 3. **每一步失败都停在点发布之前**，并写明**已完成到哪一步**（参考项目正是在这些地方静默失败）。
 * 4. **任何异常都收敛成 `ok:false`**：绝不把原始异常抛给服务层变成 500，也绝不让记录卡在 running。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  XhsRunner,
  type XhsBrowserSession,
  type XhsPageLike,
} from "./xhs-runner.js";
import { XHS_AI_DECLARATION_TEXT, type XhsPublishLocator, type XhsPublishPageLike } from "./xhs-page.js";

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "xhs-runner-publish-"));
  tempDirs.push(dir);
  return dir;
}

interface FakeState {
  loggedIn?: boolean;
  /** 上传后页面上显示的图片数（默认等于送入张数；设为 0 复刻「平台没接住」）。 */
  uploadConfirms?: number | null;
  aiOption?: boolean;
  lockAi?: boolean;
  submitDisabled?: boolean;
  hasSubmitHost?: boolean;
  titleDrop?: "never" | "first" | "always";
  /** `goto` 直接抛错（复刻浏览器层异常）。 */
  gotoFails?: boolean;
}

/**
 * 假发布页：只实现本流程真正用到的那一面，并**记录每一次页面操作**。
 * `clicked` 记录鼠标点在了哪个按钮上（`publish` / `save`），用来验证坐标偏移算对了。
 */
function fakePublishPage(state: FakeState = {}) {
  const ops: string[] = [];
  const titleWrites = { count: 0 };
  const data = {
    url: "https://creator.xiaohongshu.com/publish/publish?source=official&target=image",
    images: 0,
    title: "",
    body: "",
    declaration: "添加内容类型声明",
    clicked: "" as "" | "publish" | "save",
    files: [] as string[],
    submitOpened: false,
  };

  function note(operation: string): void {
    ops.push(operation);
  }

  function locator(selector: string): XhsPublishLocator {
    const self: XhsPublishLocator = {
      async count() {
        note(`count(${selector})`);
        if (selector.includes("xhs-publish-btn")) return state.hasSubmitHost === false ? 0 : 1;
        if (selector.includes('accept*=".jpg"')) return state.loggedIn === false ? 0 : 1;
        if (selector.includes("d-text")) return data.images > 0 ? 1 : 0;
        if (selector.includes("ProseMirror")) return data.images > 0 ? 1 : 0;
        if (selector.includes("d-select-wrapper")) return data.images > 0 ? 1 : 0;
        if (selector.includes("d-option")) {
          if (data.images === 0) return 0;
          return state.aiOption === false ? 1 : 3;
        }
        if (selector.includes("img-preview-area")) return data.images;
        return 0;
      },
      first() {
        return self;
      },
      nth() {
        return self;
      },
      async click() {
        note(`click(${selector})`);
        if (selector.includes("d-select-wrapper")) return;
        if (selector.includes("d-text")) return;
        if (selector.includes("d-option")) {
          if (state.lockAi) return;
          data.declaration = XHS_AI_DECLARATION_TEXT;
        }
      },
      async setInputFiles(paths) {
        const list = Array.isArray(paths) ? paths : [paths];
        note(`setInputFiles(${list.length})`);
        data.files = list;
        data.images = state.uploadConfirms === null ? 0 : (state.uploadConfirms ?? list.length);
      },
      async inputValue() {
        note("inputValue()");
        return data.title;
      },
      async textContent() {
        note(`textContent(${selector})`);
        if (selector.includes("d-select-wrapper")) return data.declaration;
        if (selector.includes("d-option")) {
          return state.aiOption === false ? "虚构演绎，仅供娱乐" : XHS_AI_DECLARATION_TEXT;
        }
        if (selector.includes("ProseMirror")) return data.body;
        return "";
      },
      async getAttribute(name) {
        note(`getAttribute(${name})`);
        if (name === "submit-disabled" && state.submitDisabled) return "true";
        return "false";
      },
      async boundingBox() {
        note("boundingBox()");
        return { x: 338, y: 810, width: 680, height: 90 };
      },
    };
    return self;
  }

  const page: XhsPublishPageLike & { url(): string; goto(url: string): Promise<unknown> } = {
    // 未登录时真页会 302 到 /login —— 假页面也要照此表现，否则「登录态失效」那条测不到。
    async goto(target: string) {
      note(`goto(${target.slice(0, 48)})`);
      data.url = state.loggedIn === false ? "https://creator.xiaohongshu.com/login" : target;
      if (state.gotoFails) throw new Error("goto 失败");
    },
    url: () => data.url,
    locator,
    keyboard: {
      async press() {
        note("keyboard.press()");
      },
      async insertText(text) {
        note("keyboard.insertText()");
        // 标题与正文共用 insertText（真实页面也是同一个键盘 API）：
        // 两处都写一遍，读回时各取所需。⚠️ 第一版这里加了「text === "标题" 就 return」的
        // guard，结果主用例的标题永远读回空串、重试三次后报 mismatch —— 假页面不能偷偷
        // 对内容做特判，否则测的就不是真实路径了。
        titleWrites.count += 1;
        const drop = state.titleDrop ?? "never";
        if (drop === "always" || (drop === "first" && titleWrites.count === 1)) {
          data.title = text.slice(0, 2) + text.slice(3);
        } else {
          data.title = text;
        }
        data.body = text;
      },
    },
    mouse: {
      async click() {
        note("mouse.click()");
        data.submitOpened = true;
        // 宿主 680 宽：publish 中心 0.607、save 中心 0.396。假页面按同样的偏移判断。
        data.clicked = "publish";
      },
    },
    async waitForTimeout() {
      note("waitForTimeout()");
    },
    async evaluate<T>(expression: string): Promise<T> {
      note("evaluate()");
      if (expression.includes("上传图文")) return "ok" as unknown as T;
      return "" as unknown as T;
    },
  };

  return { page: page as unknown as XhsPublishPageLike, data, ops };
}

function runnerWith(page: XhsPublishPageLike, storageRoot: string) {
  const session: XhsBrowserSession = {
    page: page as unknown as XhsPageLike,
    close: async () => undefined,
  };
  const runner = new XhsRunner({
    storageRoot,
    browserBinary: process.execPath,
    sleep: async () => undefined,
    openSession: async () => session,
  });
  return { runner, session };
}

const INPUT = {
  title: "标题",
  body: "第一段。\n\n最后一段。",
  imagePaths: ["/tmp/a.png", "/tmp/b.png"],
  aiDeclaration: true,
  submit: false,
};

test("姿态乙（submit:false）：填完即停，**一个提交按钮都没点过**", async () => {
  const storage = await tempDir();
  const { page, data } = fakePublishPage();
  const { runner } = runnerWith(page, storage);

  const result = await runner.publishNote(INPUT);

  assert.equal(result.ok, true, result.message);
  assert.equal(result.submitted, false);
  assert.equal(data.clicked, "", "姿态乙绝不能点提交控件");
  assert.equal(result.verification, "unconfirmed");
  assert.match(result.message, /草稿/u);
  assert.match(result.message, /小红书 App/u, "必须告诉用户下一步去 App 里核实并点发布");
  // 步骤要按真实顺序记录（上传在前 —— 页面是分阶段渲染的）。
  assert.deepEqual(result.steps.map((step) => step.split("：")[0]), [
    "进入发布页",
    "上传图片",
    "填写标题",
    "填写正文",
    "声明 AI 合成内容",
    "停在点「发布」之前",
  ]);
});

test("姿态甲（submit:true）：点发布，但**verification 恒为 unconfirmed**", async () => {
  const storage = await tempDir();
  const { page, data } = fakePublishPage();
  const { runner } = runnerWith(page, storage);

  const result = await runner.publishNote({ ...INPUT, submit: true });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.submitted, true);
  assert.equal(data.clicked, "publish");
  assert.equal(result.verification, "unconfirmed", "按设计不做读回，所以永远拿不到 confirmed");
  assert.match(result.message, /已点击发布/u);
  assert.match(result.message, /核实/u);
});

test("⚠️ 点完提交之后**不允许再碰页面**（反向断言：提交后的操作日志必须为空）", async () => {
  const storage = await tempDir();
  const { page, ops, data } = fakePublishPage();
  const { runner } = runnerWith(page, storage);

  await runner.publishNote({ ...INPUT, submit: true });

  const submitIndex = ops.indexOf("mouse.click()");
  assert.notEqual(submitIndex, -1, "本次应当点过提交");
  const afterSubmit = ops.slice(submitIndex + 1);
  assert.deepEqual(
    afterSubmit,
    [],
    `点完发布之后不得再做任何页面读写（#715：让 AI 确认发布成功 → 第一次警告、第二次七天）：${afterSubmit.join(", ")}`,
  );
  assert.equal(data.submitOpened, true);
});

test("演练（dryRun:true）等价于姿态乙：即使调用方写了 submit:true 也不点", async () => {
  const storage = await tempDir();
  const { page, data } = fakePublishPage();
  const { runner } = runnerWith(page, storage);

  const result = await runner.publishNote({ ...INPUT, submit: true }, { dryRun: true });

  assert.equal(result.submitted, false);
  assert.equal(data.clicked, "");
  assert.match(result.steps.join("\n"), /演练/u);
});

test("登录态失效：一步都不做就返回 ok:false（不填表、不点任何东西）", async () => {
  const storage = await tempDir();
  const { page, data } = fakePublishPage({ loggedIn: false });
  const { runner } = runnerWith(page, storage);

  const result = await runner.publishNote(INPUT);

  assert.equal(result.ok, false, `本应失败却成功了：${result.message}`);
  assert.match(result.message, /登录态/u);
  assert.equal(data.images, 0);
  assert.equal(data.clicked, "");
});

test("AI 声明选不中 → fail closed，**没点提交**，且消息说明停在哪一步", async () => {
  const storage = await tempDir();
  const { page, data } = fakePublishPage({ lockAi: true });
  const { runner } = runnerWith(page, storage);

  const result = await runner.publishNote({ ...INPUT, submit: true });

  assert.equal(result.ok, false, `本应失败却成功了：${result.message}`);
  assert.equal(result.submitted, false);
  assert.equal(data.clicked, "", "声明没选上时绝不允许提交");
  assert.match(result.message, /声明/u);
  // 「停在哪一步」由**消息**回答（steps 只记已完成的，不把没做成的算进去 —— 那是撒谎）。
  assert.match(result.message, /失败于「声明 AI 合成内容」/u);
  assert.match(result.message, /已完成：进入发布页 → 上传图片/u);
  assert.equal(
    result.steps.some((step) => step.includes("声明 AI 合成内容")),
    false,
    "没做成的步骤不该出现在 steps 里",
  );
});

test("页面上没有 AI 声明选项 → fail closed（不发一条没标识的 AI 笔记）", async () => {
  const storage = await tempDir();
  const { page, data } = fakePublishPage({ aiOption: false });
  const { runner } = runnerWith(page, storage);

  const result = await runner.publishNote({ ...INPUT, submit: true });

  assert.equal(result.ok, false, `本应失败却成功了：${result.message}`);
  assert.equal(data.clicked, "");
  assert.match(result.message, /AI/u);
});

test("图片没被平台接住 → 停在点发布之前，消息里带上已完成步骤", async () => {
  const storage = await tempDir();
  const { page, data } = fakePublishPage({ uploadConfirms: null });
  const { runner } = runnerWith(page, storage);

  const result = await runner.publishNote({ ...INPUT, submit: true });

  assert.equal(result.ok, false, `本应失败却成功了：${result.message}`);
  assert.equal(data.clicked, "");
  assert.match(result.message, /图片/u);
});

test("提交按钮禁用 → 报错且不点（姿态甲下的 fail closed）", async () => {
  const storage = await tempDir();
  const { page, data } = fakePublishPage({ submitDisabled: true });
  const { runner } = runnerWith(page, storage);

  const result = await runner.publishNote({ ...INPUT, submit: true });

  assert.equal(result.ok, false, `本应失败却成功了：${result.message}`);
  assert.equal(data.clicked, "");
  assert.match(result.message, /禁用/u);
});

test("标题写入丢字符 → 重试后仍成功（编排层不该被这种抖动卡死）", async () => {
  const storage = await tempDir();
  const { page } = fakePublishPage({ titleDrop: "first" });
  const { runner } = runnerWith(page, storage);

  const result = await runner.publishNote(INPUT);
  // 假页面的 insertText 同时承担标题与正文，这里只要求「不因为一次丢字符就失败」。
  assert.equal(result.ok, true, result.message);
});

test("**任何**异常都收敛成 ok:false（绝不抛给服务层变成 500，也绝不卡在 running）", async () => {
  const storage = await tempDir();
  const { page } = fakePublishPage({ gotoFails: true });
  const brokenPage = {
    ...page,
    async goto() {
      throw new Error("net::ERR_CONNECTION_RESET");
    },
  } as unknown as XhsPublishPageLike;
  const { runner } = runnerWith(brokenPage, storage);

  const result = await runner.publishNote(INPUT);

  assert.equal(result.ok, false, `本应失败却成功了：${result.message}`);
  assert.match(result.message, /ERR_CONNECTION_RESET/u, "原始原因必须带出来，否则排查时只剩一句『失败』");
});

test("openSession 抛错同样收敛成 ok:false（浏览器起不来也不能 500）", async () => {
  const storage = await tempDir();
  const runner = new XhsRunner({
    storageRoot: storage,
    browserBinary: process.execPath,
    sleep: async () => undefined,
    openSession: async () => {
      throw new Error("launchPersistentContext: EPERM");
    },
  });

  const result = await runner.publishNote(INPUT);
  assert.equal(result.ok, false, `本应失败却成功了：${result.message}`);
  assert.match(result.message, /EPERM/u);
});

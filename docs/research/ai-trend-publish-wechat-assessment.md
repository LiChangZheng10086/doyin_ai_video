# ai-trend-publish 微信公众号发布能力移植评估

> 调研对象：https://github.com/liyown/ai-trend-publish
> 调研方式：GitHub API 元数据 + `git clone --depth 1` 全仓源码 + ripgrep 全仓检索 + 微信官方文档核对
> 调研日期：2026-09-18
> 证据分级：**【事实】**= 直接读到的源码/接口返回/官方文档原文；**【推断】**= 基于事实的分析判断

---

## 0. 一句话结论

该项目把「微信发布」这件事做成了 **4 个官方 HTTP 端点 + 一个 355 行的类**，没有任何浏览器自动化。
移植到本地 Node.js 后端的核心工作量约 **500~600 行**，属于 **中（几百行）**；
真正的风险不在编码，而在**公众号账号权限、IP 白名单、access_token 互斥**这三个账号侧门槛。

---

## 1. 项目定位 / 技术栈 / 规模

### 1.1 它是做什么的

**【事实】** 一个面向微信公众号的自动化选题与发布流水线。README 原文：

> "TrendPublish 是一个面向微信公众号的自动化选题与发布系统。它从你指定的数据源中抓取内容，用 AI 做选题、证据补全、排序、标题、正文生成、审稿、排版和配图，最后生成可预览的 dry-run 产物或创建微信公众号草稿。"
> —— `README.md`

**【事实】** 项目自述"当前聚焦一条主链路：**微信文章自动发布**"。

### 1.2 技术栈

| 项目 | 值 | 证据 |
| --- | --- | --- |
| 语言 | TypeScript | GitHub Languages API：TypeScript 1,735,410 bytes |
| **运行时** | **Deno v2.0.0+（不是 Node.js）** | `deno.json` 存在；**无 `package.json`**；README「需要 Deno v2.0.0 或更高版本」 |
| 后端框架 | Deno 原生 `Deno.serve()`（无 Express/Fastify） | `src/apps/weixin-relay/server.ts:23` |
| CLI | `@cliffy/command`（JSR） | `deno.json` imports |
| 模板引擎 | EJS 3.1.10 | `article.renderer.ts:6` `import ejs from "npm:ejs@3.1.10"` |
| 本地存储 | SQLite（`jsr:@db/sqlite@^0.12.0`）+ JSON 文件 | `src/app/weixin-article/local-runtime-stores.ts` |
| 定时任务 | `npm:node-cron@3.0.3` | `src/controllers/cron.ts:1` |
| 云部署 | Cloudflare Worker + Workflows + D1/KV/R2 | `src/platform/cloudflare/worker.ts` |

**【事实·易踩坑】** 仓库的 GitHub description 写着 "Node.js | TypeScript"，但这是**过时/不准确**的描述。
实际没有任何 `package.json`，依赖全部走 `jsr:` / `npm:` / `https://deno.land/x/` 前缀。

依赖清单（`deno.json` imports 原文）：

```json
"@db/sqlite": "jsr:@db/sqlite@^0.12.0",
"@sapling/markdown": "jsr:@sapling/markdown@^0.3.0",
"@cliffy/command": "jsr:@cliffy/command@1.1.0",
"jsonrepair": "npm:jsonrepair@3",
"@src/": "./src/"
```

### 1.3 仓库规模

**【事实】**（GitHub Trees API `recursive=1`，`truncated: false`）

| 指标 | 数值 |
| --- | --- |
| tree 条目 / 其中文件 | 451 / **357** |
| TS 代码行（排除 `.test.ts`） | **38,878** |
| TS 测试行 | 8,103 |
| 全部 `.ts`+`.tsx`+`.ejs`+`.sql` 行数 | 55,948 |
| `.ts` 文件数 | 290 |

主要目录：

```text
src/
  app/weixin-article/          # 应用组装层（24 文件）
  features/weixin-article/     # 业务编排与服务（67 文件）
  integrations/                # 外部服务 adapter（50 文件）
  modules/                     # 排序/摘要/Markdown 等（45 文件）
  core/                        # workflow runtime、ports（34 文件）
  platform/cloudflare/ + local/ # 16 文件
  utils/config/                # 配置定义（18 文件）
dashboard/src/                 # Vite 前端（18 文件）
```

**【事实】** `src/features/weixin-article/workflow.ts` 单文件 41,995 bytes；
`src/app/weixin-article/runtime/runtime-config-api.ts` 33,093 bytes —— 业务逻辑相当集中。

### 1.4 维护状态

**【事实】** 3186 stars / 442 forks；创建于 2025-01-13。
默认分支 `main` 最后提交 **2026-06-14**（`5366f02`）。
GitHub commit_activity 端点显示 2026-06-28 起连续 12 周提交数为 0。
（`pushed_at` 为 2026-08-04，推测来自其他 ref/tag。）

**【推断】** 项目处于**沉寂状态**（约 3 个月无主分支提交）。优点是行为稳定、不会边看边变；
缺点是遇到微信 API 变更时上游不会帮你修，必须自己维护。

---

## 2. 核心流程链路

**【事实】** 从 `src/features/weixin-article/workflow.ts` 抽取的 step 名及其行号顺序：

| 序 | step 名 | 行号 | 职责 |
| --- | --- | --- | --- |
| 1 | `fetch-sources` | 155 | 抓取数据源（URL/RSS/搜索/社交） |
| 2 | `scrape-contents` | 174 | 正文抽取与清洗 |
| 3 | `dedup-contents` | 215 | 去重（可选向量去重） |
| 4 | `plan-editorial-topics` | 239 | 选题聚类与排序 |
| 5 | `process-contents` | 375 | 内容加工 |
| 6 | `research-evidence` | 408 | 证据补全（二次搜索） |
| 7 | `align-plan-contents` | 438 | 计划与内容对齐 |
| 8 | `plan-article` | 464 | 生成文章计划 |
| 9 | `draft-article-content` | 521 | AI 起草正文 |
| 10 | `render-article-template` | 610 | 渲染微信兼容 HTML |
| 11 | `review-article-quality` | 638 | 质量审稿 |
| 12 | （修订） | — | 至多一次定向修订 |
| 13 | `publish-article` | 836 | **封面生成 → 上传素材 → 创建草稿** |
| 14 | （qualityGate） | — | 质量守门 |

发布分支的源码（`workflow.ts:1030-1040`）：

```ts
private async publishArticle(
  renderedTemplate: string, summaryTitle: string, mediaId: string,
): Promise<PublishResult> {
  logger.info("[发布] 发布到微信公众号");
  return await this.dependencies.publisher.publishArticle({
    content: renderedTemplate,
    title: summaryTitle,
    digest: summaryTitle,
    coverMediaId: mediaId,
  });
}
```

**【事实·小瑕疵】** `digest` 直接复用 `summaryTitle`（标题当摘要），没有单独生成摘要。
微信文档规定 digest 不限长则自动抓正文前 54 字，这里传了标题，属于可改进点。

---

## 3. 微信公众号发布如何实现（核心）

### 3.1 官方 API，零浏览器自动化

**【事实】** 全仓检索 `playwright|puppeteer|selenium|chromium|patchright` → **无任何匹配**。
（对比：你们现有的抖音图文发布走的是外部 `social-auto-upload` + patchright 浏览器自动化，两者完全不同。）

**【事实】** 全仓检索 `cgi-bin` 只命中以下端点：

| 端点 | 用途 | 源码位置 |
| --- | --- | --- |
| `/cgi-bin/token` | 获取 access_token | `weixin-api-client.ts:39` |
| `/cgi-bin/draft/add` | **新增草稿** | `weixin-publisher.ts:136` |
| `/cgi-bin/material/add_material` (type=image) | 上传永久图片素材 → `thumb_media_id` | `weixin-publisher.ts:184` |
| `/cgi-bin/media/uploadimg` | 上传正文图 → 返回微信托管 URL | `weixin-publisher.ts:252` |

Base URL：`https://api.weixin.qq.com`（`weixin-api-client.ts:30`）。

### 3.2 ⚠️ 它只创建草稿，不发布

**【事实】** 全仓检索 `freepublish|message/mass|masssend|publishall|/cgi-bin/publish` → **无任何匹配**。

**【事实】** `weixin-publisher.ts:272-294` 的 `publishArticle()` 只调用 `draft/add`，返回：

```ts
return {
  publishId: draft.media_id,
  status: "draft",                     // ← 不是 "published"
  publishedAt: new Date(),
  platform: "weixin",
  accountId: account.accountId,
  url: `https://mp.weixin.qq.com/s/${draft.media_id}`,   // 注意：见下方瑕疵
};
```

**【事实·瑕疵】** 上面拼的 `https://mp.weixin.qq.com/s/{media_id}` **不是有效文章链接** ——
`media_id` 是草稿 ID，不是发布后的 `article_id`/URL。这是装饰性字段，不要依赖。

**【推断】** 这个设计（生成草稿后人工在公众号后台点发布）实际上**更安全**，也更适合桌面工具：
避免了"AI 直接群发"的运营风险和 `freepublish` 的各种限制。**建议我们照抄这个边界。**

### 3.3 需要哪些凭据

**【事实】** 仅两项：`appId` + `appSecret`（`providers.publish.weixin`）。
access_token 由代码自行换取，**不需要用户手填**。

**【事实·IP 白名单】** 项目自己承认这是硬门槛：
- `README.md:359`："正式发布前需要在公众号后台配置 IP 白名单。"
- `deployment.md:19-24`："服务器/Docker 有固定公网 IP：可以直连微信；Cloudflare 没有固定出口 IP：建议部署 `weixin-relay` 到固定 IP 机器。"

**【事实·官方文档】** 现行文档（`developers.weixin.qq.com/doc/service/guide/dev/api/`）原文：

> "IP 白名单：即白名单内的 IP 才可以调用获取接口调用凭据接口 或 获取稳定版接口调用凭据接口，否则会提示 **61004** 错误"

**【事实·代码与文档不一致】** 项目的 `validateIpWhitelist()` 只匹配错误码 `40164`：

```ts
// weixin-publisher.ts:301-311
async validateIpWhitelist(): Promise<string | boolean> {
  try { await this.ensureAccessToken(); return true; }
  catch (error) {
    if (error instanceof Error && error.message.includes("40164")) {
      return error.message.match(/invalid ip ([^ ]+)/)?.[1] ?? "未知IP";
    }
    throw error;
  }
}
```

同时 `classifyWeixinError()` 把 `[40001, 40013, 40125, 40164, 48001]` 归为 `auth`，**未包含 61004**。

**【推断】** 该 IP 校验逻辑可能**误报**：微信换用 61004 后，白名单错误会被当作网络/未知错误抛出，
而不是被识别为 IP 问题。**我们移植时必须同时处理 40164 与 61004。**

### 3.4 access_token 管理（重要）

**【事实】** 内存缓存 + 提前 1 分钟过期（`weixin-publisher.ts:77-112`）：

```ts
if (this.accessToken && this.accessToken.expiresAt > new Date(Date.now() + 60000)) {
  return this.accessToken.access_token;
}
// 否则重新 /cgi-bin/token 换取，expiresAt = now + expires_in*1000
```

**【事实】** 用的是老的 `/cgi-bin/token`，**没有使用**官方推荐的稳定版 `/cgi-bin/stable_token`。

**【事实·官方约束】** `developers.weixin.qq.com/doc/service/guide/dev/api/` 原文：

> "access_token 的有效期目前为2个小时，需定时刷新，**重复获取将导致上次获取的 access_token 失效**。建议服务号开发者使用中控服务器统一获取和刷新 access_token"

**【推断·对本项目最关键的风险】** 缓存只在**进程内存**里。桌面应用每次重启都会重新取 token，
本身无害；但如果用户同时用别的工具（或我们日后加第二个入口）用同一公众号取 token，
**双方会互相把对方的 token 顶掉**，表现为随机 40001 invalid credential。
→ **我们必须把 token 持久化（落盘/共用），或直接改用 `/cgi-bin/stable_token`。**

### 3.5 封面图与 thumb_media_id

**【事实】** `material/add_material?type=image` 上传，上限 **10MB**（`weixin-publisher.ts:52`）：

```ts
private static readonly COVER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
```

**【事实】** 表单字段名 `media`，用 `Blob` + `FormData`（Node 18+ 原生支持）：

```ts
const formData = new FormData();
formData.append("media",
  new Blob([toArrayBuffer(image.bytes)], { type: image.contentType }),
  createImageFilename(image.contentType));
const response = await this.apiClient.postForm<WeixinMaterialImageResponse>(
  "/cgi-bin/material/add_material", token, formData, { type: "image" });
return response.media_id;
```

**【事实·官方要求】** `draft/add` 文档：`thumb_media_id` 在 `article_type=news` 时**必填**，
"必须是**永久** MediaID"。

**【事实·🔴 必须自己处理的坑】** `article-cover.service.ts:19-20` 硬编码了作者自己账号的封面：

```ts
export const DEFAULT_COVER_MEDIA_ID =
  "SwCSRjrdGJNaWioRQUHzgF68BHFkSlb_f5xlTquvsOSA6Yy0ZRjFo0aW9eS3JJu_";
```

并且封面生成失败时会**静默回退**到这个 media_id（`generateCover()` catch 分支）。

**【推断】** 这个 media_id 属于**别人的公众号**。我们照抄后，一旦封面生成失败，
`draft/add` 会因 media_id 不属于本账号而失败（微信侧会报无权限/无效 media_id）。
→ **必须去掉这个兜底常量，改成"封面失败就让用户手动选图 / 直接报错"。**

### 3.6 正文图片

**【事实】** 两级策略，`WeixinImageProcessor`（`src/utils/image/image-processor.ts`）：

1. 用正则从 HTML/Markdown/裸 URL 中提取所有图片地址（`extractImageUrls`）
2. 逐张下载（走带 SSRF 防护的 `SafeImageDownloader`）
3. **若 > 1MB 则压缩**（`MAX_IMAGE_SIZE = 1024 * 1024`）
4. 通过 `media/uploadimg` 上传，拿回微信托管 URL
5. 把正文里的原 URL 替换成微信 URL

**【事实·官方要求】** `draft/add` 文档原文：

> "涉及图片url**必须来源"上传图文消息内的图片获取URL"接口获取。外部图片url将被过滤。"
> "必须少于2万字符，小于1M"

**【推断】** 微信会**过滤外链图片**，所以第 4-5 步不是可选优化而是**必需**步骤，
否则草稿正文里的图全部裂图。这一步必须移植。

**【事实】** 正文图上限 1MB（`weixin-publisher.ts:53` `CONTENT_IMAGE_MAX_BYTES`）；
压缩用的是 **Deno 专属远程导入**：

```ts
// image-processor.ts:51-53
const { decode } = await import(
  "https://deno.land/x/imagescript@1.2.17/mod.ts"
);
```

**【推断】** Node 下无法这样 import，需替换为 `sharp` / `jimp` / `@napi-rs/image`（或用 `ffmpeg`，
你们项目已有）。压缩策略是按原始体积选 quality+scale（>5MB→q30/0.5x 等）。

### 3.7 正文 HTML 格式

**【事实】** 纯 **EJS 模板** → HTML，**全部内联样式，零 `<style>` 块**：

```bash
$ grep -rn "<style" src/features/weixin-article/rendering/templates/
(无匹配 —— 8 个模板全部内联)
```

模板片段（`article.minimal.ejs`）：

```ejs
<section style="margin:0 auto;max-width:100%;padding:22px 18px;font-family:-apple-system,
  BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#222222;
  background:#ffffff;line-height:1.9;">
```

**【事实】** 段落约定：以自定义标签 `<next_paragraph />` 分隔，模板里 `content.split("<next_paragraph />")`。
`<ul>/<ol>/<li>` 会被 `renderContentBlock()` 重写成 `<section>/<p>` + 内联样式（微信编辑器不认 list）。

**【事实·好消息】** 模板在 `template-registry.ts` 里是**机械内联的普通 JS 字符串字面量**：

```ts
// 由 scripts/preview.weixin.ts 使用的 EJS 模板机械内联生成。
export const WEIXIN_TEMPLATE_REGISTRY: Record<string, string> = {
  "default": '<%\nfunction renderContentBlock(html) {...',
  "minimal": '...',
};
```

**【推断】** 这是**纯数据**，可 100% 原样复制到 Node；只需把
`import ejs from "npm:ejs@3.1.10"` 换成 `import ejs from "ejs"`。模板是我们的"免费午餐"。

### 3.8 支持哪些账号类型

**【事实】** 项目文档**完全没有讨论**订阅号/服务号/认证状态的区别。
全仓检索 `订阅号|服务号|认证|权限` 在 docs 中只命中无关内容（Axiom 权限、多租户权限）。

**【事实·官方文档】** 微信官方把草稿箱接口同时挂在**服务号**和**订阅号**文档下：
- 服务号：`/doc/service/api/draftbox/draftmanage/api_draft_add`
- 订阅号：`/doc/subscription/en/api/draftbox/draftmanage/api_draft_add.html`

草稿箱指南页原文："**服务号**可以通过服务端接口，对草稿和商品卡片进行管理"。

**【推断·必须由我们自己承担的风险】** 官方文档同时存在于订阅号目录下，说明**认证订阅号**理论上
也能调用草稿箱接口；但**未认证/个人订阅号没有 AppSecret 和这套服务端 API 权限**。
项目对这一点零防护——它假设使用者已经有合规账号。**我们必须在 UI 上做前置校验与明确文案**，
否则用户会拿到 `48001 api unauthorized` 之类的错误却不知道原因。
**这一点无法靠读本项目源码确认，必须用真实账号实测。**

### 3.9 草稿箱 vs 群发 vs 发布

**【事实】** 该项目**只做草稿箱**（`draft/add`），不碰 `freepublish/submit`、也不碰 `message/mass/*`。

**【事实·官方能力对照】** 微信侧三种能力是分开的接口族：

| 能力 | 接口族 | 本项目是否使用 |
| --- | --- | --- |
| 草稿箱 | `/cgi-bin/draft/*` | ✅ 仅 `draft/add` |
| 发布（不群发，进"发表记录"） | `/cgi-bin/freepublish/submit` | ❌ 未使用 |
| 群发（推送给粉丝，有次数限制） | `/cgi-bin/message/mass/*` | ❌ 未使用 |

**【推断】** "发布"和"群发"是微信里**不同**的两件事：`freepublish` 是发布到账号主页/发表记录，
`mass` 才是推送给全部粉丝且受每月次数限制。本项目选择最保守的草稿箱，规避了这两者的配额与
不可撤回风险。**如果要加"发布"，`freepublish/submit` 只需再写约 20 行**（提交 draft media_id 拿 publish_id）。

---

## 4. AI 生成部分

**【事实】** 抽象为 `LLMProvider` port（`src/core/ports/llm.ts`），实现是
`src/integrations/llm/providers/openai-compatible-llm.ts`。

**【事实·OpenAI 兼容已确认】** 请求地址拼接：

```ts
// openai-compatible-llm.ts:119
`${this.baseURL}/chat/completions`
```

**【事实】** 支持 `response_format: { type: "json_object" }`、`temperature`、`max_tokens`、
`timeoutMs`、`maxAttempts`（见 `ChatCompletionOptions`）。

**【事实】** README 列出的 provider：OpenAI、DeepSeek（`https://api.deepseek.com/v1`）、
通义千问/DashScope（`https://dashscope.aliyuncs.com/compatible-mode/v1`）。

**【推断】** **可100%替换为任意 OpenAI 兼容接口**，与你们现有 `src/lib/ai-cleaner.ts`
的 `openai` SDK + `baseURL` 用法一致，无需任何适配层。需要自己的 API key（用户自备）。

配图方面：封面用阿里云 DashScope（默认 `qwen-image-2.0-pro`）或 MiniMax（`image-01`）；
正文配图用 `qwen-image-2.0`。**这两家的 key 与微信发布无关，可完全不用**（我们可直接复用
你们素材库/场景静帧作为封面与配图，反而更简单）。

---

## 5. 部署形态与本地化必须重写的部分

### 5.1 三种部署形态

**【事实】**（`docs/deployment.md:11-24`）

1. **本地开发** —— 完整能力，SQLite + 文件
2. **Docker 服务器** —— 推荐，功能完整，产物挂载到 `/app/src/temp`
3. **Cloudflare Workflows** —— Worker + Workflows + D1/KV/R2

**【事实·关键】** 本地/Docker 形态**不强依赖 Cloudflare**。README：
"部署方式灵活：本地/Docker 保持完整能力；Cloudflare 使用 Worker/Workflows/D1/KV/R2 原生运行"。

**【事实·微信真实发布的固定 IP 中转】** 项目为此单独写了 `weixin-relay`
（`src/apps/weixin-relay/server.ts`，270 行），设计是**无状态凭证透传**：

> "relay 只保存自己的 `server.apiKey`，不保存公众号 AppID/AppSecret……relay 只负责固定 IP 转发微信 API。" —— README:496

relay 的 4 个端点：`/api/weixin/validate-ip`、`/upload-image`、`/upload-content-image`、`/publish`，
`POST` body 形如 `{ account: {appId, appSecret, ...}, payload: {...} }`，Bearer 鉴权 + 时序安全比较。

### 5.2 必须重写的部分（Deno → Node）

**【事实】** 需要改动的 Deno 专属构造：

| Deno 构造 | 出现位置 | Node 替代 |
| --- | --- | --- |
| `import ejs from "npm:ejs@3.1.10"` | `article.renderer.ts:6`, `base.renderer.ts:1` | `import ejs from "ejs"` |
| `import { Database } from "@db/sqlite"` | 3 个 sqlite store | `better-sqlite3` / `node:sqlite` |
| `https://deno.land/x/imagescript@1.2.17/mod.ts` | `image-processor.ts:52` | `sharp` / `jimp` / ffmpeg |
| `Deno.cwd()` | `local-runtime-stores.ts:16` | `process.cwd()` |
| `Deno.env.get()` / `Deno.args` | `weixin-relay/server.ts:15,18` | `process.env` / `process.argv` |
| `Deno.resolveDns()` | `safe-image-downloader.ts:197-200` | `node:dns/promises` |
| `Deno.serve()` | `weixin-relay/server.ts:23` | Express（你们已有） |
| `@src/` import map | 全仓 | tsconfig `paths` 或相对路径 |
| `Deno.test()` | 全部 `*.test.ts` | 你们现有 `npm test`（tsx + node:test）之间需重写 |

**【事实】** `image-processor.ts`、`safe-image-downloader.ts` 的**算法与逻辑本身完全可复用**，
只是外部调用要换。

**【推断】** 好消息是：**微信发布这条路径本身不依赖 SQLite、不依赖 Cloudflare、不依赖 cron**。
`local-runtime-stores.ts` 里的 SQLite 只服务"运行时配置中心"和"编辑记忆"，
`cron.ts` 只服务定时调度 —— 这两块**都可以整体丢掉**。

---

## 6. 许可证

**【事实】**

- GitHub API `license`: `{ key: "mit", name: "MIT License", spdx_id: "MIT" }`
- `LICENSE` 文件首行：`Copyright 2025 Yaowen Liu`
- README 末尾："本项目使用 MIT License，详见 LICENSE"

**【事实·MIT 条款原文要点】** 允许 "use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software"，**唯一条件**是保留版权声明与许可声明：

> "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software."

**【事实】** 无附加限制条款（无 Commons Clause、无 Non-Commercial、无 copyleft）。

**【推断·法律层面结论】**
- ✅ 可以借鉴、移植、改写、闭源分发（你们的桌面应用若闭源也不受影响）
- ✅ 可以商用
- ⚠️ **义务**：在"所有副本或实质性部分"中保留 `Copyright 2025 Yaowen Liu` + MIT 声明文本。
  最稳妥做法：在 Electron 的"关于/开源许可"页面加一段第三方声明，并在移植的文件头保留出处注释。
- ⚠️ 附带免责："THE SOFTWARE IS PROVIDED 'AS IS'" —— 作者不担责，出问题自己扛。

---

## 7. 明显"不适合移植"的部分

| 部分 | 是否强绑定 | 证据 | 处置建议 |
| --- | --- | --- | --- |
| Cloudflare Worker/Workflows/D1/KV/R2 | 强绑定（但**仅** `src/platform/cloudflare/`） | `src/platform/cloudflare/worker.ts` | **丢弃**，本地不需要 |
| `weixin-relay` 固定 IP 中转 | 仅为解决 Cloudflare 无固定 IP | `apps/weixin-relay/server.ts` | **按需**：桌面端动态 IP 问题同样存在，见第 9 节 |
| 本地 SQLite（运行时配置中心） | 仅服务 Dashboard 改配置 | `sqlite-runtime-config-store.ts` | **丢弃**，改用你们 `config.json` |
| SQLite 编辑记忆 / 向量去重 | `@db/sqlite` + DashScope embedding | `sqlite-vector-store.ts` | **丢弃**，与发布无关 |
| 定时任务 | `npm:node-cron` | `src/controllers/cron.ts:30` | **丢弃**，桌面端手动触发更合适 |
| Dashboard 前端（18 文件 + Vite） | 独立产品面 | `dashboard/src/` | **丢弃**，你们已有 React 前端 |
| 抓取provider（Firecrawl/Jina/Brave/Tavily/Exa/Serper/NewsAPI/GDELT/HN/arXiv/Twitter） | 各自需 API key | `src/integrations/fetch/` | **丢弃**，你们内容来自抖音采集 |
| 通知（Bark/钉钉/飞书） | 可选 | `src/app/weixin-article/notifications.ts` | 丢弃 |
| 多公众号矩阵 / relay 透传 | 复杂化 | `matrix-run-summary.ts`（12KB） | 丢弃（除非要做矩阵） |
| `DEFAULT_COVER_MEDIA_ID` 硬编码 | 🔴 **危险** | `article-cover.service.ts:19` | **必须删掉**，见 3.5 |
| 无 IP 白名单错误码 61004 处理 | 🟡 缺陷 | `weixin-publisher.ts:306` | **必须补上**，见 3.3 |

**【结论】** "不适合移植"的部分**恰好都是与微信 API 无关的周边**（云平台、存储、调度、抓取、UI）。
微信发布内核本身高度内聚、无外部平台耦合。

---

## 8. 优点 / 缺点总结

### 值得借鉴 ✅

1. **端口/适配器分层干净**。`ContentPublisher` / `ContentImageUploader` 只有 39 行接口
   （`src/core/ports/content-publisher.ts`），`weixin` 与 `weixin-relay` 是同一接口的两个实现，
   **可无痛替换**。这个抽象值得照抄。
2. **纯 fetch 实现**。`WeixinApiClient` 只用 `fetch`/`URL`/`FormData`/`Blob`/`AbortController`，
   全部是 Node 18+ 原生 API，**零 SDK 依赖**。
3. **错误分类 + 敏感信息脱敏**。`classifyWeixinError()` 把错误码映射为
   `auth`/`rate_limit`/`quota`/`timeout`/`network`/`invalid_response`；
   `redactSensitiveText()` 会把 URL 里的 `access_token` 抹掉再进日志（`weixin-api-client.ts:104-126`）。
   **这个安全细节很值得学** —— token 泄进日志是常见事故。
4. **超时预算明确**。封面生成 150s / 封面上传 45s / API 默认 30s（`article-cover.service.ts:17-18`），
   且封面失败**降级不阻塞**发布流程。
5. **模板库是纯数据**，8 套内联样式模板（minimal/longform/product/darktech/tech/modern/mianpro/default），
   可原样搬走。
6. **`SafeImageDownloader` 的 SSRF 防护**：拒绝 localhost/私有网段、限制重定向次数、
   边读边校验 maxBytes、白名单 content-type（`safe-image-downloader.ts`，304 行，含测试）。
   我们下载远程图片时应该用同样的防护。
7. **dry-run 优先**。`features.article.dryRun` 默认 true，产物落 `src/temp/`，可先审 HTML 再发。
   这是很成熟的"人在环"设计。

### 需要我们自己重写 ⚠️

1. **Deno → Node**：import 前缀、`Deno.*` 全局、`@db/sqlite`、`Deno.serve`、`Deno.test`。
2. **图片压缩**：`deno.land/x/imagescript` 换 `sharp`/`jimp`/ffmpeg。
3. **access_token 持久化**：改为落盘 + 跨进程共享，或改用 `/cgi-bin/stable_token`。
4. **封面来源**：删掉硬编码 media_id，接入你们自己的封面来源
   （现有 `publishing-*` 资产/场景静帧就是现成素材）。
5. **IP 白名单错误码**：补 61004，并给出可操作的中文提示。
6. **账号权限前置校验**：调一个最便宜的接口（如 `draft/count`）做"连通性+权限"自检。
7. **HTML 清洗**：如果正文来自你们自己的 AI 清洗结果而非该项目的 EJS 模板，
   需要确保输出是内联样式 + 图片已替换为微信 URL + `<2万字符/<1M`。

---

## 9. 结论：工作量估算

### 估算结论：**中（几百行）**

**核心（草稿链路）约 500~600 行**，若含正文图片管线约 **1,000~1,200 行**。
不达"大（上千行且需重写）"，因为微信内核高度内聚；也不是"小（几十行）"，
因为图片管线、token 管理、错误处理、HTML 合规都是必须自己写的实质工作。

### 工作量拆解

| 模块 | 行数估计 | 难度 | 依据 |
| --- | --- | --- | --- |
| `WeixinApiClient`（fetch 封装 + 错误分类 + 脱敏） | ~160 | 低 | 可近乎原样移植，`weixin-api-client.ts` 163 行 |
| `WeixinPublisher`（token 缓存 / 3 个上传端点） | ~350 | 低 | `weixin-publisher.ts` 355 行 |
| token 持久化 + 单例锁 | ~60 | 中 | 新增，官方要求中控 |
| 封面获取（复用你们素材/静帧） | ~80 | 低 | 替换 `article-cover.service.ts` 175 行 |
| 正文图片下载 + 压缩 + 替换 | ~300 | 中 | 移植 `safe-image-downloader.ts`(304) + `image-processor.ts`(283)，压缩库换 `sharp` |
| 微信内联样式 HTML 模板 | ~50 | 低 | 直接搬 `article.minimal.ejs`(48) |
| Express 路由 + 前端按钮 | ~100 | 低 | 接进你们 `publishing-*` |
| 账号自检 / 错误文案 | ~80 | 中 | 新增 |
| **合计** | **~1,180** | | |

若**只做纯文字 + 复用已有封面、不做正文配图**，可压到 **~500 行**。

### 主要风险点（按严重度排序）

#### 🔴 风险 1：IP 白名单 —— 桌面应用的根本矛盾
**【事实】** 微信要求调用 IP 在白名单内（否则 61004）。
**【推断】** Electron 桌面应用跑在用户家庭宽带，**公网 IP 会变**（重播/重启光猫即变）。
后果：用户今天能用、明天突然全部报错，且不知道原因。
**这是"桌面应用"与"微信公众号服务端 API"之间最本质的冲突**，也正是该项目写 relay 的原因。

应对选项（需产品决策）：
- **A. 用户自建固定 IP 中转**（照搬 `weixin-relay`，270 行 + 一台 VPS）→ 能力完整但门槛高
- **B. 引导用户手动维护白名单** → 免费但每次换 IP 都要去后台改，体验差
- **C. 明确降级**：只生成 HTML 交付包，用户自己复制进公众号编辑器 → 零门槛但失去自动化意义
**【推断】** 建议 A 作为"高级模式"、C 作为默认，B 作为文档说明。

#### 🔴 风险 2：账号权限门槛（无法靠读源码确认）
**【事实】** 项目文档对此**零说明**。
**【推断】** 草稿箱 API 属于"认证"账号能力；个人/未认证订阅号很可能没有 AppSecret 与接口权限。
**必须在有真实合规账号的前提下先做一次端到端实测**，否则可能写完才发现目标账号根本调不通。
这是**立项前最该验证的一件事**，成本极低（几十行脚本 + 一个 `draft/count` 调用）。

#### 🟠 风险 3：access_token 互斥
**【事实】** 官方："重复获取将导致上次获取的 access_token 失效"。
**【推断】** 桌面端 + 用户其他工具（或未来第二个模块）会互相顶掉 token，表现为随机 40001。
**必须持久化 token 并加进程/文件锁，或直接用 `/cgi-bin/stable_token`。**

#### 🟠 风险 4：封面 media_id 归属
**【事实】** 项目硬编码了他人账号的 `DEFAULT_COVER_MEDIA_ID` 作为兜底。
**【推断】** 直接照抄会在封面失败时把整个 `draft/add` 带崩。
**必须删掉，改为显式失败或让用户选图。**

#### 🟡 风险 5：正文图片必须走 `media/uploadimg`
**【事实】** 官方："外部图片url将被过滤"。**【推断】** 忘了这步 → 草稿正文全部裂图。
且正文图有 **1MB** 上限，需要可靠的压缩（这是唯一需要引入原生图像库的地方，
`sharp` 会增加 Electron 打包体积与跨平台构建复杂度）。

#### 🟡 风险 6：草稿箱 vs 群发的语义差
**【事实】** 本项目只建草稿。**【推断】** 若产品预期是"自动发文给粉丝"，
草稿箱**不满足**，需要再加 `freepublish/submit`（发布，约 20 行）或
`message/mass/*`（群发，有次数限制、不可撤回、运营风险高）。
**建议明确产品边界为"生成草稿 + 人工确认发布"**，与该项目保持一致。

#### 🟢 风险 7：许可证
**【事实】** MIT，无附加限制。**【推断】** 唯一义务是保留版权声明 —— 成本近乎为零。

---

## 附：一手证据索引

| 事实 | 来源 |
| --- | --- |
| 4 个微信端点、零 freepublish、零浏览器自动化 | `git clone` 后 ripgrep 全仓 + `weixin-publisher.ts` |
| 只建草稿 | `src/integrations/publish/providers/weixin-publisher.ts:272-294` |
| 硬编码封面 media_id | `src/features/weixin-article/services/article-cover.service.ts:19-20` |
| IP 白名单只匹配 40164 | `weixin-publisher.ts:301-311` |
| 官方 IP 白名单错误码为 61004 | https://developers.weixin.qq.com/doc/service/guide/dev/api/ |
| `draft/add` 参数、thumb_media_id 必填、外链图被过滤、<2万字符/<1M | https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_add |
| 草稿箱能力归属服务号 | https://developers.weixin.qq.com/doc/service/guide/product/draft.html |
| rel 固定 IP 中转设计 | `src/apps/weixin-relay/server.ts`、README:483-496 |
| MIT 许可 | GitHub API `license.spdx_id` + `LICENSE` 文件 |
| 模板全内联样式 | `grep -rn "<style" src/features/weixin-article/rendering/templates/` 无匹配 |
| 模板为纯数据 | `src/features/weixin-article/rendering/template-registry.ts` |
| OpenAI 兼容 | `src/integrations/llm/providers/openai-compatible-llm.ts:119` |

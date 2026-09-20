# 抖创工坊 微信公众号 AI 文章发布 设计规格

**状态：** DRAFT（待用户评审）
**日期：** 2026-09-18
**产品：** 抖创工坊
**范围：** 把已完成的任务产物（转录 + AI 洗稿）生成一篇公众号文章，渲染成微信兼容 HTML，提交到**微信公众号草稿箱**，最终发布仍由人工在公众号后台完成
**实施边界：** 只新增 `wechat_mp` 一条平台通路与一套文章渲染；不动视频/图文发布、不动 `PublishTaskStatus`、不内置外部依赖、不引入浏览器自动化

---

## 1. 背景与结论

发布中心目前有两个目标：视频/图文的**人工交付**（打开平台上传页，人来做）和**抖音图文自动发布**（外部 `sau` CLI 驱动浏览器）。本次要接入第三个目标：**微信公众号**。

参考项目 [liyown/ai-trend-publish](https://github.com/liyown/ai-trend-publish)（TrendPublish，MIT，3186 star）的实测结论决定了本次的做法。

### 1.1 参考项目实测（2026-09-18，clone 全仓逐文件核对，非读 README）

| 维度 | 实测结果 |
| --- | --- |
| 技术栈 | **Deno v2**（有 `deno.json`、**无 `package.json`**），本地 sqlite / Docker / Cloudflare 三套运行时 |
| 规模 | 357 个文件；`*.ts` + `*.tsx` 合计 **55,139 行**（实测 `find … \| xargs wc -l`） |
| 许可证 | **MIT**（`LICENSE`：Copyright 2025 Yaowen Liu）—— 可借鉴，唯一义务是保留版权声明 |
| 浏览器自动化 | **完全没有**。全仓 grep `playwright\|puppeteer\|selenium\|chromium\|patchright` → 无匹配 |
| 微信端点数 | 全仓只有 **4 个**：`/cgi-bin/token`、`/cgi-bin/draft/add`、`/cgi-bin/material/add_material?type=image`、`/cgi-bin/media/uploadimg` |
| **「发布」的真实语义** | **只创建草稿**。`publishArticle()` 返回 `status: "draft"`；全仓 grep `freepublish\|masssend\|message/mass` → 无匹配 |
| 公众号输出侧代码量 | `weixin-publisher.ts`(355 行) + `weixin-api-client.ts`(163 行) = **约 520 行** |

**结论一：它的 5.5 万行里，真正与「公众号」有关的只有 520 行。** 其余全是内容生产流水线（11 个抓取 provider、选题聚类、审稿、AI 配图、Dashboard、向量去重、定时调度）——与本项目「抖音采集 → 洗稿 → 视频/图文」的定位不重合，**本次不搬**。

**结论二：它的「发布」= 建草稿，这正好是本项目既有不变式的形状。** 本项目抖音通路最要紧的一条是「CLI 退出码 0 只记『已提交』，绝不写 `published`」；公众号通路上可以把这条做得更彻底：**我们连「发布」这个动作都不做，只往草稿箱放一份草稿。**

### 1.2 两个必须自己处理的坑（照抄会踩）

1. **硬编码的封面 media_id**：`article-cover.service.ts:19-20` 有 `DEFAULT_COVER_MEDIA_ID = "SwCSRjrdGJNaWioRQUHzgF68BHFkSlb_f5xlTquvsOSA6Yy0ZRjFo0aW9eS3JJu_"`（作者自己账号的），且封面失败时静默回退到它。`media_id` 与账号绑定，照抄必然 `40007 invalid media_id`。**我们必须自己出封面图。**
2. **IP 白名单相关错误码只认了一个**：它只认 `40164`（`weixin-publisher.ts:306`），`classifyWeixinError` 的 auth 列表是 `[40001, 40013, 40125, 40164, 48001]`。**微信官方文档在这里自相矛盾**（两处都是官方页面）：
   - [获取接口调用凭据](https://developers.weixin.qq.com/doc/service/api/base/api_getaccesstoken.html) 的错误码表：**`40164` = 调用接口的 IP 地址不在白名单中**
   - [服务端 API 调用说明](https://developers.weixin.qq.com/doc/subscription/guide/dev/api/) 的「IP 白名单」一节：**「否则会提示 `61004` 错误」**

   我们**两个码都必须识别并归为同一类「IP 白名单」**，且给出同一段指引。**只认一个就等于把用户的明确错误报成未知错误。**

### 1.3 微信官方接口的硬约束（已逐条核对官方文档）

| 事实 | 出处 |
| --- | --- |
| `draft/add`：`title` **必填 ≤32 字**、`author` ≤16 字、`digest` ≤120 字（不填则默认抓正文前 54 字）；`content` **必填，必须 <2 万字符且 <1M**；`thumb_media_id` 对图文消息（news）**必填**，且**必须是永久素材 MediaID** | [新增草稿](https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_add.html) |
| `content` 原文：**「涉及图片 url 必须来源『上传图文消息内的图片获取 URL』接口获取。外部图片 url 将被过滤。」** | 同上 |
| 永久素材图片 ≤10MB，支持 bmp/png/jpeg/jpg/gif；返回 `media_id` + `url` | [上传永久素材](https://developers.weixin.qq.com/doc/service/api/material/permanent/api_addmaterial.html) |
| `uploadimg` 正文图：**仅支持 jpg/png，大小必须 <1MB**，不占用素材库 10 万张限额 | 同上（注意事项第 5 条） |
| `access_token` 有效期 7200s；**40164 = 调用接口的 IP 地址不在白名单**；40001/40013/40125 = 凭据错 | [获取接口调用凭据](https://developers.weixin.qq.com/doc/service/api/base/api_getaccesstoken.html) |
| **稳定版凭据契约（已核实）**：`POST /cgi-bin/stable_token`，JSON body `{grant_type:"client_credential", appid, secret, force_refresh?:false}`；普通模式下**有效期内重复调用不会更新 token**，且**平台会提前 5 分钟更新** —— 因此**返回的 `expires_in` 可能远小于 7200（如 345），缓存必须用返回的 `expires_in`，绝不能硬编码 7200**；该接口与 `/cgi-bin/token` 的凭据**互相隔离**；强制刷新每天限 20 次且需间隔 30 秒（**我们不用**） | [获取稳定版接口调用凭据](https://developers.weixin.qq.com/doc/service/api/base/api_getstableaccesstoken.html) |
| 官方**推荐**用稳定版凭据 `/cgi-bin/stable_token`（避免「重复获取导致上次 token 失效」的互斥问题） | 同上 |
| **IP 白名单是「换取凭据」这一步的门槛**，且**存在第二道闸（三个码）**：`89503` = **此次调用需要管理员确认，请耐心等候**；`89506` = 该 IP 已被管理员**拒绝**，请 **24 小时**后再试；`89507` = 被拒绝，请 **1 小时**后再试 | [获取稳定版接口调用凭据](https://developers.weixin.qq.com/doc/service/api/base/api_getstableaccesstoken.html) 的错误码表；机制说明见[服务端 API 调用说明](https://developers.weixin.qq.com/doc/subscription/guide/dev/api/) |
| 配额要区分**日限**与**分钟限**：`45009` = **reach max api daily quota limit**（日额度用完，可调 `clear_quota` 恢复）；`45011` = **api minute-quota reach limit**（调用太频繁，稍后重试）。两者文案与用户动作完全不同 | 同上 |
| 另有 `41002`（缺 appid）、`41004`（缺 secret）、`43002`（需 POST）、`40002`（grant_type 非法）—— 归为配置/凭据类，给可执行文案 | 同上 |
| AppSecret 可被**冻结**（此时换取 token 返回 **`40243`**，解冻需 10 分钟生效）—— 报错文案要能区分「secret 写错了」与「secret 被冻结了」 | 同上 |
| AppSecret 与 **API IP 白名单**现在在**微信开发者平台**维护：「微信开发者平台 - 扫码登录 - 我的业务 - 公众号 - 开发密钥」（历史上的路径是公众平台后台 → 设置与开发 → 基本配置） | 同上 |
| 刷新凭据时有 5 分钟**新老 token 并存**窗口（平台保证），因此提前刷新是安全的 | 同上 |
| **发布能力接口（`freepublish/*`）自 2025 年 7 月起，对「个人主体账号、企业主体未认证账号及不支持认证的账号」回收权限** | [发布能力](https://developers.weixin.qq.com/doc/subscription/guide/product/publish.html) |
| **草稿箱那一页没有这句回收说明**，且配额表把「草稿箱 - 新建草稿 1000/日」与「发布能力 - 发布接口 100/日」**分开列**（access_token 2000/日） | [草稿箱](https://developers.weixin.qq.com/doc/subscription/guide/product/draft.html)、[接口调用额度说明](https://developers.weixin.qq.com/doc/subscription/guide/dev/api/limit.html) |
| 封面裁剪比例：图文消息（news）仅支持 `2.35_1` 与 `1_1` | [新增草稿](https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_add.html) |

### 1.4 本功能最大的未知数（必须在 Task 1 用真实账号消灭）

用户账号是**个人订阅号（未认证）**。已知：

- 官方文档只在**发布能力**页写了权限回收，**草稿箱页没有**，且配额表把两者分开 —— 据此**推断**草稿箱仍可用；
- 现行官方文档**没有**按「未认证/认证」细分草稿箱接口的适用范围（只说「公众号 ✔ 服务号 ✔」）；
- 网上流传的《微信公众号接口权限说明》对照表**是 2016 年的旧表**（当时草稿箱接口还不存在），其「素材管理：未认证订阅号无」的结论**不能用于判断 2025 年后的草稿箱权限**；
- 有 2026 年的第三方实践文章标题即为「个人订阅号零成本方案」并涉及 40164 白名单配置，**指向**个人订阅号可建草稿，但这是二手证据。

**因此本设计的 Task 1 就是一个「账号自检探针」**：用真实 AppID/AppSecret 打一次 `draft/count`（最便宜、**零副作用**的草稿箱接口），把「凭据是否有效 / IP 是否在白名单 / 草稿箱权限是否可用」三件事一次性问清楚。**这一步决定 §15 降级通路是否成为主通路。**

---

## 2. 已确认设计决策

| 决策 | 结果 |
| --- | --- |
| 接入方式 | **官方 API 直连**（`api.weixin.qq.com`），**不做浏览器自动化** |
| 产品边界 | **只建草稿**。`freepublish/submit`（真发布/群发）**不做** —— 官方已对个人主体回收该权限，且我们不做不可逆动作 |
| 平台建模 | `PublishPlatform` 新增 `wechat_mp`，复用既有交付包/任务/审计/预览/垃圾桶 |
| 包内容类型 | `PackageContentType` 新增 `"article"`（第三种），`imagePaths`/`coverPath` 复用，新增 `articleCopy` + 包内 `article.html` |
| 文章内容来源 | 复用**已完成任务**的转录 + AI 洗稿产物，**新增一步 AI 成文**（不是把口播稿当正文） |
| 稿件生成方式 | 复用既有 AI 配置（`resolveAiConfig` + OpenAI 兼容客户端，与 `publishing-copy.ts` 同一模式） |
| 排版 | 我们自己写**内联样式 HTML** 渲染器（纯字符串模板），**不搬 EJS、不加依赖** |
| 图片处理 | **用项目已有的 ffmpeg** 缩放/压缩/裁剪，**不引入 sharp/jimp** |
| 凭据存放 | AppID/AppSecret 走既有配置体系（Electron `safeStorage` 加密 / 独立后端 env），与 AI Key 同模式 |
| access_token | **用官方推荐的 `/cgi-bin/stable_token`**（避免互斥失效），失败再回退 `/cgi-bin/token` |
| 任务状态机 | **一个状态都不加**，复用任务上的 `autoPublish` 子记录 |
| 发布前预览 | 沿用服务端硬约束 `previewRevision`（缺失 400 / 不一致 409，不产生记录） |
| 失败重试 | 不自动重试（草稿可逆，人工点击即可，风险远低于抖音） |
| **降级通路** | **必须做**：无论 API 可用与否，都产出可下载/可复制的 `article.html`（见 §15） |

---

## 3. 内容来源与成文链路

输入是**任务已有的产物**（`GET /api/jobs/:id/cleaned`）：`title`、`summary`、`keyPoints[]`、`cleanScript`、`videoOutline[]`、`voiceoverScript`、`qualityNotes[]`、`tags[]`，以及结构化转录 `segments`。

新增 `src/lib/wechat-article.ts`：

```
1. 取材   readSourceContext(jobId)                     ← 复用 publishing-service 已有的取数口径
2. 成文   planWechatArticle(context)  → 结构化 JSON    ← 一次 AI 调用；失败给本地兜底（不阻塞）
3. 校验   validateArticleDraft(draft)                  ← title ≤32 / digest ≤120 / 正文字符 <20000
4. 渲染   renderWechatArticleHtml(draft, images)       ← 纯函数，内联样式，可单测
5. 落盘   包内 article.html + articleCopy
```

**成文输出形状**（AI 返回结构化 JSON，与 `publishing-copy.ts` 的 `completeJson` 同一套解析与兜底）：

```ts
interface WechatArticleDraft {
  title: string;                                    // ≤32 字
  digest?: string;                                  // ≤120 字；缺省由正文前 54 字生成
  author?: string;                                  // ≤16 字；缺省用配置里的默认作者
  sections: Array<{ heading?: string; paragraphs: string[] }>;
  tags?: string[];
}
```

**关键决定：**

- **AI 成文失败不阻塞**（与 `publishing-copy.ts` 的 `publish_copy_ai_fallback` 同一口径）：兜底为「`title` + `keyPoints` 逐条成段」的朴素文章，界面标注「AI 成文失败，已使用兜底结构，可手动改文案」。**绝不静默产出一份看起来正常、实际是原始口播稿的东西。**
- **`digest` 可以缺省**：官方原文「如果本字段没有填写，则默认抓取正文前 54 个字」，所以不填是合法状态，不伪造。
- 文章标题独立于任务标题。任务标题是抖音口径，这里 ≤32 字，超限时**截断并在界面标注「已压缩，可编辑」**（沿用图文包对 `noteCopy` 的既有做法）。

---

## 4. 排版：微信兼容 HTML

公众号 `content` 的清洗规则决定了排版形态：**只认内联样式**，`<style>` 块、`class`/`id` 会失效，外链图片会被过滤。

`renderWechatArticleHtml` 是**纯函数**（无 IO、无网络、可单测），职责：

| 步骤 | 规则 |
| --- | --- |
| 去外壳 | 去掉 `<!doctype>`、`<html>/<head>/<body>`、注释 |
| 去禁用块 | 去 `<style>`、`<script>`、`<svg>` |
| 标签白名单 | 只保留 `p / section / strong / em / blockquote / ul / ol / li / img / h1-h3 / hr`，其余标签降级为 `section`/`p` |
| 去属性 | 去 `class`/`id`/`data-*`/`on*`，`div → section` |
| 列表改写 | `ul/ol/li` → `section`/`p` + 内联样式（沿用微信编辑器的既有做法） |
| 图片 | 统一注入 `max-width:100%;display:block;margin:22px auto;height:auto;`，`src` 只允许微信返回的 `mmbiz.qpic.cn` URL |
| 换行 | 段落之间用显式块级标签，不依赖 `\n` |
| 长度 | 渲染后**断言 `<20000` 字符**，超限即失败并给出「第 N 段起超限」的可执行提示 |

**不搬 EJS**：TrendPublish 的 8 套模板在它仓库里是内联 JS 字符串字面量（纯数据），但它同时带来 `ejs` 依赖与 Deno 导入前缀。我们只需要**一套**干净模板，直接用字符串模板写，零依赖。若要换风格，改的是同一份纯函数里的常量。

---

## 5. 图片：封面与正文配图

**两种图片、两套接口、两套限额**，必须分开处理：

| | 封面（`thumb_media_id`） | 正文配图 |
| --- | --- | --- |
| 接口 | `POST /cgi-bin/material/add_material?type=image` | `POST /cgi-bin/media/uploadimg` |
| 返回 | `media_id`（永久素材） | `url`（微信托管） |
| 格式/大小 | bmp/png/jpeg/jpg/gif，**≤10MB** | **仅 jpg/png，必须 <1MB** |
| 来源 | 静帧 / 素材库图片 | 静帧 / 素材库图片（有序，与图文包同一套选图模型） |
| 必填 | **必填**，缺失即 `draft/add` 失败 | 可选（0 张也可） |

**处理链（全部用已有的 `ffmpegBinary`，不引入图像库）：**

- 封面：裁剪到 **2.35:1（900×383）** —— 官方规定 news 封面裁剪比例只支持 `2.35_1` 与 `1_1`，而我们的静帧/封面是 9:16，直接传会得到一张被系统乱裁的图。必要时同时产出 1:1（`cover_info.crop_percent_list`）备用。
- 正文图：等比缩放（长边 ≤1080）+ JPEG 质量压缩，**循环降质直到 <1MB**；我们现有静帧约 500KB/张（实测口径见既有 spec §3），但**素材库图片单张允许到 20MB 且支持 webp**，所以这一步不是可选的：
  - `webp → jpg` 必须转换（`uploadimg` 不支持 webp）；
  - `>1MB → ` 必须压缩。
- **源文件只读**：处理产物写到包目录/临时目录，**绝不改动用户的素材库原图或静帧**。
- 上传前对每张图算 sha256，写进包的图片清单哈希（复用图文包既有口径），并断言「上传成功的那张 = 包内那张」。

---

## 6. 凭据、连接自检与 IP 白名单

### 6.1 凭据

```ts
interface WechatMpConfig {
  appId?: string;
  appSecret?: string;
  author?: string;              // 默认作者名，≤16 字
  needOpenComment?: boolean;    // 默认 false
  onlyFansCanComment?: boolean; // 默认 false
}
```

- **独立后端**：env `WECHAT_MP_APP_ID` / `WECHAT_MP_APP_SECRET` / `WECHAT_MP_AUTHOR`（与 `SAU_BINARY` 同一套透传模式，`src/server.ts` 与 `electron/server.ts` **两条入口都要改**）。
- **Electron**：写进 `config.json`，AppSecret 走既有 `safeStorage` 加密路径（与 AI Key 完全同模式；**注意沙箱内读不到 keychain**，见既有 worklog 结论）。
- **日志脱敏**：所有出错信息与审计必须抹掉 `secret`/`access_token`（TrendPublish 的 `redactSensitiveText()` 值得照抄这个点）。

### 6.2 账号自检（Task 1，可行性判据）

新增 `POST /api/publishing/wechat/verify`，**零副作用**（不建草稿、不上传任何素材），逐项返回：

```
POST /cgi-bin/stable_token      → 凭据是否有效：40001 / 40013（AppID 错）/ 40125（secret 错）/ 40243（secret 被冻结，需解冻且 10 分钟生效）/ 41002 / 41004 / 43002
                                → IP 门槛：40164 与 61004（两个官方页面各说一个）→ 归为「IP 白名单」，
                                  把微信回显的 IP 原样展示；89503 → 「待管理员确认」；
                                  89506 → 「已被管理员拒绝，24 小时后再试」；89507 → 「已被拒绝，1 小时后再试」
POST /cgi-bin/draft/count       → 草稿箱权限是否可用：48001（api unauthorized）→ 「该公众号没有草稿箱接口权限」
```

**七个错误码的文案必须彼此可区分**，因为它们对应**七种完全不同的用户动作**（改 AppID / 改 secret / 解冻 secret / 加 IP 白名单 / 等管理员确认 / 等拒绝冷却 / 该账号没权限）。把它们混成一句「微信接口调用失败」，用户就没有任何可执行的动作 —— 本项目在抖音通路上已经吃过一次「失败原因被截断丢掉」的亏（见 worklog 2026-09-17）。

自检结果同时写进界面提示与审计。**这是用户唯一必须手工做的账号侧动作，所以文案必须给出可照抄的 IP 与正确路径**：

```
微信开发者平台（developers.weixin.qq.com/platform）→ 扫码登录 → 我的业务 → 公众号 → 开发密钥 → API IP 白名单
（历史路径：公众平台后台 → 设置与开发 → 基本配置 → IP 白名单）
```

### 6.3 access_token

- **主路径 `/cgi-bin/stable_token`**（`force_refresh: false`）—— 官方推荐，且**不会因为重复获取导致上一次失效**，正好消除「桌面端与用户其它工具互相顶掉 token → 随机 40001」这个风险。
- 回退 `/cgi-bin/token`（7200s）。
- 落盘缓存到 `storage/cache/wechat-mp-token.json`，**提前 5 分钟过期**；刷新走**单飞（single-flight）锁**，避免并发重复获取。

---

## 7. 执行器：`src/lib/wechat-mp-client.ts`

与既有 `sau-runner.ts` 同模式（可注入 `fetchImpl` 以便测试，**测试全程假 HTTP，绝不联网**）：

```ts
interface WechatMpResult<T> {
  ok: boolean;
  data?: T;
  errorCode?: number;      // 微信 errcode
  errorKind?: "auth" | "secret_frozen" | "ip_whitelist" | "risk_pending" | "risk_rejected"
            | "permission" | "rate_limit" | "quota" | "invalid_response" | "network";
  message: string;         // 已脱敏、可直接展示
}

verifyAccount(): Promise<WechatVerifyReport>
uploadCoverImage(bytes, filename): Promise<WechatMpResult<{ mediaId: string }>>
uploadContentImage(bytes, filename): Promise<WechatMpResult<{ url: string }>>
createDraft(article): Promise<WechatMpResult<{ mediaId: string }>>
```

编排放在 `PublishingService`（不放进路由处理器 —— 本项目所有路由都是「校验 + 转调 service」的薄层，与抖音通路同一条架构不变式）：

```
POST /api/publishing/tasks/:id/auto-publish   ← 复用既有路由，不新增
  → 按 task 所属包的 contentType 分派：
      article   → 微信草稿通路（本节）
      note      → 既有 sau 通路（一行不改）
  分派之后才做该通路自己的检查
  → 校验（平台为 wechat_mp / 包为 article）
  → 核对 previewRevision（缺失 400 / 不一致 409，不产生记录）
  → 互斥检查（同一任务运行中 409）
  → 上传封面 → 逐张上传正文图并替换 HTML 内 src
  → 断言最终 HTML <20000 字符、无外链图
  → draft/add
  → 回写 autoPublish（succeeded 的语义 = 草稿已创建）
```

**「先判内容类型、再判配置」是硬要求**：抖音通路的 Task 4 已经被测试抓到过一次这个错序
（对视频包调用时先报「未配置 sau」而不是「这不是图文包」），加进第三种内容类型后这个坑会以
新的形状回来 —— **误报的配置错误会掩盖真正的输入错误**。故必须有专门用例：在**未配置**微信凭据时，
对 note/video 包调用仍应得到该通路原本的错误，而不是「未配置微信公众号」。

---

## 8. 包模型与平台接入

`DeliveryPackage` 新增：

```ts
export type PackageContentType = "video" | "note" | "article";   // 缺省仍为 video

contentType?: PackageContentType;
imagePaths?: string[];        // article 包：有序正文配图（复用 note 包的同一字段与语义）
coverPath?: string;           // article 包：2.35:1 封面（复用既有字段）
articleCopy?: {               // 仅 article 包
  title: string;              // ≤32
  digest?: string;            // ≤120
  author?: string;            // ≤16
  htmlSha256: string;         // article.html 的完整性凭据（沿用包内哈希口径）
};
```

- 包内新增 `article.html`（渲染结果），**包保持自包含**（与视频/封面/图片一致）。
- 存量包零改动：`contentType` 缺省 `video`，既有用例必须**逐字节不变**地继续通过（这是本次重构的回归门禁）。
- `PublishAssetHealth` 语义复用：article 包缺封面 → `missing_cover`；缺正文图不报错（与图文包「缺图也把包建出来」的既有口径一致）。

**`PublishPlatform` 新增 `wechat_mp` 会散落到 10 处清单**。实测（2026-09-18 逐处读过源码）只有 **5 处是静默的**：

| 位置 | 兜底情况 |
| --- | --- |
| `src/types.ts:24` 联合类型 | —— 源头 |
| `renderer/src/types/index.ts:28` 联合类型 | —— 渲染层源头 |
| `src/lib/publishing-platforms.ts:22` `PUBLISH_PLATFORMS: Record<PublishPlatform, …>` | ✅ **编译器兜住**：加进联合类型后漏了键必编译失败 |
| `src/lib/publishing-service.ts:54` `SUPPORTED_PLATFORMS` | ✅ **自动派生**（`Object.keys(PUBLISH_PLATFORMS)`）—— **不许改成字面量**，否则变成第 6 个静默点 |
| `src/lib/publishing-assets.ts:35` `APPROVED_PLATFORMS = new Set([...])` | ❌ **静默** |
| `src/lib/publishing-routes.ts:28` `PLATFORMS = new Set<PublishPlatform>([...])` | ❌ **静默** |
| `src/lib/publishing-service.ts:1286` `NOTE_PLATFORMS = new Set(["douyin"])` | ❌ **静默**（且 article 通路**不得**复用它，它是图文口径的闸门） |
| `src/lib/publishing-store.ts:1225` `isPlatform()` | ❌ **静默** |
| `renderer/src/utils/publishing.ts:22` 渲染层平台表 | ❌ **静默** |
| `src/lib/publishing-copy.ts:35` 错误文案里的平台名列表 | ⚠️ 仅文案（含「仅支持抖音、小红书、微信视频号和哔哩哔哩」），功能无影响但会说不全 |

**这 5 个静默点必须有专门的用例守住**（断言 `wechat_mp` 在每一份清单里都在，且既有 4 个平台一个都没少）——否则表现是「界面能看到平台、后端静默拒绝」，与「改了没生效」属于同一类事故。

`PUBLISH_PLATFORMS.wechat_mp`：

```ts
wechat_mp: {
  label: "微信公众号",
  titleMax: 32,          // 文章标题
  descriptionMax: 120,   // = digest 摘要
  hashtagMax: 10,        // 仅用于人工交付文案；draft/add 没有话题字段，不提交
  hashtagLengthMax: 20,
  creatorUrl: "https://mp.weixin.qq.com/",
}
```

**接口级硬限额**（封面 10MB / 正文图 1MB / author 16 / content 20000 字符）单独定义成 `WECHAT_ARTICLE_LIMITS` 常量，由服务端与预览接口下发，**渲染层只渲染不复刻数字**（与图文包 `copyLimits` 同一口径，避免两处漂移）。

---

## 9. 状态表达与不变式

**不新增 `PublishTaskStatus`。** 复用 `PublishTask.autoPublish` 子记录：

```ts
autoPublish: {
  status: "running" | "succeeded" | "failed";   // article 通路不使用 awaiting_code
  startedAt: string;
  finishedAt?: string;
  message?: string;       // 已脱敏的接口输出摘要；成功时含草稿 media_id
  attemptId: string;
}
```

**四条不变式（要有用例守住）：**

1. **`task.status` 全程不变**，`autoPublish` 的任何取值都只写子记录，任务仍停在 `ready`，直到人工点现有「标记已发布」。这是与抖音通路同一条最关键的不变式。
2. **`succeeded` 的语义是「草稿已创建」，不是「已发布」**。公众号通路上我们**根本不调用发布接口**，所以这条比抖音更强。
3. **失败不自动重试**，必须人工再次点击。
4. **同一任务同时只允许一个 `autoPublish` 在跑**（运行中重复触发 409），并沿用既有的 **30 分钟僵死阈值**（进程被杀不会永久锁死任务）。

**与抖音通路的差异（有意为之）**：草稿创建是**可逆**动作（草稿可删、可重复创建，不会误发给粉丝），所以 `awaiting_code` 不在本通路使用，且不需要抖音那套「重复发布是本功能最大的坑」的兜底强度。**发布前必经预览仍然保留**，但它的目的从「防误发」变成「防内容漂移」（预览看到的 ≠ 写进草稿的）。

---

## 10. 界面与入口

复用既有发布中心，新增三种动作：

| 入口 | 行为 |
| --- | --- |
| 作品详情页成果画布「创建公众号文章包」 | 与既有「创建图文包」并列的独立向导（组件独立，与视频/图文向导互不干扰） |
| 发布中心任务行「预览」 | 复用 `PublishPreviewDialog`，article 包渲染**文章正文 HTML 预览 + 标题/摘要字数** + 封面 |
| 发布中心任务行「提交到公众号草稿箱」 | 先弹预览（**必经**）→ 确认后带 `previewRevision` 提交 |
| 发布中心任务行「下载文章 HTML」（**降级通路**，见 §15） | 任何时候可用，零凭据依赖 |
| 设置页「微信公众号」 | AppID / AppSecret / 默认作者 + **「校验连接」按钮**（调 §6.2 自检，逐项显示结果） |

动作可见性做成**返回原因**而不是纯布尔（`getWechatPublishBlocker`），界面必须说明禁用**为什么** —— 本项目在侧栏折叠上吃过一次「入口零变化导致用户找不到」的亏。

「校验连接」的失败文案必须可执行（**每个码一条不同的动作**，见 §6.2）：

```
40164 / 61004 → 「当前公网 IP（<微信回显的 IP>）不在公众号 IP 白名单中。请到 微信开发者平台 →
                 我的业务 → 公众号 → 开发密钥 → API IP 白名单 添加它，然后重试。
                 （换个网络环境后 IP 会变，需要重新添加。）」
89503         → 「微信要求管理员确认这个 IP 的调用（已给管理员下发模板消息）。
                 请在微信里确认后重试。」
89506 / 89507 → 「管理员拒绝了这个 IP 的调用，请按微信的提示等待（24 小时 / 1 小时）后重试，
                 或先与管理员沟通确认。」
40243         → 「AppSecret 已被冻结，请到 开发密钥 里解冻（约 10 分钟后生效）。」
40125 / 40013 → 「AppID 或 AppSecret 不正确，请检查是否有多余空格、大小写是否正确。」
48001         → 「该公众号没有草稿箱接口权限（通常需要微信认证）。
                 你仍可使用「下载文章 HTML」把文章粘贴到公众号编辑器。」
```

最后一条是**降级通路的入口**：权限不足时，界面不能只给一个错误就结束（§15）。

---

## 11. 明确不做

- **`freepublish/submit` 真发布 / 群发**（官方已对个人主体回收权限，且我们不做不可逆动作）
- 定时到点自动建草稿
- 多公众号矩阵（`accounts` 表）
- AI 配图生成（DashScope/MiniMax 那一套）—— 直接用现成的场景静帧与素材库图片
- **TrendPublish 的主体：多源抓取 → 选题聚类 → 质量审稿 → 编辑记忆**（5.5 万行，与产品定位不重合）
- 浏览器自动化（Playwright/patchright）走公众号后台
- 固定 IP 中转（`weixin-relay`）—— 桌面端本机就是出口 IP，不需要中转
- 在预览弹窗里直接编辑文章正文（编辑仍走既有任务行，避免第二套编辑状态）
- **新增任何 npm 依赖**（不引 ejs、不引 sharp/jimp）

---

## 12. 测试与验证

| 类别 | 内容 |
| --- | --- |
| 成文 | 结构化输出校验：title >32 报错、digest >120 报错；AI 失败走兜底且**标注了 fallback**；digest 缺省是合法状态 |
| 渲染 | 纯函数用例：`<style>/<script>/<svg>` 被去掉、`class/id/data-*/on*` 被去掉、`div→section`、列表改写、图片样式注入、**外链图被拒**、渲染结果 <20000 字符断言、超限给出段号 |
| 图片 | **全程用假 ffmpeg（stub 脚本）与最小 JPEG 字节**：webp 被转 jpg、>1MB 被压到 <1MB、封面被裁成 900×383、源文件未被修改（前后 sha256 一致） |
| 客户端 | **注入假 `fetchImpl`，绝不联网**：40164 与 61004 → `ip_whitelist`；89503 → `risk_confirm`；40243 → `secret_frozen`；48001 → `permission`；40001/40013/40125 → `auth`；45009 → `rate_limit`；非 JSON 响应 → `invalid_response`；**每个码的文案断言互不相同**（防止又混成一句兜底文案）；**token 落盘缓存 + 提前 5 分钟过期 + 单飞锁**；日志/审计里**不出现 AppSecret 与 access_token** |
| 路由 | 复用 `auto-publish` 后**按 `contentType` 分派**：article 包只走微信通路（**断言不触碰 sau**）、note 包只走 sau 通路（**断言不触碰微信客户端**）；**未配置微信凭据时，对 note/video 包仍返回该通路原本的错误**（分派顺序用例）；article 包不带 `previewRevision` → 400 且不产生记录；过期 revision → 409 且不产生记录；未配置凭据 → 明确错误且不写记录；运行中重复触发 → 409 |
| 不变式 | 退出/成功只写 `autoPublish.status = succeeded`，**`task.status` 仍为 `ready`**（最关键的一条断言） |
| 平台枚举 | §8 那 7 个静默点各有一条断言（`wechat_mp` 在清单里，且既有 4 个平台一个没少） |
| 存量兼容 | `contentType` 缺省仍为 `video`；既有 publishing 用例（store/assets/service/routes）**全部保持通过**，其中 `previewRevision` 的精确哈希断言**逐字节不变** |

**验证命令**：`npm run check`（双端）、`npm test`、`npm run build:backend`。
**基线**：`npm test` 全量 509 项 / 507 通过 / 1 跳过 / **1 既有失败**（`src/lib/publishing-service.test.ts` → `startup recovery reports asset phases before due handling and purge`），见 `docs/worklog.md`。
**生效条件**：后端改动需 `npm run build:backend` 并重启；Electron 需 `npm run build:electron` 后整个重启（两套产物互不覆盖，见 `AGENTS.md`）。

---

## 13. 风险

| 风险 | 说明与处理 |
| --- | --- |
| **🔴 账号权限（最大未知数）** | 个人订阅号能否调 `draft/add` **无法从文档确证**（§1.4）。**处理**：Task 1 就是零副作用自检探针（`draft/count`），先问清楚再往下做；权限不可用时走 §15 降级通路，功能仍有价值 |
| **🔴 IP 白名单（两道闸）** | 桌面端跑在用户自己机器上，公网 IP 随网络变化（家里/公司/热点），换网就要去后台改；**且新 IP 首次调用可能触发 `89503` 风险确认，需管理员在微信里点确认**。**处理**：自检把 IP 原样回显 + 给出正确路径（微信开发者平台）；文案明确「换网络后可能需要在后台重新加 IP」「可能出现待管理员确认」；**不做固定 IP 中转**（桌面端本机即出口） |
| **🟠 access_token 互斥** | 官方「重复获取将导致上次获取的失效」，与用户其它工具会互相顶掉 → 随机 40001。**处理**：主用官方推荐的 `/cgi-bin/stable_token`，配合落盘缓存 + 单飞锁 |
| **🟠 正文图被静默过滤** | 外链图片会被微信过滤 → 全裂图，且**草稿看得到裂图但接口不报错**。**处理**：渲染后**断言 HTML 里所有 `img[src]` 都是 `mmbiz.qpic.cn`**，不满足即失败 |
| **🟡 正文超长** | `content` <2 万字符。**处理**：渲染后硬断言并给出段号；成文 prompt 明确字数预算 |
| **🟡 封面比例** | 官方只支持 `2.35_1`/`1_1`，我们的图是 9:16。**处理**：ffmpeg 主动裁成 2.35:1（900×383），不依赖系统随机裁 |
| **🟡 平台枚举静默漏点** | §8 那 7 处 `new Set([...])` 编译器兜不住。**处理**：专门用例守住，并在本 spec 里列明 |
| **🟡 复用参考项目的代码** | MIT，义务是保留版权声明。**处理**：若整段移植，文件头保留出处注释；本项目「关于/开源许可」补第三方声明 |
| **🟢 草稿 ≠ 已发布** | 草稿箱不是「自动发文给粉丝」。**处理**：界面文案明确「已放入草稿箱，请到公众号后台确认并发布」，任务状态仍由人工「标记已发布」推进 |

---

## 14. 影响面

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | `PublishPlatform` 加 `wechat_mp`；`PackageContentType` 加 `article`；`DeliveryPackage` 加 `articleCopy`；`WechatMpConfig`、`WechatVerifyReport` |
| `src/lib/publishing-platforms.ts` | `PUBLISH_PLATFORMS.wechat_mp` + `WECHAT_ARTICLE_LIMITS` |
| `src/lib/wechat-article.ts`（**新增**） | 成文（AI + 兜底）、结构校验、**内联样式 HTML 渲染（纯函数）** |
| `src/lib/wechat-mp-client.ts`（**新增**） | stable_token + 缓存/单飞锁、`material/add_material`、`media/uploadimg`、`draft/add`、`draft/count`、错误分类与脱敏 |
| `src/lib/wechat-media.ts`（**新增**） | 封面裁剪、正文图缩放压缩（**走既有 ffmpeg**，不引图像库） |
| `src/lib/publishing-service.ts` | `verifyWechatAccount()`、`createWechatArticlePackage()`、`autoPublishWechatDraft()` 编排；`SUPPORTED_PLATFORMS` / `NOTE_PLATFORMS` 补点 |
| `src/lib/publishing-assets.ts` | `stageArticleContent`（复用既有 `withStagedPackage` 暂存目录事务）、`APPROVED_PLATFORMS` 补点 |
| `src/lib/publishing-store.ts` | 平台校验补点；`articleCopy` 落库；`autoPublish` 复用既有原子写 |
| `src/lib/publishing-routes.ts` | `POST /api/publishing/wechat/verify`、`GET /api/publishing/packages/:id/article`（**降级通路**）、`PLATFORMS` 补点；**不新增提交路由** —— 复用既有 `POST /api/publishing/tasks/:id/auto-publish`，由 `contentType` 分派（见 §7） |
| `src/app.ts`、`src/server.ts`、`electron/server.ts` | `wechatMp` 配置注入与 env 透传（`WECHAT_MP_*`，**两条入口都要改**） |
| `electron/handlers/config-handler.ts` | AppID/AppSecret 的 `safeStorage` 加解密与设置页读写 |
| `renderer/src/types/index.ts`、`renderer/src/utils/publishing.ts` | 平台类型/平台表补点；`getWechatPublishBlocker` |
| `renderer/src/pages/PublishingPage.tsx` | 「提交到公众号草稿箱」「下载文章 HTML」动作、待确认提示 |
| `renderer/src/pages/SettingsPage.tsx` | 「微信公众号」配置区 + 「校验连接」 |
| `renderer/src/components/CreateWechatArticleDialog.tsx`（**新增**） | 选图（静帧/素材库，复用图文包的选图模型）+ 标题/摘要/作者编辑 |
| `renderer/src/components/PublishPreviewDialog.tsx` | 加 `article` 分支：渲染正文 HTML 预览 + 字数 + 封面 |
| `renderer/src/services/api.ts` | 新增 3 个接口方法 |
| 测试 | 新增成文/渲染/图片/客户端/路由/不变式/平台枚举用例；既有 publishing 用例作为回归门禁 |
| 文档 | `AGENTS.md`、`CLAUDE.md`、`README.md` 同步（架构清单、新接口、`WECHAT_MP_*` 配置、注意事项与故障排查） |

---

## 15. 降级通路：`article.html` 交付包

**这是本设计对「账号权限不可用」的对冲，也是必须做的一条路。**

无论 `draft/add` 是否可用，创建 article 包时都产出包内 `article.html`（渲染后的成品），并提供：

```
GET /api/publishing/packages/:id/article       → 下载/预览 article.html（authenticated）
```

**理由：**

1. 个人订阅号的草稿箱权限**在 Task 1 之前无法确证**（§1.4）。若不可用，整条链路不应变成废码。
2. **渲染层的价值独立于发布层**：用户把 HTML 复制进公众号编辑器，同样省掉了「AI 成文 + 排版」的全部人工。
3. 它让功能在**零凭据**状态下也可用 —— 与项目既有「未配置外部依赖时不静默失败、给出明确指引」的口径一致。

对应地，§10 的「下载文章 HTML」是**与任务状态无关的只读动作**（垃圾桶里不给），而「提交到公众号草稿箱」在自检未通过时给出**指向这条通路的**禁用原因。

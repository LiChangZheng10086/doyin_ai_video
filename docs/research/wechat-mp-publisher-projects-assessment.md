# 微信公众号发布：第三批参考项目评估

> 调研对象：`jiji262/wechat-publisher`、`majiabin2020/wechat-official-account-article-auto-publisher`、
> `16Miku/wechat-auto-publishing`、`chendi126/Weichat_Auto`（用户给的名字 `chendi126/Weichat_AutoAI` **不存在**，见 §3.4）
> 调研方式：逐个 `git clone --depth 1` 到 `/tmp` + `ripgrep`/读全仓源码 + **官方文档逐页核对**
> 调研日期：2026-09-23
> 证据分级：**【事实】**= 直接读到的源码/官方文档原文；**【推断】**= 基于事实的判断
> 关系：`liyown/ai-trend-publish` 已于 2026-09-18 单独评估（见同目录 `ai-trend-publish-wechat-assessment.md`），**本文件不重复**。
> ⚠️ **来源标注**：带 `文件:行号` 的源码级事实来自**只读 clone 逐文件核对**；官方文档与**本仓库自身的代码/文档**结论由我另行独立核对（§6 与 §7）。两者混在一起时以标注为准。

---

## 0. 一句话结论

**四个新项目里只有一个（jiji262）有中等价值，而且只能当「素材库」不能当「代码库」** ——
它贡献的是**纯数据的内联样式主题**与一套**可实跑的反 AI 味评分器**，这两样恰好是我们真缺的；
其余三个（majiabin2020 / 16Miku / chendi126）连一行都别抄，其中**两个真正会调用 `freepublish/submit`**，
与我们「只建草稿、绝不真发布」的锁定决策正面冲突。

**比项目更重要的一条**：五家（含 liyown）**没有任何一家能回答我们唯一的硬未知数** ——
「个人未认证订阅号能否建草稿」。答案仍然只能由真机探针给出（spec Task 1 Step 6，**至今未执行**）。

---

## 1. 总裁决表

| 项目 | 语言/规模 | 边际价值 | 一句话裁决 |
| --- | --- | --- | --- |
| **jiji262/wechat-publisher** | Python 5,699 行（相关 ≈3,075）+ 主题 JSON 870 | **中** | 15 套主题是**纯数据内联样式**（与我们的渲染器同构）、515 行**反 AI 味纯函数评分器**、正文图 md5 去重上传缓存可直接借。⚠️ **无 LICENSE** ⇒ 只能搬数值/规则，**不能逐行抄** |
| majiabin2020/wechat-official-account-article-auto-publisher | Python 1,858 行 | 低 | **真会 `freepublish/submit`**（`--publish` 子命令 + 独立 `publish <media_id>`）。代码无一行值得复制；收获是它促成了官方 `crop_percent_list` 的确认 |
| 16Miku/wechat-auto-publishing | 3,862 行（其中 md 2,968） | 低 | 是**给 Agent 读的提示词包**，不是实现。唯一脚本**无条件** freepublish，且把 `success: true` **硬编码**写盘 ⇒ 假成功。**无 LICENSE** |
| chendi126/Weichat_Auto | Python 4,570 行（**活代码仅 158 行**） | 低 | 路径给错（真名少个 `AI`）。单日导出的脚手架，公众号 node 全是扣子(Coze)死代码。**无 LICENSE** |
| liyown/ai-trend-publish | Deno/TS（全部源文件 55,948 行，其中 TS 38,878） | — | 已于 2026-09-18 评估，**本文件不重复**；结论「4 个官方端点 + 355 行类，Deno 不能直接搬」 |

---

## 2. 跨项目结论（比单个项目更重要）

### 2.1 五家**都不解决我们的真实缺口**

我们的缺口是**发布执行层**：服务编排、HTTP 路由、渲染层 UI（spec Task 6/7）。
四个新项目**无一提供**这一层：

| 项目 | 它的编排形态 | 对我们 |
| --- | --- | --- |
| jiji262 | CLI 单体（`publish.py` 821 行），库函数里 `raise SystemExit(1)` | 进服务层即杀进程，**不可借** |
| majiabin2020 | CLI 子命令（`cli.py` 700 行） | 同上 |
| 16Miku | 一个 441 行 mjs + shell 占位脚本（真命令全被注释） | 无服务层 |
| chendi126 | APScheduler 常驻 + Flask `:5000` | 我们**无服务器**，形态根本不适用 |

**这四家与之前的 liyown 一样，都是「内容工厂」（选题→写稿→配图→发布），不是「发布执行层」。**
⇒ 结论：**继续以我们自己的 `wechat-mp-client.ts` + `wechat-article.ts` 为唯一真源**，不要因为"有参考项目"就换成它们的架构。

### 2.2 唯一的硬未知数，五家**全部答不了**

「个人主体、未认证订阅号能否调 `draft/add`」——这是 spec §1.4 的一号风险：

- jiji262：只有 `SKILL.md:596-599` 的散文（48001 = 需已认证服务号/订阅号），**无代码/测试证据**；
- majiabin2020 / 16Miku / chendi126：**零记载**（grep 认证/服务号/订阅号/48001 无有效命中）；
- 16Miku 弃用 freepublish 的理由**不是权限**而是**运营可见性异常**（`README.md:16`、`publishing.md:70`、
  `docs/dev-log-2026-07-18.md:95`），说明**它的号有该权限**——对我们**不可用**；
- liyown：同样零说明。

⇒ **真机探针仍不可替代**（spec Task 1 Step 6）：

```bash
WECHAT_MP_APP_ID=... WECHAT_MP_APP_SECRET=... npx tsx scripts/verify-wechat-mp.ts
```

### 2.3 许可证：四个里**三个没有 LICENSE** —— 这直接限制了「怎么借」

| 项目 | 许可证 | 后果 |
| --- | --- | --- |
| jiji262 | **无**（GitHub `license: null`） | 不能逐行抄代码（尤其那 515 行 `ai_score.py`），只能**搬数值/词表/规则并自行实现** |
| 16Miku | **无** | 同上 |
| chendi126 | **无**（README 却挂 MIT 徽章） | 同上 |
| majiabin2020 | MIT | 可抄——但它恰恰是**代码最没价值**的那一个 |

⚠️ 讽刺但必须记住：**唯一能合法复制代码的那个项目，是我们最不该复制代码的那个。**

---

## 3. 逐个项目的关键事实与裁决

### 3.1 jiji262/wechat-publisher —— 【事实】263⭐ / 59 fork / 创建 2026-03-28 / 最后 commit `84754be` 2026-08-01 / **无 LICENSE**

- **排版是真内联样式，可直接用**：样式全在 `assets/themes/*.json`（15 个，各 58 行，键 `styles/highlights/section_divider_text/list_style`），
  `json.load` + `styles.update()` 合并（`html_converter.py:131-157`），只输出 `style="…"`（`html_converter.py:513`）。
  实测**无 `<style>`、无 `class=`、无 `id=`**，标签仅 `section/p/h2/h3/strong/span/ul/ol/li/blockquote`
  ⇒ 与我们的 `wechat-article.ts` **同构**。
- 比「素排版」强的 **4 个决定**（这才是它真正的价值）：① **首个 h1 丢弃**（微信标题字段本身就是 h1，`html_converter.py:431-434`）；
  ② **相邻 h2 之间自动插分节符**（`:436-439`）；③ `list_style` 序号体系（中/罗马/圈号，`:166-252`）；
  ④ 7 种行内高亮（`==/++/%%/&&/!!/@@/^^`，`:190-199`）。
- **反 AI 味是真规则集，不是一句 prompt**：`ai_score.py` **515 行纯函数、零第三方依赖**，6 维打分
  （burstiness CV `:149-173` / **31 条套话正则** `:62-95` / 高频词密度 `:201-222` / 教科书枚举 `:225-235` /
  标点单调 `:238-262` / 富文本 style `:270-302`），阈值 45（`:37`）。实跑一段典型 AI 味文本：
  **total 64.2 / verdict FAIL / 命中「赋能/护城河/抓手」/ exit 1**。
  ⚠️ 两个缺口：9 条 checklist 里约一半（人称/事实密度/结构不完美）**无机器检测**；阈值 45 与分档 35/55 **不自洽**。
- **微信 API 层弱于我们**：token 走**旧版** `cgi-bin/token`（`wechat_token.py:25`），**无 `stable_token`、无锁**；
  错误码映射**只在文档里**（`README:142-149`），代码里没有；**标题长度/digest/正文 <20000 全无校验**；
  **封面零处理**（`publish.py:336-345`；「900×383」只是给 agent 的**指令文本**，代码里没有裁剪/压缩）。
- 发布顺序值得记：**先并发（默认 4 线程 `WECHAT_UPLOAD_WORKERS`）传正文图拿 CDN URL → 传封面（永久素材）→ 建草稿**（`image_handler.py:404/435`）。
- 测试：实跑 `pytest tests/` → **45 passed**，但只覆盖 html_converter/ai_score/config，**API 层零测试**。
- 实测代码只调 `draft/add`；`freepublish/submit` **仅出现在文档**（`references/api_reference.md:75`）⇒ 与我们的锁定决策一致。
- ⚠️ **文档提到但仓库内不存在**的东西：`scripts/render-card.ts`、`humanizer/lexicon.json`、外部 CLI `baoyu-image-gen`
  ⇒ 当"已有功能"用会踩空。

### 3.2 majiabin2020/wechat-official-account-article-auto-publisher —— 【事实】3⭐ / MIT / Python 1,858 行 / 2 个 commit（同一天）

- **它真会发布**：`--publish` 直接调 `freepublish/submit`（`cli.py:538-542`、`640-644`），另有独立 `publish <media_id>`
  子命令（`cli.py:649-659`）。脚本形态下**没有人工确认环节**。
- token 无状态：每个命令进程取一次就丢（`cli.py:502/578/619/653`），**无缓存、无单飞、无 errcode 语义映射**（错误一律 dump 原始 dict）。
- 封面「真生成」但**质量不可用**：豆包 ark / 通义 dashscope 生图后用 `Image.open(..).resize((900,383))`（`covers.py:178`）
  —— 尺寸与我们一致（2.35:1），但 PIL `resize` **不保比例**（1536×1024 → 3:2 源，横纵比差 **1.57 倍形变**）且**无裁剪**；
  字体**只有 Windows 路径**（`C:\Windows\Fonts\msyh*`，`covers.py:127-138`）⇒ macOS 上落 `load_default()`，**中文必成豆腐块**。
- ⚠️ **README 宣称的能力在代码里不成立**：全仓**没有任何文本大模型调用**（`openai|chat/completions|gpt|claude` 命中 0）；
  `generate_article_markdown()` 是用 `_tone_phrases` 里**硬编码的中文句子拼装**（`creation.py:52-70`、`104-139`）。
  「一句话需求到草稿」= 模板空话。
- 两个**长度口径写错**（会构造必然失败的请求）：`normalize_wechat_title` 截到 **64 字**（官方 ≤32，`wechat_api.py:24-26`）；
  `author` 按 **16 字节**截断（中文约 5 字，`wechat_api.py:96`）。
- **从不调用 `media/uploadimg`**（全库 0 命中）⇒ 正文外链图会被官方过滤。**这正是我们已做对、它完全没做的一环。**
- 凭据干净（config.json 全是空串），但 ⚠️ **config.json 已提交且未被 .gitignore 忽略** ⇒ 用户填真值即泄露 AppSecret。

### 3.3 16Miku/wechat-auto-publishing —— 【事实】51⭐ / **无 LICENSE** / 3,862 行（其中 md 2,968 = 77%）

- **它是提示词包，不是实现**：唯一可执行微信逻辑是 441 行的 `templates/publish.mjs`；所谓"工作流脚本"全是占位符，
  `run.sh:25-37` **整段是注释**，两个 shell 只会 `echo` 那个「4 模式」字符串。
- ⚠️ **「可选正式发布」在代码里不是可选项**：`publish.mjs:392` 无条件 `await freePublish(...)`，
  全文 `process.env` 只有 `:26-31` 的删代理，**从未读 `PUBLISH_MODE`** ⇒ 直接推翻它自己文档里
  「→ 草稿 → **可选** freepublish」（`references/publishing.md:133`）与「注意默认只应用到草稿」（`SKILL.md:62`）。
  **文档承诺的开关在代码里不存在。**
- ⚠️ **假成功（最严重的反面教材）**：`main()` 把 `success: true` **无条件硬编码**写盘（`:401`），
  即使 freepublish 返回失败（`:342`）或轮询超时 `publish_status: -1`（`:346`）；失败**不抛异常** ⇒ **退出码 0** ⇒ cron 当成功。
  这正是我们拒绝的「机器写 published」，**反过来印证了 `previewRevision` + 人工「标记已发布」这条不变式的必要性**。
- 其他别抄：**静默丢图**（`:255-258` 缺图只警告 `continue`，正文保留 `./image1.jpg` 相对路径就进草稿，仍报成功）；
  **全局删代理** `delete process.env.*_proxy`（`:26-31`，桌面端删用户代理是越权）。
- 微信 API 细节**与我们完全一致、零新信息**（顺序 token → `add_material` 取 `thumb_media_id` → `uploadimg` → `draft/add`，
  字段 `{title, author, digest, content, thumb_media_id, need_open_comment:0, only_fans_can_comment:0}`）。
- 唯一值得记的**新线索**：`40113` = **扩展名说谎 / HEIF 伪装成 png**（`publishing.md:149`、`image-strategy.md:112`）。
  ⚠️ 但这条来自**它的 markdown 排查表，不是官方错误码表** ⇒ 采纳前须核对官方。
- 「草稿 + 人工确认」**不是代码闸门**：只有提示词层的「人工批准门禁」（`publishing.md:196-207`）+ 飞书通知 + runbook checklist；
  同一个 `publish.mjs` 一次运行内**既建草稿又提交发布**。**它的门禁严格弱于我们的 `previewRevision`(400/409) + `mark-published`。**

### 3.4 chendi126/Weichat_Auto —— 【事实】0⭐ / **无 LICENSE** / Python 4,570 行（活代码 158 行）

- **路径纠错**：用户给的 `chendi126/Weichat_AutoAI` **404**，`WeChat_AutoAI` / `wechat-auto-ai` 亦无结果；
  按 owner 的 33 个仓库+描述定位到真名 **`chendi126/Weichat_Auto`**（描述「微信公众号文章自动生成发布系统」）。
- **它是单日导出的脚手架**：**4 个 commit 全部发生在同一天** 2026-03-16，作者 `Test User <test@example.com>`，无测试无 CI。
- **4570 行里只有 158 行是活的**（`src/wechat_publisher.py`）：`cgi-bin/token`(`:27`) → `add_material?type=thumb`(`:67`) → `draft/add`(`:95`)。
  625 行公众号 node + 共 1,630 行 `src/graphs`+`src/storage` 是**扣子(Coze)死代码**（import `langgraph`/`coze_coding_utils`/`cozeloop`，
  而 `requirements.txt` 只有 6 个包，**全仓无人 import 它们**）。
- ⚠️ **但 `freepublish/submit` 确实存在于 4 处源码**（`publish_to_wechat_node.py:150` 等），只是都在**不可达路径**里
  ⇒ 对我们是**移植陷阱**：照它的"结构"搬很容易把 freepublish 一起带进来。
- **零图片工程**：无 `uploadimg`、无 ffmpeg/PIL/resize/webp/压缩；封面是仓库根的一张静态 PNG
  （**1170×685 = 1.708:1，19,685 B**），上传时 multipart 文件名还**硬编码 `cover.jpg`** 而内容是 PNG（`:56`）。
- **HTML 无任何 sanitizer**：只删 `script/style`，无白名单、无 class 剥离、无 `div→section`、**`<img>` 零处理**；
  且用 `background-color:#000000` 全幅深色 section（`article_writer.py:163-179`）—— 微信常剥离背景色 ⇒ **黑底黑字风险**。
  ⇒ 比我们的 `wechat-article.ts` **弱一代**，照搬会把我们已经做对的兼容层弄坏。
- 别抄的静默失败/硬编码：裸 `except: pass`（`github_writer.py:49-50`）、硬编码 Windows 路径
  （`e:/some_brain_think/.../背景.png`）、硬编码白名单 IP（`_v2.py:188`）、`scheduler.py:55-56` 出错只 log 后 return。
- 凭据：**未发现真凭据**（`config.yaml` 全是 `"你的AppID"` 占位）⇒ **无需上报泄露**。

---

## 4. 建议吸收（按性价比排序；**全部零新依赖**，且多数要求**自行实现**）

| # | 吸收什么 | 落点 | 为什么值得 | 注意 |
| --- | --- | --- | --- | --- |
| 1 | **反 AI 味评分器**（照 jiji262 的 31 条套话正则 + 6 维评分**自行实现**） | 新建 `src/lib/anti-ai-score.ts`，接在 `src/lib/article-draft.ts` 产出之后 | 我们现在的「去 AI 味」**只靠 prompt**；而 `article-draft.ts` 是**平台中立内核** ⇒ 头条与公众号**同时**受益 | ⚠️ 它与**已上线的头条通路共用**，改动必须保持既有用例全绿；阈值/分档的不自洽要自己定 |
| 2 | **主题样式数据 + 两条排版规则** | `src/lib/wechat-article.ts` | 与本文件现有内联样式渲染器**同构**，纯数据；其中「**丢弃首个 h1**」「**相邻 h2 插分节符**」正是它比素排版强的地方 | 只取 **CSS 值**，不引入它的 Python 流程与 JSON 加载方式 |
| 3 | **正文图 md5 去重 + 并发上传** | 未来的 `uploadimg` 写接口（`src/lib/wechat-mp-client.ts`） | 重复发布不重传；jiji262 实测**封面占 5000 永久素材配额**，正文图去重能省配额 | 并发要有限流，别把微信接口打成 45011 分钟限流 |
| 4 | **`cover_info.crop_percent_list` 同时声明 `2.35_1` + `1_1`** | `draft/add` 请求体 | 补上「1:1 缩略图」那一半 | **不推翻**现有 900×383（≈2.35:1）封面决策；schema 见 §6.3 |
| 5 | **套话黑名单 + 质量检查**（字数 / 二级标题数 / 有无结尾） | `article-draft.ts` 的**本地非 AI 兜底** | 我已确认我们**没有**这类检查（`qualityNotes` 只是透传） | 超限应**报错**，不要学它的静默截尾 |
| 6 | **正文 `content` 的字节上限**（`Buffer.byteLength < 1MB`） | `src/lib/wechat-article.ts` | 该文件 `:63` 注释写了「小于 1M」但**只有字符断言、没有字节断言** | 【推断】属**保险带**：2 万字符上限实际已隐含 ≈60KB，字节限在现实中不可达 |
| 7 | **`40113` 格式预检**（HEIF 伪装 png） | 上传前 magic-bytes 嗅探 | 防御性收益 | ⚠️ 来源是**第三方 markdown 排查表**，**非官方错误码表** ⇒ 采纳前核对官方 |

**§4 的 1–7 均未实施；本轮（2026-09-23）用户拍板的范围是：先把文章通路补齐，不顺手做这些。**

---

## 5. 明确不借 / 反面教材

1. **任何 `freepublish/submit`** —— majiabin2020 真调（`--publish`）；chendi126 有 4 处（虽在死代码里）；
   16Miku **无条件**调。⇒ 三家都是我们锁定决策的**反面教材**（详见 §7.1 的官方依据）。
2. **16Miku 的 `success: true` 硬编码** —— 失败也写成功、退出码 0、cron 当成功。**最值得引以为戒的一条。**
3. **无状态 / 无锁的 token 方案**（16Miku、majiabin2020、chendi126、jiji262 **全部**）—— 桌面端并发必踩互斥失效；
   我们已有 `stable_token` + 磁盘缓存 + 单飞刷新，**严格更强**。
4. **图像库路线**（PIL 变形 resize / 只认 Windows 字体 / AI 生封面）—— 我们的封面来自 ffmpeg 场景静帧，形态完全不同。
5. **飞书通知 + 定时任务 + 常驻服务**（16Miku、chendi126、majiabin2020）—— 我们**无服务器、无 cron、人在环**，纯属多余依赖。
6. **浏览器自动化通路**（16Miku 的 Chrome DevTools 手册、jiji262 的 Gemini 网页版逆向 3,240 行 TS）—— 与「官方 API only」冲突。
7. **一把梭 `except` / `SystemExit` / 静默截尾** —— 与我们「错误码 + 可照抄指引」的口径相反。
8. **逐行复制无 LICENSE 项目的代码** —— 见 §2.3。

---

## 6. 官方文档的新事实（**本次我亲自核对**，与项目无关但更重要）

> 来源：`developers.weixin.qq.com` 逐页 fetch，2026-09-23。这一节的价值高于 §3 的任何项目。

### 6.1 文档已按账号类型**拆目录** —— 直接更正我们既有文档里的一句错话

现在有 **`/doc/subscription/…`（公众号 = 原订阅号）** 与 **`/doc/service/…`（服务号）** 两套，
页面原文：「原公众号文档（包含订阅号与服务号）已升级为公众号（原订阅号）与服务号文档」。

⇒ 因此 `ai-trend-publish-wechat-assessment.md` 里「**草稿箱能力归属服务号**」的结论**是错的**：
草稿箱整节（`draft/add`、`draft/count`、`draft/batchget`…）**就在订阅号文档里**。已在该文件就地更正。

### 6.2 「个人主体/未认证被回收权限」**只针对 `freepublish/*`**

- [发布能力](https://developers.weixin.qq.com/doc/subscription/guide/product/publish.html) 页原文：
  「注：2025 年 7 月起，个人主体账号、企业主体未认证账号及不支持认证的账号将被回收**以上**接口的调用权限。」
  而该页「以上接口」= 那 5 个 `freepublish/*`。
- [草稿箱](https://developers.weixin.qq.com/doc/subscription/guide/product/draft.html) 页**没有**这句回收说明。
- [`draft/add`](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add) 的**适用范围表**：
  `公众号 ✔ / 服务号 ✔`。
- [接口调用额度说明](https://developers.weixin.qq.com/doc/subscription/guide/dev/api/limit.html) 把两者**分开列**：
  草稿箱-新建草稿 **1000/日**、获取草稿 500、删除 1000、修改 1000、获取草稿总数/列表 1000；发布能力-发布接口 **100/日**。

⇒ 「只建草稿」从**推断**升级为**有文档明文支撑**。

### 6.3 我们**没覆盖**的接口面：`article_type: "newspic"`（图片消息）

`draft/add` 的 `articles[]` 支持 `article_type: news`（默认）| **`newspic`（图片消息）**：

- `newspic` 用 `image_info.image_list`，**最多 20 张**，`image_media_id` 必须是**永久素材 MediaID**，**首张即封面**；
  `content` 仅支持纯文本与部分特殊标签（如商品，≤50 个）。
- `cover_info.crop_percent_list` 精确 schema：`ratio` + 归一化（0..1）的 `x1/y1/x2/y2`；
  **news 仅支持 `2.35_1`/`1_1`；newspic 支持 `1_1`/`16_9`/`2.35_1`**，且**可同时声明多个比例**（官方示例同时给了两个）。

⇒ **产品上这是一条真选项**（图片消息 ≈ 我们的「图文包」形态），但**本轮不做**（见 §7.2）。

### 6.4 其他要点

| 事实 | 备注 |
| --- | --- |
| `content_source_url`（≤1kb，即「阅读原文」URL）；`need_open_comment` / `only_fans_can_comment` | 我们目前**不发**这三个字段 |
| `digest ≤120` 是 **2026-07-14** 才对齐的（`draft/add` 变更日志：「api摘要长度限制对齐mp端120字」） | 我们编码的 120 正确；**老项目里的数字可能不同，别照抄** |
| ⚠️ **`/cgi-bin/draft/switch` 已废弃**：「该接口已废弃。草稿箱和发布功能已经全量开放，无需再设置或查询开关状态」 | **别把它当账号自检**（我一度打算推荐它，核对后发现不能用） |
| ⚠️ 官方文档**自相矛盾**一处：`content` 同时写「大小不可超过 **2kb**」与「必须少于 **2 万字符**，小于 **1M**」 | 我们按后者实现（`wechat-article.ts`）；判断 2kb 是残留笔误 ⇒ **真机应顺手验一次** |

---

## 7. 与设计决策的关系（2026-09-23 用户拍板）

### 7.1 保持「只建草稿、绝不碰 `freepublish`」 ✅

依据：§6.2 的官方明文（回收权限**只针对发布能力**；`draft/add` 适用范围含订阅号）。
并且与现有三条通路的核心不变式同构 —— **机器只记「已提交」，是否真发出由人工核实后点「标记已发布」**。

### 7.2 本轮**不加** `newspic`（图片消息）✅

先把**已有约 60% 的文章通路补完**（三个写接口 → 服务编排/路由 → 渲染层 → 真机验证），范围可控。
`newspic` 记为**将来的显式选项**（spec §11 已登记），不在本轮范围。

### 7.3 参考项目的处置

- **不做任何移植**：不换架构、不引依赖、不搬代码（§2.3 许可证约束 + §2.1 它们都不解决我们的缺口）。
- §4 的 7 条吸收项 **全部留待后续**，届时**逐条自行实现**并各自写用例。

### 7.4 本轮**仍未解决**的事（如实记录）

- **真机探针仍未跑**（spec Task 1 Step 6）：「未认证订阅号能否建草稿」**依然未知**，五家参考项目无一能替代它。
- 三个**写接口一行未写**（`uploadCoverImage` / `uploadContentImage` / `createDraft`）：spec §7 定义了签名，
  但 Task 1 的完成范围只到「token + `draft/count` 自检」⇒ **真正把草稿建出来的那半条链还没有代码**。

---

## 附：一手证据索引与核对状态

| 结论 | 来源 | 我的核对状态 |
| --- | --- | --- |
| 文档拆分为 subscription/service 两套命名空间 | 官方文档页面顶部原文 | ✅ 我亲自 fetch |
| 「回收权限」只针对 `freepublish/*` | 发布能力页 vs 草稿箱页对比 | ✅ 我亲自 fetch |
| `draft/add` 适用范围 `公众号 ✔ 服务号 ✔` | `api_draft_add` §7 | ✅ 我亲自 fetch |
| `newspic` / `image_info` / `cover_info.crop_percent_list` schema | `api_draft_add` §2 | ✅ 我亲自 fetch |
| `draft/switch` 已废弃 | `api_draft_switch` 页首「该接口已废弃」 | ✅ 我亲自 fetch |
| `digest` 120 于 2026-07-14 对齐 | `api_draft_add` 变更日志 | ✅ 我亲自 fetch |
| 草稿箱/发布配额分列（1000/日、100/日） | `limit.html` 额度表 | ✅ 我亲自 fetch |
| jiji262 主题为纯数据内联样式 / 反 AI 味 515 行 / `pytest` 45 passed | `assets/themes/*.json`、`ai_score.py`、实跑 `pytest` | ⚠️ 子代理只读核对（未由我逐行复核） |
| majiabin2020 真调 `freepublish/submit`、无文本大模型调用 | `cli.py:538-542/649-659`、grep 命中 0 | ⚠️ 子代理只读核对 |
| 16Miku `success: true` 硬编码、无条件 freepublish | `templates/publish.mjs:392/401` | ⚠️ 子代理只读核对 |
| chendi126 真名与活代码 158 行 | GitHub API + `requirements.txt` 交叉 | ⚠️ 子代理只读核对 |
| 四家许可证状况（三家无 LICENSE） | GitHub `license` 字段 | ⚠️ 子代理只读核对 |
| 我们自身：三个写接口未实现、1M 字节断言缺失、无套话检查 | `src/lib/wechat-mp-client.ts`、`wechat-article.ts`、`article-draft.ts` | ✅ 我亲自 grep/读源码 |

> 全部 clone 均在 `/tmp`，**未修改任何被评估仓库，也未修改本仓库的代码**（本轮只改文档）。

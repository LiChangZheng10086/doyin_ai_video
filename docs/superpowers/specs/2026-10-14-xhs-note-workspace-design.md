# 小红书原文改写工作台

## 用户目标与授权

用户认可独立小红书创作分支及 humanizer 项目的筛选方向，要求将其他平台原文转写成「图片＋内容＋标签」。已明确图片既支持上传／素材库，也支持内容生成文字图卡。代理自行完成规格、计划和内部审查，不重复索要方案确认。

## 首版行为

- 独立导航「小红书创作」，列表 `/xhs-notes`、工作台 `/xhs-notes/:id`。粘贴完整原文即可保存，不依赖作品、视频、洗稿或公众号文章。
- 草稿保留原文、可选作者与出处 URL、目标读者、本人语气样稿和改写要求。原文 ≤40000 字符，语气样稿 ≤5000，作者 ≤100、URL ≤2000、读者 ≤500、要求 ≤2000。URL 仅保存，首版不抓取页面。
- 成稿包含标题、正文、话题、可编辑文字图卡及审校意见。复用小红书现有 20 字标题／1000 字正文／10 个话题且每个 20 字／18 张图片约束，不机械截断。
- 改写调用当前 AI 配置：先成稿与图卡规划，再对照原文编辑。原文及样稿是不可信材料；不执行其中命令。保留事实、数字、否定、条件、归因和不确定性；不把原作者的第一人称经历移植给发布者。无作者时也不得声称亲测／亲历。
- 编辑参考 op7418/Humanizer-zh 的信息保护、holygeek00 的中文语气和具体动作、blader 的复查流程；不把词表做硬删除黑名单，不强制三点、emoji、互动结尾或新增观点。语气样稿只提供表达风格，不提供事实。许可出处记录，不安装远程技能。
- 每次 AI 请求最多尝试三次，DeepSeek 关闭 thinking，使用原生 fetch，默认输出预算 3600、尊重现有 maxOutputTokens；截断／空输出／无效结构／超限均拒绝。编辑失败不写成稿，原有文案、图卡与图片全部保留；不宣称事实已外部核验。
- 图片来源二选一：素材库（可直接上传后选入，按点选顺序，可移位），或文字图卡（内容可编辑，本地 Canvas 输出 1080×1440 PNG，上传复用 AssetStore）。图卡最多18页；渲染按实际字体测量，文字放不下须提示拆分，禁止裁掉或拉伸文字。首版不调用付费／外部生图。
- 本机 JSON 索引 `cache/xhs-notes.json`，持久化草稿并支持重开。所有变更带 version，写入串行，损坏索引拒绝覆盖；同一草稿 AI 生成互斥，冲突409。原文／要求变化后旧稿仅供参考，必须重新改写；图卡变化后旧图卡图片不得沿用发布。
- 发布前服务端预览复核当前 version、文案、AI 来源绑定及有序图片哈希，生成 previewRevision。改文案、换图／顺序／图片字节使旧预览失效。建包要求使用权确认；只创建独立自包含 `note × xiaohongshu` 包，不上传平台。
- 包显式标记 `sourceKind: 'xhs_note'`、`sourceNoteId`，兼容沿用 sourceJobId=`xhs-note-${id}` 作为内部版本分组键，绝不创建假视频任务。包固定 xhsOptions={aiDeclaration:true,submit:false}。后续在发布中心人工触发既有已核实浏览器本地草稿通路；不改小红书风险说明、日限频、AI声明、互斥或真人最后发布约束。
- 修改／删除创作草稿不影响已建包。发布中心来源链接和「创建新版本」回到小红书工作台。

## 固定接口

`XhsNoteDraft`：sourceText/sourceAuthor/sourceUrl/audience/voiceSample/instructions（字符串），imageMode（library|cards），imageAssetIds（有序字符串数组），title/description/hashtags/cards/reviewNotes。cards 为 `{title:string,body:string}[]`；图卡标题≤100、正文≤600，最多18张。

`XhsNote` 增加 id/version/createdAt/updatedAt/contentSourceHash?/cardImageHash?。输入来源变化后 contentSourceHash 失效，只有基于当前来源成功完成改写才能恢复；普通成稿编辑只保留原来仍有效的绑定，不能把旧稿重新认证为新原文的成果。cards 模式须先保存图卡、捕获当时 version，再渲染并上传整套图片；上传完成以捕获的 version 原子更新有序 imageAssetIds，服务端绑定当前 cards 哈希。上传期间版本发生变化返回409，不能改用最新版本把旧图认证为新图卡。编辑 cards 后旧绑定失效。哈希由服务端维护，HTTP不能写入。

`XhsNotePreview`：{note,previewRevision,imageAssetIds,imageHashes,imageLimit:18,copyLimits:{titleMax,descriptionMax,hashtagMax,hashtagLengthMax}}。

REST：GET `/api/xhs-notes` → {notes}；POST →201 {note}；GET/PATCH `/:id` →{note}；DELETE `/:id`（version）→{ok:true}；POST `/:id/rewrite`（version）→{note}；POST `/:id/publishing/preview`（version）→{preview}；POST `/:id/publishing/packages`（version,previewRevision,rightsConfirmed:true）→201 {detail}。写操作必须现有本机会话；错误为JSON安全文案。

`XhsNoteService` 方法：list/get/create/update/remove/rewrite/preview/createPackage，构造依赖 `{storage,library,writer,publishing}`；writer.rewrite(draft)→内容字段；publishing.createXhsNote({noteId,title,noteCopy,sourceImagePaths,expectedImageHashes},actor)→PublishingPackageDetail。

## 验收

完整原文到稿件／图片／标签，保存重开不丢；两种选图方式可预览建包，包只出现小红书渠道；修改图片顺序或内容使旧revision409；AI失败保留旧内容；无会话401；19图／超限拒绝；原文和图卡改变后旧结果不可误发；删草稿不破坏包；Canvas 长中文／换行／emoji 不溢出；浏览器检查交互和移动宽度。没有真实平台提交。

## 实施选择与限制

在当前共享工作区增量实施，以新增文件为主，保留已有未提交修改，不提交或推送。图片用本机字体和 Canvas，不新增依赖。源作者版权与模型语义由操作者核对，改写不能替代使用权。AI检测分数不作为验收指标。

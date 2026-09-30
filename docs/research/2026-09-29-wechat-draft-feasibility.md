# 微信公众号草稿：可行性与剩余实施范围

日期：2026-09-29。用户确认账号为**个人订阅号，未认证或仍在审核**。
本文第 1–6 节保留分析阶段记录。**后续用户已授权实现，代码接入状态见第 7 节；真实账号仍未验收。**

## 1. 结论

**技术方案可以实现，但尚不能承诺这个账号已跑通。** 官方提供新建草稿接口，项目已有文章、图片和 API 客户端基础；缺的是发布中心编排、配置与界面接入，以及真实账号验收。不需要引入浏览器自动化或新的 SDK。

官方[新增草稿](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add.html)适用范围含公众号和服务号，但没有按个人主体、认证状态细分授权。官方[发布能力](https://developers.weixin.qq.com/doc/subscription/guide/product/publish.html)明确自 2025 年 7 月起收回个人主体等账号的发布接口权限；这不能直接外推成草稿接口同样不可用，也不能反向证明未认证个人号一定能建草稿。

无需把“等待认证完成”设为连接预检前置条件；但不能承诺认证必然增加草稿权限。最终以当前账号的具体接口结果和后台草稿验收为准。

**产品边界：仅保存到公众号草稿箱。** 正式发布与群发是不同能力，二者均不接入；不调用 `/cgi-bin/freepublish/*` 或 `/cgi-bin/message/mass/*`，也不通过浏览器代点发布。草稿成功不代表文章已发布、通过内容审核或满足全部运营合规要求，最终由用户检查并发布。

## 2. 官方链路及权限验证

| 步骤 | 官方接口 | 成功能证明什么 |
| --- | --- | --- |
| 凭据 | `POST /cgi-bin/stable_token` | 当前凭据可换 token；可能需要 IP 白名单或管理员风险确认 |
| 连接预检 | `GET /cgi-bin/draft/count` | 能查询草稿数量，**不证明以下写接口可用** |
| 封面 | `POST /cgi-bin/material/add_material?type=image` | 封面永久素材上传成功，得到 `media_id` |
| 正文图 | `POST /cgi-bin/media/uploadimg` | 正文图上传成功，得到微信托管 URL；无正文图时可跳过 |
| 创建 | `POST /cgi-bin/draft/add` | 返回有效 `media_id` 时，草稿已创建；须立即保存该 ID |
| 验收 | 人工打开草稿箱；必要时 `POST /cgi-bin/draft/get` | 检查对应草稿的标题、正文、封面和正文图是否完整 |

预检不写内容，但 token 获取可能触发管理员确认，不应笼统称为“账号零副作用”。重用缓存 token 时，不能声称刚验证了当前 AppSecret 和公网 IP；显式预检应换取普通模式的稳定 token（不强制刷新），或者清楚标注证据来自缓存。

未来真实验收必须包含**一篇带封面和一张正文图的测试草稿**，才能覆盖三条写接口；用户在公众号后台看见且检查无误后，才可记为端到端跑通。本轮不执行。可选 `draft/get` 回读失败不得把已成功创建的草稿改判为“未创建”，也不得自动重发 `draft/add`。

依据：[稳定凭据](https://developers.weixin.qq.com/doc/subscription/api/base/api_getstableaccesstoken.html)、[服务端调用与白名单](https://developers.weixin.qq.com/doc/subscription/guide/dev/api/)、[草稿数量](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_count.html)、[永久素材](https://developers.weixin.qq.com/doc/subscription/api/material/permanent/api_addmaterial.html)、[正文图片](https://developers.weixin.qq.com/doc/subscription/api/material/permanent/api_uploadimage.html)、[草稿详情](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_getdraft.html)。

## 3. 项目已有与缺失

| 层级 | 代码证据 | 当前情况 |
| --- | --- | --- |
| 成文、HTML、图片 | `article-draft.ts`、`wechat-article.ts`、`wechat-media.ts` | 已有共享成文、微信 HTML 与图片处理；不要重做 |
| API 客户端 | `wechat-mp-client.ts` | 已有 token、count、自检、封面上传、正文图上传、建草稿；没有草稿详情回读 |
| 包、类型、预览 | `publishing-assets.ts`、`types.ts`、`PublishPreviewDialog.tsx` | 已有 article 包、微信平台标识、文章预览及 HTML 下载路由，复用即可 |
| 服务分派 | `publishing-platforms.ts`、`publishing-service.ts` | 仅抖音图文、头条文章、小红书图文三条自动通路；文章创建仍只接受头条，没有公众号编排 |
| 配置与界面 | 两个 server 入口、Electron 配置、Settings、Publishing | 公众号凭据注入、配置、自检入口、建包与提交动作尚未接通 |

路径均相对仓库：后端模块在 `src/lib/`，类型在 `src/`，前端在 `renderer/src/`。

### 已确认、恢复开发时先处理的缺口

1. `WechatMpClient.timeoutMs` 已声明但未应用到请求；需要真正的请求/响应读取超时，不能让界面永久等待。
2. `getDraftCount()` 将缺失 `total_count` 默认为 0。假 HTTP 返回 `{}` 时自检居然成功；必须验证响应结构及非负整数，异常响应 fail closed。
3. 探针成功文案称“可以建草稿”，超出证据范围；改为“连接预检通过，素材上传与创建草稿尚未验证”。权限错误按具体端点解释，不能统一说“认证即可解决”。
4. `substituteWechatImageSlots()` 当前放行恰好 20,000 字符，与官方“少于”不符；最终 URL 替换后同时检查严格字符边界和 UTF-8 字节大小。微信规则不能覆盖头条的通用 HTML 限额。
5. `draft/add` 超时或断线可能是“微信已创建但响应未到”。保留结果不确定提示和审计，不自动重试；人工先核对草稿箱再决定。拿到 ID 后立即持久化，后续回读或本地保存失败都不能悄悄再创建一份。

上述前三项中的请求信号与空响应、第四项的 20,000 边界已用进程内假 HTTP/纯函数复现，未访问真实账号。问题本轮只记录，不改代码。

## 4. 内容与凭据约束

- 首期单篇 `article_type: news`：标题 ≤32、作者 ≤16、摘要 ≤120；封面永久素材 ID 必填，正文图可为 0 张。不要顺带做 `newspic`、多图文、评论或多账号。
- 正文只发微信兼容 HTML；不带脚本、任意外链图或未替换的 `{{wechat-image-N}}`。图片必须使用本次上传返回的微信 URL；官方示例包含 HTTP URL，不能只凭协议为 HTTP 就否定合法微信图片。
- 正文图 JPG/PNG 严格 <1MB；永久封面图按官方 ≤10MB。现有转换/裁剪模块复用，不再加图像依赖。
- 官方正文说明同时存在“2kb”与“少于 2 万字符、小于 1M”的冲突；现阶段按后者设置防线，将真实草稿验收作为待确认项，不宣称文档歧义已解决。
- AppSecret 只在本机后端使用，Electron 沿用 `safeStorage` 加密方案；不回显完整 secret，不写日志、审计、包清单或 Git。token 缓存也须保护，不与文章包一起导出。
- 本机公网 IP 变化需要更新白名单；首期不搭建固定 IP 中转服务。不自动申请/重置密钥、修改白名单或清除配额。
- 权限不足时保留文章与图片交付包。HTML 中可能仍是微信图片占位符，人工粘贴只作为文字/排版辅助；封面和正文图需手工上传，不能保证复制即可完整复原。

## 5. 最小剩余实施顺序（尚未执行）

1. 先修客户端预检、超时、异常响应与最终 HTML 限额；补对应最小回归用例。
2. 接入独立后端和 Electron 配置，提供不写内容的连接预检；界面区别“连接通过”和“已验证真实草稿”。
3. 复用现有文章创建/包预览/素材选择，按平台使用微信限额、HTML 和封面；不复制头条整套服务，不改既有视频/图文通路。
4. 给现有路由表增加 `article × wechat_mp`。复用 `auto-publish` 的预览版本校验、权限审计、互斥；依次上传图片、替换 URL、创建草稿、保存草稿 ID。`task.status` 不变，子记录成功只表示“草稿已创建”。
5. 发布中心公众号栏提供“提交到公众号草稿箱”，无“自动正式发布”开关。复用文章预览分支；`draftOnly` 提示按平台显示，避免出现小红书专属文案。
6. 假 HTTP 集成测试守住分派、去重/不重试、脱敏、预览失效、图片/HTML 限额与禁止发布/群发请求。再全量检查、编译两套后端产物；用户决定进行真实草稿验收时执行第 2 节清单。

既有详案：[设计规格](../superpowers/specs/2026-09-18-wechat-mp-article-publish-design.md)、[实施计划](../superpowers/plans/2026-09-18-wechat-mp-article-publish.md)。本报告的 2026-09-29 结论优先于旧文档中“count 成功即可以建草稿”的表述。

## 6. 本轮验证记录

`node --import tsx --test src/lib/wechat-mp-client.test.ts src/lib/wechat-article.test.ts src/lib/wechat-media.test.ts`：**99/99 通过**。这些是现有单测（HTTP、ffmpeg 使用替身），不是实际公众号权限或真实上传证明。

未修改应用源码，未运行真实账号探针，未上传素材、建草稿、正式发布或群发。

## 7. 后续实施（2026-09-29）

已接通 `article × wechat_mp`：复用文章向导、包资产/预览、版本检查、任务互斥和审计。设置页提供加密配置与连接预检，创建向导提供作者、摘要、单封面与可选正文图；发布中心只提供「提交到公众号草稿箱」。无新依赖、无公众号浏览器执行器、无正式发布/群发接口。

- 第 3 节五项缺口已处理：请求/响应超时、count 响应严格校验、预检证据措辞、最终 HTML `<20,000` 字符且 `<1MiB`、不确定结果防重复提交。
- 成功保存 `autoPublish.draftMediaId` 与 `draftOnly`，`task.status` 保持原值。超时/异常响应保存 `outcomeUncertain`；成功、不确定或遗留运行状态都不能直接重发。先人工核实后台，确需另建时新建包。
- AppSecret 通过 Electron `safeStorage` 加密且不回显；系统不能加密或密钥不能解密时拒绝保存，不退回明文/空配置。应用运行通路的 token 仅在本次操作内缓存，不落盘；设置保存后立即生效。独立后端用 `WECHAT_MP_APP_ID` / `WECHAT_MP_APP_SECRET` / `WECHAT_MP_AUTHOR`，需重启。
- 使用：重启已编译的 Electron → 设置「微信公众号」保存配置并校验连接 → 已完成作品详情的成果画布「创建公众号文章包」 → 发布中心「微信公众号」预览并确认提交 → 后台人工验收。
- 假 HTTP 集成覆盖带图/无图、草稿 ID 落盘、超时不重发、并发互斥、版本失效不上传、权限拒绝与只读预检。实际账号权限、真实上传和后台排版仍须按第 2 节验收，不能将模拟测试称作真实跑通。

有意未做：`draft/get` 回读、跨次复用上传素材、多账号、自动发布与群发。失败保留本地交付包；下载的 HTML 中图片可能仍是占位符，人工使用时需重新上传图片。

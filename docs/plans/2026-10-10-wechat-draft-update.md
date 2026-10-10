# 公众号原草稿更新

功能范围：通过项目更新已有公众号草稿，保持原任务与 media_id；支持现成模板、短段落、图片就近与来源层级。更新动作不新增草稿，不调用发布或群发接口。

- 客户端 `WechatMpClient.updateDraft(mediaId, article)` 只调用官方 `draft/update`，固定单篇 `index=0`，明确 `errcode=0` 才成功；复用既有 token 和校验，未知结果不重试。
- 文章服务持有串行队列，`POST /api/articles/:id/wechat-drafts/:taskId/preview` 返回当前版本、HTML、mediaId、previewRevision；`POST .../update` 必须带版本及预览指纹。指纹绑定文章、图片哈希、原任务/包/草稿和上次更新尝试。只允许关联此原文章的已成功建稿任务。
- PublishingStore 在索引事务内复核原 mediaId、上次 attemptId 和任务 contentRevision。运行中拒绝再次提交、任务编辑与包移入垃圾桶。成功和失败均保留原建稿记录；未知或中断结果必须人工核实，不用超时自动放行。
- 每次更新在 `output/publishing/wechat-draft-updates/{taskId}/{attemptId}/` 留存文章、HTML、源图快照、微信托管图片替换后的 HTML 及不含 token 的 API 结果。历史发布包不覆盖；审计保留每次快照路径。最新结果在 `task.wechatDraftUpdate`，成功后最新内容以该快照为准。
- 排版扩展限定为已有模板、0 基图片章节位置与图注、独立来源区。正文由原定稿重新分段，不添加事实或新素材。暂未增加前端更新按钮，可经上述项目 API 执行。

验收：客户端禁止新增/群发路径；旧预览、错误来源绑定、并发、未知响应、确定拒绝和图片变化保护；HTTP 登录和版本回归；`npm test`、`npm run check`、对应编译；最后通过编译后的原 Electron 内嵌后端更新同一草稿。


验收记录（2026-10-10）：原草稿更新经项目与微信 API 确认成功，原 media_id 不变；只做本地手机排版预览，未追加微信后台操作。相关回归、类型与凭据检查、完整编译通过。首次沙箱外全量 1294 通过、1 跳过；末次全量 1293 通过、2 失败、1 跳过（1296 项）。失败为 `runCommand timeout terminates spawned descendants` 与 `translated gallery HTTP uses reviewed Chinese pixels, immutable originals and self-contained publishing assets`，单独复跑 5/5 通过；仍保留高并发时序不稳定的限制，不宣称末次全量全绿。测试文章、图片、帐号标识、凭据和本机执行产物不进入提交。

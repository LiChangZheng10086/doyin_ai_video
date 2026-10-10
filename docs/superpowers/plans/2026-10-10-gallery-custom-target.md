# 图集自定义目标条数实施计划

**Goal:** 快捷条数之外支持自定义正整数。
**Architecture:** 原有 targetLines 数字贯穿前端、规划类型和两种规划器；实际排版容量保持校验。
**Tech Stack:** React、TypeScript、Node test、FFmpeg。
**Spec:** docs/superpowers/specs/2026-10-10-gallery-custom-target-design.md

- [x] 先补两种规划器自定义分组、非法数字、容量与完整性测试，运行确认失败。
- [x] 放宽目标字段及校验；快捷项保留原均衡规则，自定义不超过目标；filmstrip 支持可读的第十条。
- [x] 增加自定义选择与输入、非法值禁用及重新确认提示。
- [x] 运行针对性与项目回归、类型检查，编译后端及桌面端/前端产物。
- [x] 内部复核最终差异，报告验证与未包含范围。

## 验证记录

- 两个新增规划测试修改前因只允许 6～9 而失败；修改后通过。旧非法输入测试中的 5 已合法，替换为 0。
- 图集规划、翻译、HTTP、真实 FFmpeg 和工作台共 30 项专项测试全部通过；十行 filmstrip 输出仍为 1080×1440，每行字幕像素可见。
- `npm run check` 与 `npm run build` 成功；Vite 保留已有大包提示。
- 隔离的 32 条中文译文：浏览器选择自定义 4，真实提交 `targetLines: 4`，API 返回八张、每张四条，完整覆盖输入；空值、0、负数、小数禁用规划，12 可输入，切回快捷项后再次选择自定义保留数值。
- UI 截图：`output/playwright/gallery-custom-target.png`。夹具临时目录与浏览器已关闭，未写真实作品、未提交发布。
- 内部复核确认类型、两种规划器、生成校验和界面均接通；旧手动布局不扩容。默认翻译时间范围与 35 张上限不属于本次改动。
- 最终全量：1262 通过、1 失败、1 跳过。失败项为 `translated gallery HTTP uses reviewed Chinese pixels, immutable originals and self-contained publishing assets`，`fetch failed / UND_ERR_SOCKET`；夹具设置了 200ms server timeout。该测试连同本次相关测试在专项复测中全部通过，没有把全量结果记为全绿。
- 初次新增十行真实渲染测试因测试裁剪区域未包含白色字幕而失败；修正夹具区域后独立复测和最终全量中的该项均通过。

# 外部依赖的本地补丁

这里存放**对第三方仓库的本地改动**。它们不在我们的构建里、不会自动生效，
只用于「上游更新后如何把补丁重新打回去」以及「为什么当初要改」的留痕。

## social-auto-upload（抖音图文自动发布的引擎）

引擎装在 `~/social-auto-upload`（不属于本仓库，见 AGENTS.md 的 SAU 配置一节）。

### `sau-note-title-selector.patch`

- **症状**：图文发布稳定失败，`autoPublish.message` 结尾是
  `Locator.wait_for: Timeout 120000ms exceeded. waiting for locator("input[placeholder*=\"填写作品标题\"]").first to be visible`。
- **根因**：抖音把图文发布页的标题输入框 placeholder 从「填写作品标题」改成了「添加作品标题」，
  而上游 `uploader/douyin_uploader/main.py` 的 `fill_title_and_description()` 仍按旧文案匹配
  （该文件注释写的是 "2026-06 抖音发布页 DOM"）。2026-09-17 实测：旧选择器命中 **0**，
  `input[placeholder*="作品标题"]` 命中 **1**。
- **改法**：只放宽子串匹配（`填写作品标题` → `作品标题`），两种文案都成立，抖音改回去也不会坏。
- **实测未受影响**（因此不改）：描述框 `div.zone-container[contenteditable="true"]` 命中 1；
  发布按钮 `get_by_role("button", name="发布", exact=True)` 命中 1。
- **应用**：
  ```bash
  cd ~/social-auto-upload && git apply /path/to/docs/patches/sau-note-title-selector.patch
  ```
  改完可用 `./.venv/bin/python -m py_compile uploader/douyin_uploader/main.py` 做语法自检。
- **注意**：上游 `git pull` 会覆盖它；升级后要重新 `git apply` 并重跑一次真实发布验证。

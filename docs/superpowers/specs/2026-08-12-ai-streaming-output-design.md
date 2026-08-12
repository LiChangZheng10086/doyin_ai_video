# AI 洗稿与分镜流式输出设计规格

**状态：** APPROVED  
**批准日期：** 2026-08-12  
**日期：** 2026-08-12  
**产品：** 抖创工坊  
**范围：** AI 洗稿、AI 分镜生成、任务详情页实时反馈  
**实施边界：** 保留现有手动步骤、最终 JSON 校验和正式产物接口；新增流式预览，不改变视频生成流程

## 1. 背景与目标

当前 AI 洗稿和生成分镜使用一次性请求。用户点击步骤后，直到模型完整返回、JSON 校验通过并写入产物之前，只能看到“处理中”，无法判断模型是否仍在工作，也无法提前阅读已经生成的内容。

目标：

- AI 洗稿过程中实时展示已经收到的文案内容。
- AI 分镜过程中实时展示已经收到的模型输出，完成后替换为结构化镜头列表。
- 保留最终 JSON 校验边界，任何未完成或未通过校验的内容都不能写入正式产物。
- 支持暂停、失败、重启和浏览器断线，不留下半截成功状态。
- 不破坏现有步骤 POST 接口和旧任务数据。

## 2. 已确认设计决策

| 决策 | 结果 |
| --- | --- |
| 传输方式 | SSE（Server-Sent Events） |
| 上游 AI | 使用 OpenAI-compatible Chat Completions 的 `stream: true` |
| 正式产物 | 只在完整响应解析、校验成功后落盘 |
| 流式内容 | 洗稿展示文案预览；分镜展示模型响应预览，完成后展示镜头卡片 |
| 接口兼容 | 保留现有步骤 POST 接口和 cleaned/video-prompts 接口 |
| 重连 | 前端断线后可重新订阅当前步骤，服务端发送最近缓存的增量和当前状态 |
| 暂停 | 通过现有暂停接口终止上游请求，发送 paused 事件，不保存半截产物 |
| 错误 | 发送 error 事件并沿用现有 `lastError`；正式步骤状态为 failed |
| 资源限制 | 单个运行保留有限大小的预览缓冲，不把完整 AI 响应长期存入任务索引 |

## 3. 数据流

```text
前端订阅 SSE
    ↓
POST 执行步骤
    ↓
JobStore 创建运行上下文
    ↓
OpenAI-compatible stream=true
    ↓ delta                  ↓ completed
服务端推送 preview 事件       完整 JSON 解析与业务校验
    ↓                         ↓
前端实时预览                 写入 cleaned/script 正式产物
                              ↓
                         推送 completed 事件
```

前端应先建立 SSE 订阅，再触发步骤 POST，避免短响应任务在订阅建立前完成。POST 的最终返回仍然是完整任务结果，旧调用方无需改造。

## 4. 服务端设计

### 4.1 运行事件总线

在任务服务中增加按 `jobId + step` 管理的短生命周期运行上下文：

- 当前步骤状态：`starting`、`streaming`、`completed`、`failed`、`paused`。
- 已发送事件序号，支持断线后通过 `Last-Event-ID` 续传最近缓冲。
- 订阅者集合与有限 preview 缓冲。
- 运行结束或断开后释放订阅者和缓冲。

事件格式统一为：

```json
{
  "id": 12,
  "type": "preview",
  "jobId": "job-id",
  "step": "clean",
  "delta": "已经生成的片段",
  "text": "当前预览全文",
  "model": "deepseek-chat"
}
```

事件类型：`connected`、`started`、`preview`、`progress`、`completed`、`paused`、`error`、`closed`。

### 4.2 SSE 接口

新增：

```text
GET /api/jobs/:id/steps/:step/events
```

其中 `step` 仅允许 `clean` 和 `generate_video_prompts`。响应使用 `text/event-stream`，发送 `id`、`event` 和 JSON `data`。不把 API Key、完整请求体或上游原始错误泄漏给前端。

服务端在步骤未启动时发送 `connected` 后保持等待；步骤完成、失败或暂停后发送终止事件并关闭连接。连接断开不自动取消后端任务，用户主动暂停才会终止运行。

### 4.3 AI 客户端

扩展现有 AI 完成方法，支持可选的 delta 回调：

- `stream: true` 时读取 `choices[0].delta.content`。
- 每个非空片段发布到运行事件总线。
- 聚合完整文本后继续使用现有 `parseAiJson`、`validateShortVideoPlan` 和洗稿字段校验。
- 上游不支持流式响应时回退为一次性请求，并至少发送 `started`、`completed`，不影响正式结果。
- JSON 截断、连接中断和暂停都不得写入 cleaned 或 video-prompts 正式产物。

## 5. 前端设计

### 5.1 API 与状态

前端 API 增加步骤事件订阅方法，使用原生 `EventSource` 或 fetch SSE reader，不让 Axios 缓存或等待完整响应。任务详情维护：

- `streamingStep`
- `streamPreviewText`
- `streamReceivedLength`
- `streamModel`
- `streamError`

任务刷新后，如果步骤仍为 `running`，自动重新订阅；步骤为 `succeeded`、`failed` 或 `paused` 时关闭订阅。

### 5.2 洗稿预览

AI 洗稿区域在步骤运行时显示：

- “正在生成 AI 洗稿”状态
- 已接收文本预览
- 当前模型名称
- 已接收字符数

预览明确标记“生成中，尚未保存”，不展示为最终标题、摘要或核心要点。完成后使用正式 cleaned 产物替换预览。

### 5.3 分镜预览

分镜区域在步骤运行时显示：

- “正在生成分镜”状态
- 流式 JSON/文本预览，使用等宽字体和可滚动容器
- 生成完成后切换为结构化镜头列表

未完成的 JSON 不尝试渲染成镜头卡片，避免半截对象造成错误提示或误导用户。

### 5.4 暂停、失败与重连

- 暂停按钮继续使用现有 `/pause` 接口，并立即关闭前端 SSE。
- 重新启动时清空旧预览，重新建立订阅并从头执行当前步骤。
- SSE 断线时显示“连接已断开，正在重新连接”，自动重连有限次数；任务本身继续执行。
- 后端失败时优先显示 `lastError`，不显示通用网络错误覆盖真实原因。

## 6. 非目标

- 不边生成边写入 cleaned 或 video-prompts 文件。
- 不把流式预览作为可编辑草稿保存。
- 不引入 WebSocket、第三方播放器或新的消息队列。
- 不让视频渲染步骤接收流式文本；视频仍只消费已校验的正式分镜。

## 7. 测试要求

- AI 客户端能消费多个 delta 并聚合为完整文本。
- 流式完成后才写入正式产物。
- 流式 JSON 截断、上游断开和暂停均不会写入半成品。
- SSE 事件包含 started、preview、completed/error/paused，并支持最近事件续传。
- 前端在运行中显示预览，完成后切换正式成果，失败显示步骤错误。
- 断线重连不会重复触发步骤，也不会产生重复任务运行。
- 保持现有 `npm run check`、`npm test`、`npm run build:backend` 和 `npm run build:renderer` 通过。

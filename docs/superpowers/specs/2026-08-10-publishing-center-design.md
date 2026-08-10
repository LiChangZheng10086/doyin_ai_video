# 发布中心与本地角色系统 V1 设计规格

**状态：** APPROVED
**批准日期：** 2026-08-10
**产品：** 抖创工坊
**范围：** 本地用户与权限、发布包、平台文案、人工发布队列、排期提醒、审计与清理
**实施边界：** 本规格只定义需求与设计，不授权自动上传或自动发布

## 1. 目标

将现有“视频成片后只能预览或下载”的终点扩展为本地发布中心。用户可以把已生成的竖屏 MP4 整理成独立发布包，为抖音、小红书、微信视频号和哔哩哔哩生成并审核平台文案，设置人工发布排期，打开平台完成上传，并在应用内维护可纠错、可审计的发布记录。

V1 保持本地桌面应用定位。应用不保存平台账号、密码或 Cookie，不自动上传视频，不操作平台表单，也不点击最终发布按钮。

## 2. 当前状态证据

### 2.1 代码证据

| 证据 | 当前状态 | 结论 |
| --- | --- | --- |
| `src/lib/jobs.ts` | 主链路固定为转录、AI 洗稿、生成分镜、生成视频四步 | 发布属于成片后的独立领域，不能伪装成第五个生成步骤 |
| `src/app.ts` | 已提供 `/video/stream` 和 `/video/download`，没有发布接口 | 可复用成片解析与安全检查，但需要新增发布 API |
| `renderer/src/pages/JobDetailPage.tsx` | 成片区域只有播放器、下载和文件路径 | 需要新增“加入发布中心”入口 |
| `renderer/src/App.tsx` | 导航只有创作中心、合集、Skills、设置、垃圾桶 | 需要新增发布中心和本地操作者入口 |
| `src/lib/storage.ts` | 当前主应用通过 `LocalStorage` 读写 JSON 与本地文件 | 发布索引和用户索引继续采用本地文件，不引入数据库 |
| `electron/handlers/app-handler.ts` | 已提供 `openExternal`、`showItemInFolder` 和系统通知 | 可复用人工交付动作，不需要浏览器自动化 |
| `package.json` 与 `backend/` | 仓库存在 SQLite 依赖和历史 Python 后端，但 Electron 主链路不使用它们 | 本功能不得接入遗留后端或建立第二套任务真相源 |

### 2.2 浏览器证据

2026-08-10 使用应用内浏览器打开 `http://localhost:5173`。页面能展示导航、创作中心筛选和空态，但直接 Vite 页面没有 Electron 注入的随机 Express 端口，`/api/config`、`/api/jobs/overview` 等请求返回 502。该检查证明浏览器壳层没有发布入口，也证明独立 Vite 页面不能替代 Electron 真实数据流。此限制已记录，不以浏览器空态推断桌面任务数据。

### 2.3 Electron 桌面证据

2026-08-10 通过 Computer Use 只读检查运行中的“抖创工坊”：

- 创作中心存在真实任务、状态、下一步和打开操作。
- 任务详情显示四步 Workflow、成果导航、时间线和高级信息。
- 当前本地任务中没有已成功生成 MP4 的记录，因此没有通过写数据伪造完整成片流程。
- 代码与界面共同证明：即使存在成片，当前操作也止于预览和下载，没有交付包、平台任务、排期、操作者或审计记录。

### 2.4 PostgreSQL 证据

通过 PostgreSQL MCP 检查到 `public`、`sks_demo`、`sks_test` 等 schema。`public` 中只有项目排期类表 `tb_project_schedule_node`、`tb_project_schedule_version`、`tb_scheduling_config_version`，与抖创工坊无关；代码中也没有 PostgreSQL 连接配置。不得把外部数据库误认为本项目数据源。本功能使用现有本地 JSON 与文件目录。

## 3. 已确认产品决策

| 决策 | 结果 |
| --- | --- |
| 发布自动化边界 | 生成交付包并辅助人工发布，用户在平台完成上传和最终提交 |
| 平台范围 | 抖音、小红书、微信视频号、哔哩哔哩；V1 不支持自定义平台 |
| 视频适配 | 四个平台共用同一 1080x1920 MP4，不做平台转码 |
| 文案生成 | AI 分平台生成；失败时回退洗稿内容；用户审核编辑 |
| 排期 | 到期转为待发布并通知，不自动打开平台 |
| 应用退出 | 不驻留托盘；下次启动补处理逾期任务 |
| 已发布纠错 | 管理员可确认后撤回到待发布，保留完整审计 |
| 视频存储 | 发布包优先使用 APFS 克隆，失败时普通复制 |
| 封面 | 优先现有本地封面，其次抽取第 1 秒；失败不阻断 |
| 删除 | 进入发布垃圾桶 30 天；过期删除大文件并保留轻量历史 |
| 版本 | 同一成片允许多个独立发布包版本，版本号不复用 |
| 编辑锁定 | 未发布平台可编辑；已发布平台内容锁定，修改需新版本 |
| 取消 | 可恢复到待发布或重新排期，保留取消与恢复审计 |
| 本地用户 | 本机多人档案，区分管理员和发布者 |
| 身份验证 | 发布者直接切换；切换管理员必须验证本地 PIN |

## 4. 需求清单

所有需求均已由用户批准，或根据用户“后续采用推荐方案”的明确授权完成收敛。

| ID | 状态 | 业务结果 | 依赖 | V1 范围 |
| --- | --- | --- | --- | --- |
| REQ-001 | APPROVED | 用户保留第三方平台的最终发布权 | 无 | 人工发布边界 |
| REQ-002 | APPROVED | 只有有效成片能进入发布流程 | REQ-001 | 成片资格和健康检查 |
| REQ-003 | APPROVED | 生成独立、完整、可搬运的本地发布包 | REQ-002 | 视频、封面、清单和平台文件 |
| REQ-004 | APPROVED | 获得可审核的四平台简体中文发布文案 | REQ-003 | AI 生成、回退、编辑和校验 |
| REQ-005 | APPROVED | 同一作品可维护多个版本和多个独立平台任务 | REQ-003、REQ-004 | 版本、平台选择、内容锁定 |
| REQ-006 | APPROVED | 用户能安排人工发布时间并获得可靠提醒 | REQ-005 | 排期、到期、逾期补处理 |
| REQ-007 | APPROVED | 用户能高效完成平台外的人工交付动作 | REQ-005 | 复制文案、打开平台、定位文件 |
| REQ-008 | APPROVED | 发布状态可恢复、可纠错且完整留痕 | REQ-005、REQ-007、REQ-012 | 状态机、失败、取消、撤回、审计 |
| REQ-009 | APPROVED | 文件与索引在失败和崩溃后保持可恢复一致 | REQ-003、REQ-008 | 原子写、并发控制、启动修复 |
| REQ-010 | APPROVED | 用户能分辨到期、动作失败和资产损坏 | REQ-006、REQ-009 | 通知、健康状态和错误表达 |
| REQ-011 | APPROVED | 用户能控制磁盘增长而不丢失关键历史 | REQ-005、REQ-009、REQ-012 | 归档、垃圾桶、恢复和轻量历史 |
| REQ-012 | APPROVED | 本机多人操作具有角色边界和操作者归属 | 无 | 本地用户、管理员 PIN、权限矩阵 |
| REQ-013 | APPROVED | API 与 UI 形成完整可操作的发布工作流 | REQ-001 至 REQ-012 | 路由、页面、表单、过滤和反馈 |
| REQ-014 | APPROVED | 旧任务和现有生成链路不因发布功能回退 | REQ-002、REQ-009 | 兼容、安全和迁移边界 |

## 5. 子系统边界与实施顺序

本规格包含两个独立但有依赖关系的交付子系统：

1. **本地身份与角色基础设施**：用户档案、管理员 PIN、本地会话、权限判断和操作者快照。该子系统先交付，供所有发布写操作使用。
2. **发布中心**：资格检查、发布包、AI 文案、版本、平台任务、排期、状态机、通知、垃圾桶和 UI。该子系统依赖身份基础设施。

后续实施计划必须拆成两个可独立验收的阶段。身份阶段不能包含发布业务；发布阶段不能重新实现身份验证。

## 6. 本地身份与权限

### 6.1 用户模型

```typescript
type LocalUserRole = "admin" | "publisher";

interface LocalUser {
  id: string;
  displayName: string;
  role: LocalUserRole;
  isActive: boolean;
  pinSalt?: string;
  pinHash?: string;
  createdAt: string;
  updatedAt: string;
}

interface ActorSnapshot {
  userId: string;
  displayName: string;
  role: LocalUserRole | "system";
}
```

- 首次启动且不存在用户时，必须完成管理员引导后才能执行发布写操作。
- 管理员 PIN 为 6 至 12 位数字，使用 Node.js `scrypt`、独立随机盐和恒定时间比较；不得保存明文或可逆密文。
- 发布者档案不设置 PIN，可以直接选择。
- 切换管理员必须验证 PIN。会话令牌只保存在后端内存中，切换用户或退出应用后失效。
- 用户索引保存于 `cache/local-users.json`，当前选中的发布者可保存在应用配置中；管理员会话不得持久化。
- 排期到期、启动恢复和垃圾桶过期清理使用固定操作者快照 `{ userId: "system", displayName: "系统", role: "system" }`；`system` 不是可登录用户，也不能出现在用户切换器中。
- 至少保留一个启用的管理员。最后一个启用管理员不能被停用或降级。
- 活跃管理员可以创建、停用、重命名用户，并重置其他管理员 PIN。
- 唯一管理员遗忘 PIN 时，提供“重置本地身份系统”恢复流程：必须输入固定确认文本；只重建用户档案，不删除发布包、任务或历史操作者快照。该流程是本机恢复工具，不是强安全机制。

### 6.2 权限矩阵

| 操作 | 发布者 | 管理员 |
| --- | --- | --- |
| 查看发布中心和历史 | 允许 | 允许 |
| 创建发布包或新版本 | 允许 | 允许 |
| 编辑未发布平台文案和排期 | 允许 | 允许 |
| 取消、恢复、记录失败 | 允许 | 允许 |
| 打开平台、复制文案、定位文件 | 允许 | 允许 |
| 标记已发布 | 允许 | 允许 |
| 撤回已发布状态 | 禁止 | 允许 |
| 删除发布包到垃圾桶 | 禁止 | 允许 |
| 恢复垃圾桶中的发布包 | 禁止 | 允许 |
| 创建、停用、重命名用户 | 禁止 | 允许 |
| 重置管理员 PIN | 禁止 | 允许 |

权限必须由 Express 服务端验证，不能只依赖前端隐藏按钮。所有发布写请求携带内存会话令牌；服务端从会话解析操作者，不接受客户端直接提交的角色或操作者姓名。

该模型是本机工作流约束，不承诺抵御拥有本机文件系统或调试权限的恶意用户。

## 7. 发布领域模型

```typescript
type PublishPlatform = "douyin" | "xiaohongshu" | "wechat_channels" | "bilibili";
type PublishTaskStatus = "scheduled" | "ready" | "published" | "failed" | "cancelled";
type PublishPackageState = "active" | "trashed" | "purged";
type PublishCopySource = "ai" | "cleaned_fallback" | "user_edited";
type PackageVideoMethod = "clone" | "copy";

interface DeliveryPackage {
  id: string;
  sourceJobId: string;
  version: number;
  state: PublishPackageState;
  title: string;
  packagePath: string;
  videoPath?: string;
  coverPath?: string;
  videoSha256: string;
  videoSize: number;
  videoMethod: PackageVideoMethod;
  assetHealth: "healthy" | "missing_cover" | "broken_video";
  createdBy: ActorSnapshot;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  purgeAt?: string;
  purgedAt?: string;
}

interface PublishTask {
  id: string;
  packageId: string;
  platform: PublishPlatform;
  title: string;
  description: string;
  hashtags: string[];
  copySource: PublishCopySource;
  status: PublishTaskStatus;
  scheduledAt?: string;
  dueNotifiedAt?: string;
  publishedAt?: string;
  lastError?: string;
  contentRevision: number;
  createdAt: string;
  updatedAt: string;
}

interface PublishAuditEvent {
  id: string;
  packageId: string;
  taskId?: string;
  action: string;
  actor: ActorSnapshot;
  fromStatus?: PublishTaskStatus;
  toStatus?: PublishTaskStatus;
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
```

`cache/publishing-index.json` 是包、平台任务、版本计数器、审计事件和轻量墓碑的唯一业务真相源。文件夹中的 `manifest.json` 和文本文件是可交付投影，不可反向覆盖索引。

## 8. 发布包结构与资产规则

```text
output/publishing/{sourceJobId}/v{version}-{packageId}/
├── video.mp4
├── cover.jpg                         # 可选
├── manifest.json
└── platforms/
    ├── douyin/
    │   ├── title.txt
    │   ├── description.txt
    │   ├── hashtags.txt
    │   └── publish.txt
    ├── xiaohongshu/...
    ├── wechat_channels/...
    └── bilibili/...
```

- 只有能解析到存在、可读、非空 MP4 的任务才显示“加入发布中心”。
- 创建时计算 SHA-256 和文件大小。视频优先使用 `COPYFILE_FICLONE`，不支持或失败时使用普通复制。
- 每个包只有一份 `video.mp4`，同包平台任务共同引用。V1 不做裁剪、码率调整、分辨率转换或重新渲染。
- 发布包创建成功后独立于源任务；删除源任务或源成片不能破坏发布包。
- 封面优先复用可读本地封面；否则用 FFmpeg 抽取第 1 秒。封面失败时保留 `missing_cover` 健康状态并继续创建。
- 不生成渐变或文字占位封面。无封面时，打开平台前持续提醒用户在平台内选择封面。
- `manifest.json` 包含 schema 版本、源任务、发布包版本、视频校验值、资产路径、平台文案快照、创建者和创建时间，不包含 PIN、API Key、平台账号或 Cookie。

## 9. 平台文案

### 9.1 AI 输入与输出

- 首次预览用一次 AI 请求生成所有已选平台文案，不为每个平台重复发送完整输入。
- 输入只包含洗稿标题、摘要、关键要点、短视频脚本和标签；不得发送完整原始转录、分镜生产术语或视频提示词。
- AI 输出必须是结构化 JSON、简体中文，并为每个平台返回 `title`、`description`、`hashtags`。
- 单个平台“重新生成”只请求该平台，不覆盖其他平台内容。
- AI 未配置、超时、连接失败或 JSON 校验失败时，使用洗稿标题、摘要和标签生成回退内容，并明确标记 `cleaned_fallback`。
- 用户首次编辑后标记 `user_edited`。AI 回退不是错误终态，也不能阻止保存发布包。

### 9.2 V1 本地保守校验策略

这些是应用自己的稳定输入限制，不宣称等同于第三方平台实时规则。平台实际规则变化时，用户仍以平台页面为准。

| 平台 | 标题 | 正文 | 标签 |
| --- | --- | --- | --- |
| 抖音 | 必填，1-55 字符 | 0-1000 字符 | 最多 10 个，每个 1-20 字符 |
| 小红书 | 必填，1-20 字符 | 0-1000 字符 | 最多 10 个，每个 1-20 字符 |
| 微信视频号 | 必填，1-30 字符 | 0-1000 字符 | 最多 10 个，每个 1-20 字符 |
| 哔哩哔哩 | 必填，1-80 字符 | 0-2000 字符 | 最多 10 个，每个 1-20 字符 |

- 校验按 Unicode 字符计数，保存前 trim；空标签、重复标签和标签前导 `#` 在保存时标准化。
- 系统不得静默截断用户编辑内容。超限时显示平台、字段、当前长度和限制。
- 复制 `publish.txt` 时使用“标题 + 空行 + 正文 + 空行 + `#标签`”格式；空正文或空标签不产生多余段落。

## 10. 版本与编辑规则

- 同一源任务可以创建多个版本，版本号从 1 开始单调递增。垃圾桶或永久清理后的版本号不复用。
- 每个版本拥有独立目录、平台集合、文案、排期、状态和审计。
- 创建新版本时可以复制上一版文案和平台选择，但所有平台状态按新排期初始化为 `ready` 或 `scheduled`，不得复制 `published`、`failed` 或 `cancelled`。
- `scheduled`、`ready`、`failed`、`cancelled` 平台内容可编辑。已发布平台的文案、视频校验值和封面快照锁定。
- 同包某个平台已发布，不影响其他未发布平台继续编辑。
- 修改已发布内容必须基于原包创建新版本。
- 编辑排期为未来时间时状态转为 `scheduled`；清空排期或设置为当前/过去时间时转为 `ready`。
- 使用 `contentRevision` 做乐观并发控制。客户端提交旧 revision 时返回 409，不覆盖较新的修改。

## 11. 排期、通知与人工交付

- 未设置排期的平台任务创建为 `ready`；未来时间创建为 `scheduled`。
- 应用运行时每 30 秒检查一次到期任务；应用启动、发布中心加载和从休眠恢复时立即补检查。
- 到期任务原子转为 `ready` 并设置 `dueNotifiedAt`，然后发送一次系统通知。
- 应用关闭期间不承诺准时通知。下次启动补处理时显示原计划时间和逾期时长。
- `dueNotifiedAt` 已存在时不得重复通知。用户重新排期到未来后清空它，允许新排期再次通知。
- 到期不会打开平台、上传文件或提交发布。

每个 `ready` 任务提供：

1. 复制标题。
2. 复制正文。
3. 复制标签。
4. 复制完整发布文案。
5. 在 Finder 中显示 `video.mp4`。
6. 打开目标平台官方创作入口。
7. 标记已发布。
8. 记录发布失败。
9. 取消或重新排期。

打开网页或 Finder 失败属于动作错误，记录审计并显示可重试错误，但不得自动把平台任务改成 `failed`。平台上传被拒绝或用户确认本次发布失败时，才由用户填写原因并转为 `failed`。

## 12. 状态机与审计

### 12.1 允许迁移

| 当前状态 | 允许目标 | 触发条件 |
| --- | --- | --- |
| `scheduled` | `ready` | 到期、清空排期或改为已到期时间 |
| `scheduled` | `cancelled` | 用户确认取消 |
| `scheduled` | `failed` | 用户记录实际发布准备失败并填写原因 |
| `ready` | `scheduled` | 设置未来排期 |
| `ready` | `published` | 用户确认平台已成功发布 |
| `ready` | `failed` | 用户填写失败原因 |
| `ready` | `cancelled` | 用户确认取消 |
| `failed` | `ready` | 用户重试且不设置未来排期 |
| `failed` | `scheduled` | 用户重试并设置未来排期 |
| `failed` | `cancelled` | 用户放弃本次任务 |
| `cancelled` | `ready` | 用户恢复且不设置未来排期 |
| `cancelled` | `scheduled` | 用户恢复并设置未来排期 |
| `published` | `ready` | 管理员输入原因并确认撤回；不影响平台真实视频 |

不存在 `publishing` 状态，因为应用无法观察第三方网页中的上传过程。任何未列出的迁移返回 409，当前状态不变。

### 12.2 审计规则

- 所有写操作追加不可变审计事件，至少包含操作者快照、动作、时间、实体、前后状态和原因。
- 标记已发布需要二次确认，设置 `publishedAt`；撤回需要管理员权限、二次确认和必填原因。
- 撤回只修正本地记录，界面必须明确说明不会删除或修改平台上的真实视频。
- 取消需要确认；恢复保留原取消事件。取消不删除文件，不参与排期和通知。
- 审计事件与状态变更必须在同一次原子索引写入中完成。

## 13. 持久化、一致性与恢复

- 使用 `cache/local-users.json` 和 `cache/publishing-index.json`。所有索引写入采用同目录临时文件、flush、原子 rename。
- 发布索引的所有变更经过单进程写队列，包版本分配再加 sourceJobId 级互斥，避免重复版本。
- 创建包流程：验证输入 → 创建 `.next-{packageId}` → 克隆/复制视频 → 处理封面 → 写投影与 manifest → 原子 rename 正式目录 → 原子写索引。
- 正式目录 rename 后索引写入失败时删除新目录；删除失败则在启动扫描中识别为孤儿目录。
- 创建过程中任何失败都不创建正式包记录，并尽力清理 `.next-*`。
- 文案编辑以发布索引为真相源。平台文本先写入临时投影目录并交换；索引提交失败时恢复旧投影。启动时根据索引修复缺失或过期文本投影。
- 启动扫描执行：清理过期 `.next-*`、识别孤儿目录、检查活动包 MP4、修复文本投影、处理到期任务、清理过期垃圾桶。
- 活动包 MP4 缺失、为空或校验失败时标记 `broken_video`，禁用打开文件和标记已发布。不得自动改变平台任务状态。
- 索引 JSON 无法解析时先保留原文件副本并停止发布写操作，显示恢复指引；不得自动覆盖为空索引。
- 磁盘空间不足、权限不足、文件锁定等错误显示安全路径和修复建议，不泄露 PIN 或 API Key。

## 14. 垃圾桶与轻量历史

- 管理员可以把任意活动发布包软删除到发布垃圾桶；包内所有平台任务一起进入不可调度状态。
- 删除前必须确认。存在已发布任务时额外提示：只删除本地资产，不会删除平台视频。
- `deletedAt` 与 `purgeAt = deletedAt + 30 天` 一次写入。垃圾桶中不检查排期、不发送通知、不允许编辑或标记发布。
- 30 天内管理员可恢复，恢复后保留原状态、排期和审计。已过期排期立即按补处理规则转为 `ready`。
- 到期清理删除 MP4、封面、manifest 和平台文本，包状态变为 `purged`。
- 清理后保留轻量墓碑：包 ID、源任务 ID、版本、平台、最终状态、创建/发布/删除/清理时间、视频校验值和审计摘要。
- 清理失败保留 `trashed` 状态和错误，下次启动重试；不能谎报 `purged`。
- 发布包删除不删除源任务；源任务删除不删除发布包。

## 15. API 设计

### 15.1 本地身份 API

```text
GET    /api/local-users
POST   /api/local-users/bootstrap
POST   /api/local-users/recover
POST   /api/local-users
PATCH  /api/local-users/:id
POST   /api/local-users/:id/reset-pin
POST   /api/local-sessions
DELETE /api/local-sessions/current
GET    /api/local-sessions/current
```

- `bootstrap` 只在不存在用户时可调用，否则返回 409。
- `recover` 只接受固定确认文本、新管理员姓名和新 PIN；成功后替换本地用户档案、清空所有会话并创建新管理员，但不得修改发布索引、发布包或历史操作者快照。
- `POST /local-sessions` 对发布者不要求 PIN，对管理员要求 PIN；成功返回不持久化的随机会话令牌。
- 管理员 API 与发布写 API 必须验证 `X-Local-Session`。
- 身份验证失败统一返回安全错误，不返回 PIN 哈希、盐或用户枚举细节。

### 15.2 发布 API

```text
POST   /api/jobs/:id/publishing/preview
POST   /api/publishing/packages
GET    /api/publishing/packages
GET    /api/publishing/packages/:id
POST   /api/publishing/due/check
POST   /api/publishing/packages/:id/versions
PATCH  /api/publishing/tasks/:id/content
PATCH  /api/publishing/tasks/:id/schedule
POST   /api/publishing/tasks/:id/cancel
POST   /api/publishing/tasks/:id/restore
POST   /api/publishing/tasks/:id/mark-published
POST   /api/publishing/tasks/:id/withdraw
POST   /api/publishing/tasks/:id/record-failure
POST   /api/publishing/tasks/:id/action-error
DELETE /api/publishing/packages/:id
POST   /api/publishing/packages/:id/restore
```

- `preview` 做资格检查和 AI/回退文案预览，不写正式包或平台任务。
- `due/check` 不要求用户会话，只允许使用固定系统身份执行 `scheduled -> ready`、设置 `dueNotifiedAt` 并返回本次通知项；它不能执行其他迁移。
- `action-error` 只接受 `open_platform` 或 `show_in_finder` 动作及安全错误摘要，追加审计但不得改变平台任务状态。
- 创建正式包时再次验证源 MP4、平台、文案、排期和客户端 revision，不能信任旧预览。
- 列表支持状态、平台、源任务、版本、创建者和文本搜索过滤。
- 400 表示输入校验，401 表示没有有效本地会话，403 表示角色无权，404 表示实体不存在，409 表示状态/revision/版本冲突，422 表示资产不可交付，500 表示本地持久化错误。
- Axios 客户端优先展示后端简体中文 `message` 和稳定 `code`，不直接展示通用状态文本。

## 16. UI 设计

### 16.1 身份入口

- 首次启动显示本地管理员初始化界面，而不是允许匿名执行发布写操作。
- 顶部右侧显示当前操作者头像占位、姓名和角色；点击后可切换发布者或输入 PIN 切换管理员。
- 设置页新增“本地用户”分组。发布者只能查看；管理员可以创建、停用、重命名和重置 PIN。
- 无有效会话时可以查看创作内容，但所有发布写操作要求先选择操作者。

### 16.2 创建发布包

成片区域在视频存在且健康时显示“加入发布中心”。创建流程为：

1. **资产检查**：视频、尺寸、时长、大小、封面候选和预计额外占用。
2. **平台选择**：固定四个平台，至少选择一个，不允许重复。
3. **文案审核**：并排展示平台标题、正文、标签、来源与长度；支持单平台重新生成。
4. **排期**：每个平台独立选择立即或未来时间。
5. **确认**：展示包版本、平台数、警告和文件位置后创建。

AI 失败时文案审核页展示回退提示而非错误终止。成功后提供“前往发布中心”和“继续查看成片”，不强制跳转。

### 16.3 发布中心

- 导航新增“发布中心”。页面按作品聚合版本，默认显示需要行动的任务。
- 顶部筛选：全部、待发布、已排期、已发布、失败、已取消、资产异常、垃圾桶。
- 列表字段：封面、作品与版本、平台、文案来源、计划时间、状态、操作者、下一步和操作。
- 平台任务展开后显示可复制文案、审计时间线和资产健康信息。
- 管理员操作在 UI 中明确标识；权限不足时按钮禁用并说明所需角色。
- 垃圾桶是发布中心内的独立视图，不混入现有作品垃圾桶；两者保留独立领域和清理规则。

## 17. 错误与用户反馈

| 稳定错误码 | 用户结果 |
| --- | --- |
| `publish_video_missing` | 阻止预览或创建，提示重新生成成片 |
| `publish_video_unreadable` | 阻止创建，显示安全文件路径和权限建议 |
| `publish_clone_failed` | 自动尝试复制；复制也失败后阻止创建 |
| `publish_cover_missing` | 允许继续，显示无封面警告 |
| `publish_copy_ai_fallback` | 使用洗稿回退并标记来源，不算创建失败 |
| `publish_validation_failed` | 定位平台和字段，显示当前值与限制 |
| `publish_permission_denied` | 不执行操作，说明需要管理员或发布者会话 |
| `publish_invalid_transition` | 返回当前状态和允许操作，不修改记录 |
| `publish_revision_conflict` | 要求刷新并重新确认，绝不覆盖新内容 |
| `publish_storage_full` | 回滚临时文件，保留旧数据 |
| `publish_index_corrupt` | 发布写操作进入只读保护，保留损坏文件 |
| `publish_asset_broken` | 禁用发布动作，平台状态保持不变 |
| `publish_external_open_failed` | 允许重试，不把任务标为发布失败 |
| `local_user_pin_invalid` | 不建立管理员会话，不泄露 PIN 细节 |

所有用户可见文案使用简体中文。日志可以包含内部堆栈，但界面不得展示 API Key、PIN 哈希、Cookie 或完整敏感配置。

## 18. 兼容与迁移

- 现有 `JobRecord`、四步 Pipeline、成片预览和下载接口保持不变。
- 发布中心是成片后的独立领域，不给旧任务添加发布步骤或修改原任务状态。
- 旧任务不做批量迁移；只要其 MP4 当前可访问，就能按新流程创建发布包。
- 现有作品垃圾桶不级联删除发布包。永久删除作品前只提示存在独立发布版本，不代替发布包清理。
- 不接入仓库中的历史 Python/SQLite 后端，不使用 PostgreSQL。
- Electron 能使用 `openExternal`、`showItemInFolder` 和系统通知；普通浏览器开发模式不支持 Finder 定位时显示明确降级提示。
- AI 配置沿用现有动态解析机制；发布文案调用不得改变 AI 洗稿或生成分镜行为。

## 19. 验收标准

### 19.1 发布边界与平台

- **AC-001 / REQ-001** Given 用户拥有有效成片，When 创建发布包，Then 应用只生成本地资产和人工动作，不上传第三方平台。
- **AC-002 / REQ-001** Given 发布任务待处理，When 用户操作，Then 可复制文案、定位文件和打开平台。
- **AC-003 / REQ-001** Given 任意发布包，Then 文件和索引不包含平台账号、密码、Cookie 或平台 API Key。
- **AC-004 / REQ-001** Given 平台已由用户成功发布，When 用户确认标记，Then 才进入 `published`。
- **AC-005 / REQ-005** Given 创建发布包，Then 可选平台仅为抖音、小红书、视频号、哔哩哔哩。
- **AC-006 / REQ-005** Given 平台选择，When 为空或重复，Then 保存失败并定位错误。
- **AC-007 / REQ-005** Given 选择多个平台，Then 每个平台独立保存文案、排期和状态。
- **AC-008 / REQ-005** Given 一个平台失败或取消，Then 其他平台状态保持不变。
- **AC-009 / REQ-005** Given V1 设置，Then 不存在自定义平台入口。

### 19.2 资格与资产

- **AC-010 / REQ-003** Given 一个发布包，Then 目录中只有一份标准 `video.mp4`。
- **AC-011 / REQ-003** Given 多个平台任务，Then 都引用同包视频且不生成平台副本。
- **AC-012 / REQ-003** Given 新增、取消或重试平台任务，Then 不触发视频重渲染或转码。
- **AC-013 / REQ-003** Given 平台适配，Then 只改变文案、标签和排期。
- **AC-014 / REQ-002** Given MP4 缺失、不可读或为空，Then 不显示可执行创建动作或返回 422。
- **AC-039 / REQ-003** Given 包创建成功，Then `video.mp4` 独立可读取。
- **AC-040 / REQ-003** Given文件系统支持克隆，Then 使用克隆；Given 不支持，Then 自动复制。
- **AC-041 / REQ-003** Given 四平台任务，Then 共享包内同一视频路径。
- **AC-042 / REQ-003** Given 源任务随后删除，Then 已建发布包仍可使用。
- **AC-043 / REQ-009** Given 克隆和复制均失败，Then 不存在正式包记录。
- **AC-044 / REQ-009** Given 创建失败，Then `.next-*` 半成品被清理或在启动恢复时处理。
- **AC-045 / REQ-003** Given 包创建成功，Then manifest 记录源、版本、校验值、方法、大小和操作者。
- **AC-046 / REQ-003** Given 有可读本地封面，Then 优先复用。
- **AC-047 / REQ-003** Given 无可用封面，When FFmpeg 可用，Then 抽取第 1 秒。
- **AC-048 / REQ-010** Given 抽帧失败，Then 包创建成功并显示 `missing_cover`。
- **AC-049 / REQ-003** Given 缺少封面，Then 平台任务仍可进入 `ready`。
- **AC-050 / REQ-010** Given 无封面任务打开平台，Then 提醒用户在平台选封面。
- **AC-051 / REQ-003** Given 无真实封面，Then 不生成伪装占位封面。

### 19.3 文案与版本

- **AC-015 / REQ-004** Given 选择多个平台，Then 一次首次 AI 请求返回各平台独立文案。
- **AC-016 / REQ-004** Given 文案预览，Then 用户保存前可编辑全部字段。
- **AC-017 / REQ-004** Given AI 失败，Then 使用洗稿回退且允许继续。
- **AC-018 / REQ-004** Given 任意文案，Then 来源显示为 AI、洗稿回退或用户编辑。
- **AC-019 / REQ-004** Given 单平台重新生成，Then 其他平台已编辑内容不变。
- **AC-020 / REQ-004** Given 文案超出本地策略，Then 显示字段级错误并禁止保存。
- **AC-059 / REQ-005** Given 同一源任务重复创建，Then 形成独立递增版本。
- **AC-060 / REQ-005** Given 旧版本被清理，Then 其版本号不复用。
- **AC-061 / REQ-005** Given 两个版本，Then 平台、文案、排期和状态互不影响。
- **AC-062 / REQ-005** Given 创建新版本，Then 不重置或取消旧版本任务。
- **AC-063 / REQ-013** Given 发布中心列表，Then 按作品聚合且显示版本号。
- **AC-064 / REQ-003** Given 多版本视频内容相同，Then 校验值可相同但目录独立。
- **AC-065 / REQ-005** Given 平台未发布，Then 可编辑其文案。
- **AC-066 / REQ-006** Given 修改排期，Then 根据时间在 `scheduled` 与 `ready` 间正确迁移。
- **AC-067 / REQ-005** Given 平台已发布，Then 内容与资产快照不可编辑。
- **AC-068 / REQ-005** Given 同包一个平台已发布，Then 其他未发布平台仍可编辑。
- **AC-069 / REQ-005** Given 需要修改已发布内容，Then 只能创建新版本。
- **AC-070 / REQ-005** Given 从旧版创建新版，Then 不复制旧版终态。

### 19.4 排期、状态与审计

- **AC-021 / REQ-006** Given 平台任务，Then 可选择立即或未来排期。
- **AC-022 / REQ-006** Given 未设置未来时间，Then 初始状态为 `ready`。
- **AC-023 / REQ-006** Given 未来排期到达，Then 原子转为 `ready`。
- **AC-024 / REQ-010** Given 首次到期，Then 发送一次系统通知。
- **AC-025 / REQ-001** Given 到期，Then 不自动打开、上传或发布。
- **AC-026 / REQ-006** Given 同包多平台，Then 可使用不同排期。
- **AC-027 / REQ-006** Given 应用运行，Then 每 30 秒检查到期任务。
- **AC-028 / REQ-006** Given 应用启动或恢复，Then 立即补处理过期任务。
- **AC-029 / REQ-010** Given 补处理逾期任务，Then 显示原时间和逾期时长。
- **AC-030 / REQ-010** Given `dueNotifiedAt` 已存在，Then 重启不重复通知。
- **AC-031 / REQ-006** Given 应用完全退出，Then 产品不承诺实时通知。
- **AC-032 / REQ-014** Then V1 不创建托盘或 OS 计划任务。
- **AC-033 / REQ-008** Given 标记已发布，Then 必须二次确认。
- **AC-034 / REQ-008** Given 标记成功，Then 保存发布时间和操作者快照。
- **AC-035 / REQ-008** Given 已发布任务，When 管理员确认撤回，Then 回到 `ready`。
- **AC-036 / REQ-008** Given 撤回，Then 明确提示不会影响平台真实视频。
- **AC-037 / REQ-008** Given 状态变化，Then 追加审计，不覆盖旧事件。
- **AC-038 / REQ-009** Given 刷新或重启，Then 状态与审计保持一致。
- **AC-071 / REQ-008** Given `scheduled` 或 `ready`，Then 可以确认取消。
- **AC-072 / REQ-008** Given 取消，Then 记录时间、操作者和原状态。
- **AC-073 / REQ-006** Given 已取消任务，Then 不参与排期或通知。
- **AC-074 / REQ-008** Given 恢复取消任务，Then 可进入 `ready` 或重新 `scheduled`。
- **AC-075 / REQ-008** Given 恢复，Then 原取消审计仍存在。
- **AC-076 / REQ-003** Given 取消单个平台，Then 不删除资产或影响其他平台。

### 19.5 人工动作、权限和清理

- **AC-077 / REQ-007** Given 待发布任务，When 打开平台，Then 使用该平台配置的官方创作入口。
- **AC-078 / REQ-007** Given 平台文案，Then 可分别复制标题、正文、标签或完整文案。
- **AC-079 / REQ-007** Given Electron 环境，Then 可在 Finder 显示视频；浏览器环境显示能力降级。
- **AC-080 / REQ-010** Given 打开平台或 Finder 失败，Then 显示可重试错误且不改变发布状态。
- **AC-081 / REQ-008** Given 用户记录失败，Then 原因必填并转为 `failed`。
- **AC-082 / REQ-008** Then 状态模型不存在无法验证的 `publishing` 中间态。
- **AC-083 / REQ-010** Given 视频资产损坏，Then 禁用发布动作但保留任务状态和历史。
- **AC-084 / REQ-012** Given 无本地用户，Then 首次发布写操作前必须建立管理员。
- **AC-085 / REQ-012** Given 用户档案，Then 包含唯一 ID、姓名、角色、启用状态和时间。
- **AC-086 / REQ-012** Given 启用发布者，Then 可无需 PIN 切换。
- **AC-087 / REQ-012** Given 切换管理员，Then 正确 PIN 才建立会话。
- **AC-088 / REQ-012** Given 用户索引，Then 不包含明文或可逆 PIN。
- **AC-089 / REQ-012** Given 切换用户或退出应用，Then 管理员会话失效。
- **AC-090 / REQ-012** Given 只剩一个启用管理员，Then 禁止停用或降级。
- **AC-091 / REQ-012** Given 发布者调用管理员 API，Then 服务端返回 403 且不写数据。
- **AC-092 / REQ-008** Given 用户发起写操作，Then 审计使用服务端会话解析的操作者快照；Given 自动到期或清理，Then 使用固定系统快照。
- **AC-093 / REQ-012** Given 唯一管理员遗忘 PIN，Then 身份重置保留发布数据和历史快照。
- **AC-094 / REQ-012** Given PIN 错误，Then 不返回哈希、盐或敏感配置。
- **AC-052 / REQ-011** Given 管理员删除包，Then 包和任务原子进入发布垃圾桶。
- **AC-053 / REQ-011** Given 包含已发布任务，Then 删除前显示额外平台不受影响警告。
- **AC-054 / REQ-011** Given 垃圾桶任务，Then 不检查排期或通知。
- **AC-055 / REQ-011** Given 未满 30 天，Then 管理员可恢复完整状态和审计。
- **AC-056 / REQ-011** Given 超过 30 天且清理成功，Then 删除视频、封面和文本。
- **AC-057 / REQ-011** Given 资产清理，Then 保留规定的轻量墓碑和审计摘要。
- **AC-058 / REQ-011** Given 删除源任务或发布包之一，Then 不级联删除另一领域。

### 19.6 API、兼容和全量验证

- **AC-095 / REQ-013** Given 发布预览，Then 不创建包、平台任务或正式目录。
- **AC-096 / REQ-013** Given API 错误，Then 返回稳定 code、简体中文 message 和正确 HTTP 状态。
- **AC-097 / REQ-013** Given 有效成片，Then 五步创建流程可完成资产、平台、文案、排期和确认。
- **AC-098 / REQ-013** Given 发布中心，Then 可按状态、平台、源任务、版本、创建者和文本过滤。
- **AC-099 / REQ-014** Given 旧任务有有效 MP4，Then 无数据迁移即可创建新发布包。
- **AC-100 / REQ-014** Given 发布功能启用，Then 原四步 Pipeline、预览和下载行为不变。
- **AC-101 / REQ-014** Then 发布功能不依赖 PostgreSQL、历史 Python 后端或 SQLite。
- **AC-102 / REQ-004** Then AI 提示词、回退文案、错误和 UI 全部使用简体中文。
- **AC-103 / REQ-009** Given 并发创建同源版本，Then 版本唯一且索引无丢失更新。
- **AC-104 / REQ-009** Given 索引损坏，Then 进入只读保护并保留损坏文件，不初始化为空。

## 20. 测试策略

### 20.1 单元测试

- PIN scrypt 哈希、验证、错误 PIN、最后管理员保护和权限矩阵。
- 平台文案规范化、长度校验、复制格式、简体中文提示词和回退来源。
- 状态迁移表、非法迁移、发布撤回、取消恢复、通知去重和逾期计算。
- 版本递增、平台去重、乐观 revision 冲突和轻量墓碑生成。
- APFS clone 成功、clone 失败复制、双失败回滚和封面非阻塞路径。

### 20.2 后端集成测试

- 用户 bootstrap、会话切换、管理员 PIN、403 和服务端操作者解析。
- 发布预览不落盘，正式创建写完整目录和索引。
- 状态与审计同写，存储失败不产生部分成功。
- 同源并发创建得到不同版本。
- 启动恢复清理临时目录、识别孤儿、修复投影、处理逾期和清理垃圾桶。
- 旧视频 stream/download 接口和四步任务 API 不回退。

### 20.3 前端与桌面测试

- 首次管理员引导、发布者切换、管理员 PIN 和角色按钮状态。
- 五步创建发布包、AI 回退、字段错误定位和单平台重新生成。
- 发布中心所有筛选、复制操作、Finder、外部平台、状态操作和审计时间线。
- 系统通知只出现一次；退出期间错过的排期在重新启动后补处理。
- 发布垃圾桶删除、恢复、过期清理提示和已发布额外警告。

### 20.4 验证命令

```bash
npm run check
npm test
npm run build:backend
npm run build:renderer
npm run build:electron
```

还需在真实 Electron 中执行只读/测试数据流程：创建管理员 → 创建发布者 → 切换操作者 → 从有效成片创建包 → 检查四平台文案 → 设置排期 → 到期通知 → 人工标记发布 → 管理员撤回 → 删除到垃圾桶 → 恢复。

## 21. 非目标

- 第三方平台账号、密码、Cookie、OAuth 或 API Key 管理。
- 浏览器自动填表、自动上传、自动提交或无人值守发布。
- 平台视频转码、裁剪、水印、BGM、字幕烧录或重新渲染。
- 自定义发布平台、平台插件市场或远程适配器。
- 云端同步、远程团队账号、审批流或多人实时协作。
- 托盘常驻、应用退出后的 OS 级计划任务。
- 从平台反查真实发布结果、播放量、审核状态或删除平台视频。
- PostgreSQL、历史 Python 后端或 SQLite 数据迁移。

## 22. 确认记录

### 已确认

- 所有第 3 节产品决策。
- 管理员 PIN 仅用于本机流程控制，服务端仍强制角色权限。
- 两阶段实施：身份基础设施先于发布中心。
- 本规格的 REQ-001 至 REQ-014 与 AC-001 至 AC-104。

### 明确拒绝的解释

- “排期”等于自动发布。
- “人工发布”仍由应用自动上传或填写网页。
- 四个平台各自复制或转码一份视频。
- AI 失败就禁止交付。
- 已发布记录永远不可纠错或可以无痕修改。
- 删除发布包同时删除平台视频或源作品。
- 本地角色等同于强安全隔离或云端团队权限。

### 假设与降级

- 主要运行环境为 macOS；不支持文件克隆时自动复制。
- FFmpeg 是现有视频链路依赖；不可用时仅失去自动抽帧，不阻止无封面发布包。
- 第三方创作入口和真实输入规则可能变化；V1 使用可维护的平台配置与本地保守校验，并由用户在平台最终确认。
- 应用为单 Electron 主进程；所有写操作通过同一 Express 实例和单写队列。

### 未决问题

无。不存在阻塞实施的产品、权限、状态、失败处理、兼容或数据保留问题。

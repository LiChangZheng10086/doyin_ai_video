/**
 * 只读：按**真实的发布中心索引**打印每个渠道页签 / 内容类型子页签会显示什么。
 *
 * 为什么要有它：页签改版最容易犯的错是「包被藏起来」或「数字算错」，而这两种错
 * 光看用例看不出来 —— 用例里的包是我们自己造的（`contentType`、任务平台都齐全），
 * 真实索引里却有存量包（没有 `contentType` 字段）、多平台包、垃圾桶里的包。
 * 这个脚本把真实数据喂给**页面用的同一批纯函数**，把结果打出来对照。
 *
 * 用法：
 *   node --import tsx scripts/verify-publishing-channels.ts
 *   node --import tsx scripts/verify-publishing-channels.ts --index <publishing-index.json>
 *
 * **零副作用**：只读文件、只打印，不调任何接口、不写任何东西。
 * 索引位置（桌面端）：`<storage>/cache/publishing-index.json`，见 AGENTS.md 的
 * 「数据存储」一节（Electron 下 storage 在 `~/Library/Application Support/douyin-ai-video/storage`）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PACKAGE_CONTENT_TYPE_LABELS,
  PUBLISH_CHANNELS,
  channelContentTypes,
  countChannelContentTypes,
  countChannelPackages,
  countStatusesInChannel,
  selectChannelPackages,
} from '../renderer/src/utils/publishing.js';
import type { PublishingPackageDetail } from '../renderer/src/types/index.js';

const DEFAULT_INDEX = path.join(
  os.homedir(),
  'Library/Application Support/douyin-ai-video/storage/cache/publishing-index.json',
);

function indexArg(): string {
  const flag = process.argv.indexOf('--index');
  return flag >= 0 ? (process.argv[flag + 1] ?? DEFAULT_INDEX) : DEFAULT_INDEX;
}

const indexPath = indexArg();
if (!fs.existsSync(indexPath)) {
  console.error(`找不到发布中心索引：${indexPath}`);
  console.error('用 --index <publishing-index.json> 指定路径。');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
  packages?: Record<string, PublishingPackageDetail['package']>;
  tasks?: Record<string, PublishingPackageDetail['tasks'][number]>;
  audit?: Record<string, PublishingPackageDetail['audit']>;
};

// 与 `PublishingStore.list()` 同一形状：{ package, tasks, audit }[]。
const details: PublishingPackageDetail[] = Object.values(raw.packages ?? {}).map((pkg) => ({
  package: pkg,
  tasks: Object.values(raw.tasks ?? {}).filter((task) => task.packageId === pkg.id),
  audit: Object.values(raw.audit ?? {}).filter((entry) => entry.packageId === pkg.id),
}));

console.log(`索引：${indexPath}`);
console.log(`包 ${details.length} 个 / 任务 ${details.reduce((sum, d) => sum + d.tasks.length, 0)} 个\n`);

const channelCounts = countChannelPackages(details);
for (const channel of PUBLISH_CHANNELS) {
  const types = channelContentTypes(details, channel.id);
  const typeCounts = countChannelContentTypes(details, channel.id);
  const statuses = countStatusesInChannel(details, channel.id);
  const shown = selectChannelPackages(details, channel.id);
  const subTabs = types.length > 1
    ? types.map((type) => `${PACKAGE_CONTENT_TYPE_LABELS[type]} ${typeCounts[type] ?? 0}`).join(' / ')
    : `（只有一种类型，不显示子页签：${types.length === 0 ? '无包' : PACKAGE_CONTENT_TYPE_LABELS[types[0]!]}）`;

  console.log(`【${channel.label}】页签数字 ${channelCounts[channel.id] ?? 0}`);
  console.log(`  子页签：${subTabs}`);
  console.log(`  状态计数：待处理 ${statuses.action} / 全部 ${statuses.all} / 失败 ${statuses.failed} / 垃圾桶 ${statuses.trash}`);
  for (const detail of shown) {
    const tasks = detail.tasks
      .filter((task) => channel.platforms.includes(task.platform))
      .map((task) => `${task.platform}:${task.status}`)
      .join(', ');
    console.log(`  · ${detail.package.title} v${detail.package.version} [${detail.package.contentType ?? 'video(缺省)'}] ${tasks}`);
  }
  if (shown.length === 0) console.log('  （空态）');
  console.log('');
}

// 隐藏检查：**任何**一个包至少要出现在一个页签里，否则它在界面上就永远看不见。
const hidden = details.filter(
  (detail) => PUBLISH_CHANNELS.every((channel) => selectChannelPackages([detail], channel.id).length === 0),
);
if (hidden.length > 0) {
  console.error(`❌ 有 ${hidden.length} 个包不属于任何页签（界面上看不见）：`);
  for (const detail of hidden) {
    console.error(`   ${detail.package.id} type=${detail.package.contentType ?? '(缺省)'} tasks=${detail.tasks.map((t) => t.platform).join(',') || '无任务'}`);
  }
  process.exitCode = 1;
} else {
  console.log('✅ 每个包都至少属于一个页签（没有包被藏起来）。');
}

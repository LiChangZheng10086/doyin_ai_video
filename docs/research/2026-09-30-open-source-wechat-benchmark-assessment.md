# 微信公众号模板与对标发现：开源项目筛选

核查日期：2026-09-30。面向抖创工坊，赛道、关键词和目标人群由使用者选择，不预设垂类。

## 结论

文章排版与写作结构有可复用的开源代码。关键词搜索也有实现，但本轮没有找到经过验证、能够稳定完成「任意赛道搜索 → 真实流量筛选 → 至少 10 个有效对标公众号」全流程的免费开源项目。

建议先复用模板与搜索部件，再接受用户提供的账号链接、可核验阅读数据或排行导出。搜索命中只能证明相关文章存在，不能证明账号高流量。官方接口保存草稿继续复用现有实现。

本轮检查了实际源码、许可证、提交记录及关键问题报告；对搜狗公开搜索来源做了一次匿名请求探测。没有登录公众号后台、调用真实草稿接口，也没有安装外部项目依赖。以下“源码可复用”不代表已经在本项目或真实微信编辑器完成验收。

## 优先保留的项目

| 项目 | 能补什么 | 许可与核查版本 | 适用边界 |
| --- | --- | --- | --- |
| [doocs/md](https://github.com/doocs/md) | 微信 Markdown 排版、内联样式、主题与渲染参考 | WTFPL；`a7c17fc4`，2026-09-29 | 编辑器使用 Vue；只借鉴主题与渲染部件，不搬整套界面。仓库内 `@md/core` 为 workspace 包，不能据此保证可直接从 npm 安装。 |
| [delphuy/Wechat-Article-editor](https://github.com/delphuy/Wechat-Article-editor) | TypeScript 模板配置与文章渲染，源码有 21 套排版皮肤 | MIT；`a9c331b2`，2026-07-09 | 适合当前 React/TS 技术栈；模板引擎还有 marked、代码高亮等依赖，不是复制一个文件即可运行。项目较年轻，优先取少量简单皮肤。 |
| [imraywang/wewrite](https://github.com/imraywang/wewrite) | 写作结构、主题配置、关键词搜文章与自有账号数据复盘的参考 | MIT；`3d9e335a`，2026-09-28 | Python 项目；搜狗搜索没有阅读量，`fetch_stats.py` 使用自己账号的凭据与发布记录，不能查询任意竞争账号的后台数据。最新提交为星标图更新，不能单凭日期认定核心链路有效。 |
| [zjp1997720/zhijian-skills 的 wechat-article-search](https://github.com/zjp1997720/zhijian-skills/tree/main/skills/wechat-article-search) | Node.js 搜狗微信文章搜索，返回标题、摘要、时间、来源账号名与链接 | 子目录 MIT；`a523ef1d`，2026-09-14 | 适合研究关键词发现；单次最多 50 篇文章，不是 50 个账号。受限频及验证码影响，没有阅读量。README 将用途限定为研究并提醒不要大规模商业抓取，不能直接把它当成已可上线的数据服务。 |

搜索项目的 [独立仓库](https://github.com/zjp1997720/wechat-article-search) 已注明是兼容镜像，维护与问题跟踪应看上述主仓库。本轮一次公开来源探测：关键词“人工智能”，HTTP 200，HTML 包含结果列表，未发现验证码跳转。该探测只验证此次来源可访问，没有运行项目完整 CLI，也没有验证文章直链解析、跨关键词稳定性或流量数据。

核查入口：

- [doocs/md 许可证](https://github.com/doocs/md/blob/main/LICENSE)及 [渲染核心](https://github.com/doocs/md/blob/main/packages/core/src/renderer/renderer-impl.ts)。
- [21 套模板与渲染实现](https://github.com/delphuy/Wechat-Article-editor/blob/main/app/template-engine.ts)。
- [wewrite 搜索源码](https://github.com/imraywang/wewrite/blob/main/src/wewrite/commands/search_articles.py)明确说明不带阅读量；[统计源码](https://github.com/imraywang/wewrite/blob/main/src/wewrite/commands/fetch_stats.py)用于自有账号复盘。
- [Node 搜索源码，固定核查版本](https://github.com/zjp1997720/zhijian-skills/blob/a523ef1d641af4320f5da47efdbef0a2eca79f7b/skills/wechat-article-search/scripts/search_wechat.js)与 [MIT 许可证](https://github.com/zjp1997720/zhijian-skills/blob/a523ef1d641af4320f5da47efdbef0a2eca79f7b/skills/wechat-article-search/LICENSE)。

## 两种模板要分别提供

**写作模板**决定文章组织：教程步骤、问题解决、清单、案例、比较、观点、资讯解读等。用户先选目的与读者，模板辅助组织内容；事实来自可追溯材料。

**排版模板**决定标题、正文、引语、配图及分隔线样式。可以先提供极简阅读、教程步骤、商务简报、日报资讯几套，再由用户自行选择。赛道与排版不绑定。

当前 `src/lib/wechat-article.ts` 已有固定样式的微信 HTML 渲染、白名单清洗和正文图占位机制。直接导入外部模板 HTML 会被现有清洗器去掉样式。最小接入方式是把经过审查的模板转成内部可信样式配置，在清洗之后应用；图片继续走现有微信上传与槽位替换，预览指纹应包含模板选择。

现有公众号草稿发送链路保留；无需引入另一套发布器。模板在本地预览成功以后，仍需验证实际微信草稿中的样式、图片和正文长度。

## “至少 10 个高流量对标号”需要补的能力

建议用户流程：

1. 用户填写赛道、关键词、目标人群；允许多个关键词，不固化行业。
2. 搜索相关文章，汇总候选账号；同时允许粘贴账号和文章链接、导入账号清单。
3. 能解析到 `biz` 时用它合并账号；无法确认身份时保留待核验状态，不只按昵称去重。
4. 采样近期文章，记录内容相关性、更新频率、阅读与互动数据的来源、时间及样本范围。
5. 有流量证据后，再让用户选至少 10 个对标账号，分析选题、标题、结构、语气和排版。有效候选不足时明确显示不足，不凑数。
6. 用分析结果辅助独立创作，选择写作结构与排版模板，沿用现有官方 API 保存草稿。

数据口径：未知阅读量保存为空，不能填 0；搜索排名、出现频率不能充当阅读量；“10 万+”保留下界标识，不写成精确数字；自有账号后台统计和竞争账号公开数据分开记录。可以默认观察最近 30 天，并允许用户调整；优先比较多篇文章表现，避免一篇爆款决定整个账号质量。

[清博官方数据说明](https://www.gsdata.cn/site/data-open?show=wx,tt,dy,ks)提供公开展示数据的统计口径，并说明前台与后台可能不同、超过 10 万的阅读展示存在上限。它属于第三方数据服务，不是开源项目；如果接受此类来源，应由用户导入可用数据或通过明确授权的接口接入，当前没有确认其免费 API 可用性。

## 不列为生产方案的账号采集项目

- [wechat-article-exporter](https://github.com/wechat-article/wechat-article-exporter)：作者 [停止维护公告](https://github.com/wechat-article/wechat-article-exporter/issues/200)说明核心上游接口关闭，2026-07-30 停止维护；残留手动凭证通道不等于完整替代方案。即使仓库仍有大量星标和更新记录，也排除。
- [wewe-rss](https://github.com/cooderl/wewe-rss)：仓库已于 2026-05-11 归档，排除。
- [rachelos/we-mp-rss](https://github.com/rachelos/we-mp-rss)：MIT，核查到 2026-09-24 的提交；源码确有关键词账号搜索，但依赖公众号后台 token/Cookie 和非官方网页接口。[2026-09-25 的问题报告 #469](https://github.com/rachelos/we-mp-rss/issues/469)仍出现频控与失败回退问题。本轮未做登录实测，不能承诺稳定采集，也不能把它当作高流量排行工具。
- [wufulin/wechat-mp-rss](https://github.com/wufulin/wechat-mp-rss)：MIT，代码有可空阅读/点赞字段与页面提取逻辑，但字段存在不证明真实账号能够返回数据。缺少实测，不列为有效高流量发现方案。
- [qiye45/WechatDownload](https://github.com/qiye45/WechatDownload)：本轮未找到核心应用源码及根许可证；GitHub 上有工具说明与下载不等于可复用的开源代码。
- [WupfAGI/wechat-search-skill](https://github.com/WupfAGI/wechat-search-skill)：本轮未找到根许可证，搜索也不能证明流量；不建议直接复制。

## 项目其它能力的短名单

| 项目 | 对当前项目的实际补充 | 接入限制 |
| --- | --- | --- |
| [mozilla/readability](https://github.com/mozilla/readability) | 提高公开网页正文抽取质量，补充现有正则提取 | Apache-2.0；需要 DOM 环境；保留现有来源地址、DNS 与响应大小检查。 |
| [fengyuanchen/cropperjs](https://github.com/fengyuanchen/cropperjs) | 给字幕图集取景提供直观拖拽与裁切 | MIT；复用当前归一化裁切坐标与 FFmpeg 输出，不另造图片处理链。 |
| [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 后续需要本地配音时评估 Node TTS | 引擎 Apache-2.0，模型许可单独核查；需要真实中文模型、目标机器和 Electron 打包验证，当前未验收。 |

当前优先级：内部排版模板与写作结构 → 用户可选关键词的候选发现与手动导入 → 有来源的流量核验与对标分析。先补完整的数据口径，再考虑账号订阅和自动更新。

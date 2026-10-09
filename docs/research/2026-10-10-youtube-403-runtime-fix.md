# YouTube 403：桌面端下载器解析修复

实际失败作品 `84a38ba7-8d75-46d6-8d71-954da2cce33c`，来源 https://www.youtube.com/watch?v=EViSmcCPK5g ，视频949秒。系统yt-dlp为2026.03.17，项目已准备资源为2026.08.19；原桌面getBinaryPaths在app.isPackaged=false时写死调用PATH的yt-dlp。NODE_ENV=production只决定加载编译页面，不会让Electron成为打包应用，前次更新资源和重启因此没有改变实际调用的下载器。

修复：Electron所有运行方式尊重显式YTDLP_BINARY；未打包时优先项目vendor/package-assets/bin的已准备文件（Windows .exe），缺失才回退PATH；打包时保留原资源解析。启动日志记录实际二进制路径，不输出Cookie/API Key。不改系统下载器，不自动读取浏览器Cookie。

验证：文件路径／显式覆盖／空值／目录非二进制／Windows后缀／打包后备测试RED→GREEN；相关下载及配置13项回归通过。Electron编译、npm run check及凭据扫描通过。重启后的日志和实际子进程都使用项目2026.08.19。复用实际MediaService及Electron Node runtime下载该来源20秒隔离样本，FFprobe读取1920×1080、20.014秒，成功。

真实作品整段下载已成功落盘328788692字节MP4，并完成一次本地whisper.cpp转录：948.833秒、zh、534段、6485字符，raw-transcript接口200且qualityIssues为空。随后操作者再次触发重新转录，也已完成，最新步骤状态succeeded、stage=transcribed，原转录备份保留；没有启动额外并发任务或后续洗稿／发布。以上结构检查不代表逐句语义正确。

没有重新制作安装包，也未验证其它YouTube视频或非macOS运行环境。403可能有其它平台／网络原因，此记录只覆盖本次实际来源与运行时解析问题。

# 来源、复用与许可证

| 组件 | 来源与版本 | 使用方式 | 许可 |
|---|---|---|---|
| MoonBit core | 编译器配套 core，0.2.0 验证基线 moonc 0.10.15 | JSON、字节、UTF-8、容器等标准库 | Apache-2.0 |
| SHA-256 | [moonbitlang/x](https://github.com/moonbitlang/x)，0.5.5 | 调用公开 crypto API；未自创加密原语 | Apache-2.0 |
| Node.js | 外部 Node ≥ 22.16.0；可选 Windows 桌面包内置精确版本 | 文件/进程、标准 crypto、fetch 和 SQLite backup；内置版保留完整 `runtime/NODE_LICENSE.txt` 与来源/哈希 | [上游许可](https://github.com/nodejs/node/blob/main/LICENSE) |
| Windows 原生启动器 | 原创 `platform/windows/Launcher.cs` | 调用系统 .NET Framework / Windows Forms；不分发系统组件 | 项目代码 Apache-2.0；系统组件按 Windows 条款 |
| C 目录提交辅助程序 | 本项目 `platform/rename_noreplace.c` | Linux renameat2 / macOS renamex_np 排他重命名 | Apache-2.0 |

本项目是原创备份应用，不是 HookLab/MoonMQTT 的改名，也不是 Restic 或 MoonChunk 的代码移植。CDC 使用通用 Gear 滚动指纹思路，确定性表由本项目种子公式生成；指纹只决定分块边界，实际对象身份使用 SHA-256。

0.4 使用 Node 标准 node:sqlite 的在线备份和 SQLite integrity_check，不内嵌第三方数据库绑定；使用标准 crypto/fetch 实现 SigV4 编排，按 AWS 官方公开测试向量验证，不复制 AWS SDK。VSS 生命周期仅参考 Microsoft 文档，尚未提供真实特权请求器。上游 Node 完整 LICENSE 包含其 SQLite 等第三方归属，内置运行时包不得裁剪该许可。设计调研不是移植、兼容性或生产效果背书。

设计调研参考 [Restic CDC 介绍](https://restic.net/blog/2015-09-12/restic-foundation1-cdc/) 和 [MoonChunk](https://github.com/xgzh1111/1234) 的职责边界。未复制两者的源代码，也不兼容其仓库格式。持久仓库、安全恢复和文件系统事务由本项目实现。

完整 Apache-2.0 文本在根目录 `LICENSE`，依赖归属在 `NOTICE` 和 `licenses/`。发布源码和构建产物时同时保留这些材料，不把第三方实现称为本项目自研成果。

认证加密、scrypt、随机数与 HMAC 调用 Node.js 标准 crypto/OpenSSL 接口（外部或可选内置运行时），不内嵌自创密码原语，也未新增 npm 第三方运行依赖。Windows DPAPI 和任务计划程序为操作系统能力；HTML/CSS/JS 本机界面为项目原创，无外部字体、图标、CDN 或遥测资源。未复制 Restic/Kopia 源代码；功能调研参考不代表格式兼容或同等成熟度。

本轮开发仅使用另行下载到私有 npm 缓存的 Prettier 3.6.2（MIT）格式化源码，不随运行包或 Mooncakes 包分发，不是应用依赖。原生启动器调用系统 .NET Framework/WinForms，其系统 DLL 不打包。

可选真实浏览器测试使用操作者另外安装的 [Playwright](https://github.com/microsoft/playwright)（Apache-2.0）与浏览器；不随运行包分发，也不是应用运行依赖。未安装时仍可执行不依赖浏览器的 HTTP 与安全回归测试。

# MoonRestore 0.3.x 运行包

具体版本以 manifest.json 为准。0.3.1 是 GitHub 中文提醒源码补丁，尚未发布 Mooncakes，不应把本地运行包当作注册表正式发布。

普通便携包需外部 Node.js ≥22。若包含 `MoonRestore.exe` 和 `runtime/node.exe`，则为内置运行时的 Windows x64 桌面包，可双击 EXE，无需全局 Node/MoonBit，仍需 Windows .NET Framework 4.x。安装与回退见 `docs/DESKTOP.md`。两种包均无需运行 npm install，EXE 尚未代码签名。

Windows 可双击 `开始使用.cmd`，或在此目录执行：

```sh
node bin/moonrestore.mjs help
node examples/demo.mjs
node examples/scenarios.mjs
```

正常使用：先 `init` 创建不存在的仓库，`backup` 备份源文件夹，`verify` 校验，`restore` 恢复到不存在的新目录。完整命令和维护注意事项见 `docs/OPERATIONS.md` 与 `SECURITY.md`。

此包只适用于其 manifest.json 所列的平台与架构，不要将 Linux/macOS 辅助程序复制到其他平台运行。`manifest.json` 记录包内文件的 SHA-256，源码项目中的 `scripts/verify-package.mjs` 可复核。

也可运行 `node bin/moonrestore.mjs workbench` 启动仅本机的工作台；新任务、报告与密钥封装写入包内 `.local/state/`，不要将已使用的包目录重新公开分发。打包清单不包含这些运行数据。

这些哈希用于损坏检测，不是签名认证。来源和快照 ID 都应从可信渠道取得。默认仓库仍是明文，需显式初始化加密仓库；同盘备份不是硬盘故障保护。新能力与安全边界见 `docs/WORKBENCH.md`、`docs/RECOVERY.md`。

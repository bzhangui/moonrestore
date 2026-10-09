# MoonRestore 0.1.0 便携运行包

这是当前平台的已构建命令行程序，仍需安装 Node.js 22 或以上，不包含 Node 运行时。无需安装 MoonBit 或运行 npm install。不要把它称为无需任何依赖的 Windows EXE。

Windows 可双击 `开始使用.cmd`，或在此目录执行：

```sh
node bin/moonrestore.mjs help
node examples/demo.mjs
node examples/scenarios.mjs
```

正常使用：先 `init` 创建不存在的仓库，`backup` 备份源文件夹，`verify` 校验，`restore` 恢复到不存在的新目录。完整命令和维护注意事项见 `docs/OPERATIONS.md` 与 `SECURITY.md`。

此包只适用于其 manifest.json 所列的平台与架构，不要将 Linux/macOS 辅助程序复制到其他平台运行。`manifest.json` 记录包内文件的 SHA-256，源码项目中的 `scripts/verify-package.mjs` 可复核。

这些哈希用于损坏检测，不是签名认证。来源和快照 ID 都应从可信渠道取得。仓库数据不加密；同盘备份不是硬盘故障保护。

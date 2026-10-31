# MoonRestore 运行包

具体版本以 manifest.json 为准。当前源码/本地包0.12.0，用户已追加授权发布同版本Mooncakes核心库，实际上传与独立消费证据以源码仓库的发布记录为准。本地运行包不等于公开Release，Mooncakes也不提供桌面二进制；本轮仍不公开运行包。

普通便携包需外部 Node.js ≥22.16.0。若包含 `MoonRestore.exe` 和 `runtime/node.exe`，则为内置运行时的 Windows x64 桌面包，可双击 EXE，无需全局 Node/MoonBit，仍需 Windows .NET Framework 4.x。安装与回退见 `docs/DESKTOP.md`。两种包均无需运行 npm install，EXE 尚未代码签名。

Windows 可双击 `开始使用.cmd`，或在此目录执行：

```sh
node bin/moonrestore.mjs help
node examples/demo.mjs
node examples/scenarios.mjs
```

正常使用：先 `init` 创建不存在的仓库，`backup` 备份源文件夹，`verify` 校验，`restore` 恢复到不存在的新目录。完整命令和维护注意事项见 `docs/OPERATIONS.md` 与 `SECURITY.md`。

当前格式/兼容/预算见`docs/RELIABILITY_0_12.md`，新增格式4/5无损换密钥重建、运输归档、双供体修复、独立追加接收、分页S3版本审计和应用恢复契约；均不原地改旧库。format5原生恢复需同平台、明确权限及实际读回，portable为显式有损。S3可复制加密分页库及旧加密库；受控服务不是实际云/跨机证明，非回环联网和保留期分别授权。VSS helper需源码单独编译和已有管理员环境，通用包不含helper、不申请提权；PostgreSQL原生工具另行提供。

工作台“恢复向导”统一能力/元数据预览、新目录恢复、写出续作和声明的应用验收。CLI也可使用：

```sh
node bin/moonrestore.mjs repository-capabilities REPO
node bin/moonrestore.mjs paged-restore-status REPO RESTORE_UUID
node bin/moonrestore.mjs paged-restore-run REPO RESTORE_UUID --recover
node bin/moonrestore.mjs application-validate RESTORED_ROOT PRIVATE_CONTRACT_JSON
```

`--recover`仅在原进程确已退出且租约/身份核查通过时使用；不要删除暂存资料或接管陌生目标。应用契约不启动业务程序、不执行任意脚本/SQL，不保证全业务语义或跨文件原子采集。运输、接收、迁移和白名单并排安装的精确用法见0.12指南，不自动联网/激活/回退私有状态。

此包只适用于其 manifest.json 所列的平台与架构，不要将 Linux/macOS 辅助程序复制到其他平台运行。`manifest.json` 记录包内文件的 SHA-256，源码项目中的 `scripts/verify-package.mjs` 可复核。

也可运行 `node bin/moonrestore.mjs workbench` 启动仅本机的工作台；新任务、报告与密钥封装写入包内 `.local/state/`，不要将已使用的包目录重新公开分发。打包清单不包含这些运行数据。

这些哈希用于损坏检测，不是签名认证。来源和快照 ID 都应从可信渠道取得。默认仓库仍是明文，需显式初始化加密仓库；同盘备份不是硬盘故障保护。新能力与安全边界见 `docs/WORKBENCH.md`、`docs/RECOVERY.md`。

0.6及更早文档为历史用法，不能代替当前发布/功能记录。救援包不包含密钥或原始资料。分页live清单、原生VSS请求器与隔离PostgreSQL物理/WAL/PITR适配已实现，但真实管理员VSS、独立介质/主机、真实云、物理断电和长期生产尚未验证；原生PG仅按专项CI合成集群证据评估。EXE未获可信发布者签名，不以清单摘要或自签密钥冒充可信签名。

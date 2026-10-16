# MoonRestore

## 0.2.0：从备份到实际恢复验证

0.2.0 已发布：新增私有 JSON/离线 HTML 校验报告、隔离恢复演练与恢复后读回、容量预检查、任务与异常变化门禁、本机工作台、标准认证加密、独立仓库复制、保留预览及隔离回收。默认仍不上传数据、不启动公网服务、不自动删除历史。

本轮源码已通过 [Windows/Ubuntu/macOS CI](https://github.com/bzhangui/moonrestore/actions/runs/38866239121)，Mooncakes 0.2.0 已从独立项目下载并通过四目标消费验证。详细范围、校验和与尚未完成的真实环境验证见 [维护报告](docs/QUALITY_REPORT.md) 和 [发布记录](docs/PUBLICATION.md)。

```sh
npm run build
npm run workbench
```

工作台默认绑定 `127.0.0.1:8790`。使用启动时的完整临时会话链接，链接不要公开；浏览器不会将令牌写入本地存储。创建普通仓库、保存任务、立即备份、查看版本和文件、预览恢复、完整校验与演练均使用真实后端，不是假数据演示。参见 [本机工作台与自动任务](docs/WORKBENCH.md)。

新命令示例（路径、快照 ID 需替换为自己的；只操作自己控制的资料）：

```sh
node bin/moonrestore.mjs report E:/paper-vault all
node bin/moonrestore.mjs drill E:/paper-vault SNAPSHOT_ID
node bin/moonrestore.mjs capacity E:/paper-vault D:/papers
node bin/moonrestore.mjs replicate E:/paper-vault F:/second-vault
node bin/moonrestore.mjs prune E:/paper-vault --keep-last 10
```

`report` 默认导出脱敏摘要；`--details` 才包含失败文件相对路径。`drill` 在自建临时目录恢复，重新读取磁盘内容核对哈希，再清理该次自建目录。报告默认存于 Git 忽略的 `.local/state/reports/`。`prune` 默认只预览；执行隔离和至少 7 天后的永久清除是两个分别确认的操作，详见 [恢复、加密、副本与清理](docs/RECOVERY.md)。

加密仓库通过 `init-encrypted` 初始化，密码使用 `MOONRESTORE_PASSWORD` 环境变量；不要把密码输入命令参数或提交源码。Windows 可显式 `key-store` 授权当前用户 DPAPI 保管。恢复密钥需单独私有保管；丢失全部解锁方式将无法恢复数据。

大文件必须显式 `init-large NEW-REPOSITORY`，也可加 `--encrypted`。新 profile 使用格式 3：单文件配置上限 64 GiB、单快照总量上限 1 TiB，但仍同时受 100000 条目、1000000 分块引用、32 MiB 清单等预算限制。**这些是拒绝阈值，不代表上限规模已实测；不提供无限或恒定元数据内存保证。** 原格式仓库维持单文件 2 GiB/总量 64 GiB，不原地升级。详见 [格式说明](docs/FORMAT.md)。

```sh
npm run validate
npm run test:repeat -- 3
# 可选：至少预留 6 GiB 临时空间，实际 >2 GiB 备份/校验/恢复，可能耗时较长
npm run test:large
node scripts/check-package.mjs
node scripts/package.mjs
```

0.2.0 保持核心库 JS/Wasm/Wasm-GC/Native 验证；完整文件系统、加密、调度和本机工作台当前仍由 Node/系统适配支持，不宣称四目标均具备完整联网/文件运行时。加密调用 Node 标准密码库，MoonBit 负责分块、清单、完整性校验、保留策略和备份/恢复编排。第三方归属与许可证继续见 [NOTICE](NOTICE)、[来源说明](docs/THIRD_PARTY.md)。

基于 MoonBit 的可验证增量备份工具。备份后能校验完整内容，并恢复指定历史版本。适合论文、代码、实验数据和团队文件资产；独立于 HookLab 与 MoonMQTT。

[公开源码](https://github.com/bzhangui/moonrestore) · [Mooncakes 0.2.0](https://mooncakes.io/docs/bzhangui/moonrestore) · [持续集成](https://github.com/bzhangui/moonrestore/actions) · [发布核验记录](docs/PUBLICATION.md)

## 已实现

- 流式内容分块（CDC）与 SHA-256 内容寻址，跨文件、跨快照去重。
- 磁盘对象仓库、不可变快照、独占锁、临时文件事务和中断回收。
- 完整文件与对象校验，检测缺失、损坏、错误大小和分块顺序错误。
- 全量或文件/子目录恢复：先完整校验，再暂存，最后提交全新目录，不覆盖现有目录。
- 快照比较、排除路径、备份预检查、存储占用及未引用对象统计。
- Windows 交互菜单、命令行、可复用 MoonBit 核心库、自动测试与 CI 配置。

## 安装与运行

0.2.0 源码构建需要 [MoonBit](https://www.moonbitlang.com/download/)（moonc ≥ 0.10.15）、[Node.js](https://nodejs.org/) ≥ 22。构建脚本优先使用可选的 `.local/toolchain`，否则使用系统 SDK；可用 MOON_BIN/MOON_HOME 指定兼容环境。Linux/macOS 还需要系统 C 编译器，用于编译原子、不覆盖的目录提交辅助程序。Windows 不需要该辅助程序。

获取源码后在项目目录执行（公开仓库地址：`https://github.com/bzhangui/moonrestore`）：

```sh
git clone https://github.com/bzhangui/moonrestore.git
cd moonrestore
moon version --all
npm run build
node bin/moonrestore.mjs help
npm run demo
```

Windows 用户也可双击根目录的 **开始使用.cmd**。菜单支持创建仓库、备份、列出快照、完整校验和恢复；首次运行会构建。无需安装 npm 第三方依赖。

首次源码构建需要联网获取 Mooncakes 索引和固定版本依赖；构建脚本会先更新索引，避免仅在开发者已有缓存的机器上成功。已构建的 CLI 和便携运行包不需要联网。

本机源码目录为 `D:\moonrestore`。这不是网址，不需要启动网页服务。

## 最小使用示例

以下仓库与恢复目标必须尚不存在；父目录必须已存在。路径含空格时加引号。

```sh
node bin/moonrestore.mjs init "E:/paper-vault"
node bin/moonrestore.mjs plan "E:/paper-vault" "D:/papers" --exclude "node_modules"
node bin/moonrestore.mjs backup "E:/paper-vault" "D:/papers" --label "初稿" --exclude "node_modules"
node bin/moonrestore.mjs list "E:/paper-vault"
node bin/moonrestore.mjs verify "E:/paper-vault" all
node bin/moonrestore.mjs restore "E:/paper-vault" "完整的64位快照id" "D:/recovered-paper"
```

Linux/macOS 将盘符路径换成自己的目录即可。恢复后检查 `recovered-paper`，确认无误再自行替换工作文件。**不要为试用而删除自己的原始数据。**

`npm run demo` 自动生成临时样本，备份两稿，再恢复第一稿并断言内容一致，不接触个人资料。另有 `node examples/scenarios.mjs` 展示科研资料、团队资产和批处理回滚三个完整受控场景。

## 常用命令

| 命令 | 用途 |
|---|---|
| `init <repo>` | 创建全新仓库 |
| `plan <repo> <source> [--exclude p]` | 检查路径和预算，不写入数据对象 |
| `backup <repo> <source> [--label text] [--exclude p]` | 创建增量快照；排除项可重复 |
| `list <repo>` | 列出已校验清单的快照，不代表内容完整性已验证 |
| `verify <repo> <id或all>` | 逐文件、逐对象验证全部内容 |
| `restore <repo> <id> <new-target> [--prefix p]` | 恢复全量或部分内容，保留原相对路径 |
| `diff <repo> <old-id> <new-id>` | 列出新增、修改、删除的路径 |
| `status <repo>` | 存储统计及未引用对象清单，不自动删除 |
| `recover <repo>` | 回收已停止的本机进程锁和未提交临时文件 |

输出为 JSON；64 位字节计数使用十进制字符串，避免精度损失。成功退出码为 0，错误或 `status` 检出引用对象缺失/大小不符为 1；缺少构建文件为 2。

排除项是相对源目录的**精确路径前缀**，不是通配符；`--exclude cache` 排除 `cache` 及其子目录。分块参数可用 `--min`、`--avg`、`--max` 调整，默认 8/32/128 KiB，平均值必须为 2 的幂。

## 作为 MoonBit 库

核心 API 位于 `bzhangui/moonrestore/core`，不依赖 Node 或文件系统，支持 JS、Wasm、Wasm-GC、Native。本地可运行：

```sh
moon run examples/core --target wasm
```

已发布到 Mooncakes。在你的 MoonBit 项目中执行：

```sh
moon add bzhangui/moonrestore@0.2.0
```

对应包的 `moon.pkg` 中添加 `"bzhangui/moonrestore/core" @backup` 导入，参考下面的核心库示例。发布后已从注册表下载到独立项目并验证四目标检查、运行和测试；不是只验证本仓库的相对导入。

参考 [核心库示例](examples/core/main.mbt) 与生成的 [API](core/pkg.generated.mbti)。应用层 `app` 仅支持 JS，需要本项目的 Node 文件适配器，不是独立文件库。

## 维护与测试

```sh
npm run validate
npm test
node examples/scenarios.mjs
node scripts/benchmark.mjs
node scripts/package.mjs
```

`validate` 执行四目标核心检查/构建/测试、格式检查、应用构建和文件系统集成测试。Native 测试需要系统 C 工具链；不会因为编译器缺失而默默略过。2026-10-09 的 [Windows、Linux、macOS CI](https://github.com/bzhangui/moonrestore/actions/runs/37942722864) 均通过；最新运行见仓库 Actions。

更多说明：[维护与故障处理](docs/OPERATIONS.md)、[仓库格式](docs/FORMAT.md)、[安全边界](SECURITY.md)、[测试报告](docs/QUALITY_REPORT.md)、[应用场景](docs/SCENARIOS.md)、[验收进度](docs/ACCEPTANCE.md)。

## 0.1.0 基础格式的限制与许可（0.2.0 扩展见上文及格式说明）

- 仓库不加密；文件内容和文件名以可读取形式存储。不要将私人备份仓库上传到公开 GitHub。
- 同盘备份不抵御硬盘损坏。重要数据应放在独立磁盘；挂载 NAS 仅在提供可靠锁、同步和原子重命名语义时适用，尚未经过真实 NAS 验证。
- 不保存 ACL、所有者、时间戳、链接、稀疏属性或可执行权限；恢复文件采用私有默认权限。特殊文件和链接直接拒绝，不静默遗漏。
- 不提供数据库热备份或跨文件事务一致性。备份前暂停写入，数据库先使用其官方导出工具。
- SHA-256 用于完整性检测，不是加密或身份认证；拥有仓库写权限的攻击者仍可重写整套备份。
- 0.1.0 首版保留全部历史。0.2.0 增加显式确认的隔离/清理，但仍不自动修复损坏对象或默认删除历史数据。
- 0.1.0 已执行本机及三平台 CI 验证；独立介质、真实 NAS、断电、长期运行与外部用户试点尚未完成，不应当作生产可靠性承诺。

采用 [Apache-2.0](LICENSE)。第三方依赖和算法参考见 [NOTICE](NOTICE) 与 [来源说明](docs/THIRD_PARTY.md)。

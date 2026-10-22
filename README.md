# MoonRestore

用 MoonBit 实现的可验证增量备份与恢复工具。面向论文、代码、实验资料及小团队文件资产：不仅保存历史，还检查损坏范围、演练恢复，并对实际读回留下证据。

[公开源码](https://github.com/bzhangui/moonrestore) · [CI](https://github.com/bzhangui/moonrestore/actions) · [Mooncakes 0.5.0](https://mooncakes.io/docs/bzhangui/moonrestore) · [测试报告](docs/QUALITY_REPORT.md) · [更新记录](CHANGELOG.md)

## 当前源码：0.7.0 开发版；Mooncakes：0.5.0

使用 `moon add bzhangui/moonrestore@0.5.0` 安装 MoonBit 核心库，包含 0.4/0.5 新增恢复、巡检和操作规则 API；0.3.0 旧包不包含这些接口。CLI/工作台仍需按下文从源码构建，Mooncakes 不是 Windows 桌面二进制下载。[验收进度](docs/ACCEPTANCE.md) 与 [发布记录](docs/PUBLICATION.md) 区分注册表发布、本机、远端及历史结果；以发布记录中的实际查询、哈希与独立消费结果为准。

0.7 源码新增恢复目标与任务缺席判断、脱敏心跳、安全配置迁移、固定版本远端审计、SQLite 恢复后内容检查，以及备份文件内部完整分块检查点。工作台补齐相关配置和确认流程。沿用 0.6 的同快照证据、保护窗口、签名与独立救援包。本轮不发布 Mooncakes 或运行包；新增核心 API 不能从注册表 0.5.0 获得。见 [0.7 使用说明](docs/RELIABILITY_0_7.md) 与 [实施及缺口](docs/NEXT_UPGRADE_EXECUTION.md)。无人值守必须显式启用，不保存明文密码或自动永久清理。

| 能力 | 当前行为和边界 |
| --- | --- |
| 增量备份 | CDC、SHA-256 内容寻址、跨版本去重；不可变快照、输入预算与中断保护 |
| 严格恢复 | 全量预校验、排他发布新目录；隔离恢复演练独立读回，不覆盖已有目标 |
| 应急救援 | 只读源仓库，逐文件判断可救内容，显式接受部分恢复；损坏文件不补零、不报全量成功 |
| 健康副本重建 | 两个只读来源补齐指定快照的对象或清单，在新仓库完整校验后发布；不原地修复 |
| 恢复准备与巡检 | 独立密钥、无密钥准备清单、持久检查游标、完整周期和新鲜度；不是未来恢复保证 |
| 历史搜索 | 有预算的可重建索引，源变化拒绝旧缓存，加密源索引也加密；不用于恢复或删除决策 |
| SQLite | 在线导出、恢复后重新打开及完整性/外键/可选表列行数检查；不保证多库事务或应用业务语义 |
| S3 兼容副本 | 显式联网，仅加密源，SigV4、条件不覆盖写、读回校验、固定摘要下载；本机模拟通过，真实供应商待验证 |
| 本机工作台 | 任务、历史、选择恢复、会话解锁、进度/取消、应急救援与健康证据；仅回环 |
| 可靠任务与续作 | 私有认证日志；文件级及每1024完整分块检查点、重新读取前缀核对及发布后读回；取消/中断保留旧版本 |
| 统一应用计划 | 文件/SQLite/PostgreSQL，分项证据、容量/源异常及清理保护；默认手动，0.6 源码可显式配置调度，不隐式连接远端 |
| 分段运输归档 | 有界页/段、可选压缩、外部固定根摘要，导入完整审计后新建仓库；不改 live 仓库格式 |
| PostgreSQL | 单库 custom 导出、全归档展开检查及文件恢复演练；不是集群/PITR，不自动恢复生产库 |
| 日常恢复准备 | RPO/演练RTO与缺席判断；离线计划有限展示、显式脱敏心跳、白名单配置迁移，不自动移动密钥 |
| 远端只读审计 | 固定回执和成员versionId、摘要/大小及可选服务端保留读回；不是明文恢复或真实供应商验证 |

真实 VSS 请求器、WAL/PITR、live 分页清单/对象pack/磁盘索引尚未实现。分块续作必须重新读取并验证源前缀，不是免读字节续传；运输归档分段不是新 live 格式。独立介质、NAS、跨主机、真实云、物理断电、长期生产及外部用户仍待验证。Windows 真实系统任务本轮遇注册/删除调用超时，执行与清理未完整确认，不能标记验收通过；不提权或更改已有任务，见维护报告。

## 0.5 可靠性入口

```sh
node bin/moonrestore.mjs backup-resumable REPO SOURCE
node bin/moonrestore.mjs operation-resume REPO UUID --recover
node bin/moonrestore.mjs restore-resumable REPO SNAPSHOT_ID NEW_TARGET
node bin/moonrestore.mjs plan-save PRIVATE_CONFIG_JSON
node bin/moonrestore.mjs plan-run PLAN_UUID
node bin/moonrestore.mjs archive-export REPO NEW_ARCHIVE
node bin/moonrestore.mjs archive-import ARCHIVE EXTERNAL_CHECKSUM NEW_REPO
```

`--recover` 仅在原进程停止后使用。工作台支持文件/SQLite/本机 PostgreSQL 计划和显式加密S3副本、分项证据、救援包及续作/新目录恢复；运输归档和新密钥仓库迁移仍使用 CLI。详见 [0.7 指南](docs/RELIABILITY_0_7.md)、[可靠任务与离线归档](docs/RELIABILITY_0_5.md)。S3 瞬态错误有界重试，403/409、错误版本、坏校验和和重定向不重试成功化。

## 安装与最小示例

需要 moonc ≥ 0.10.15、Node ≥ 22.16.0（推荐当前 LTS）。Linux/macOS 还需系统 C 工具链用于排他目录提交。无 npm 第三方运行依赖。构建优先用可选 `.local/toolchain`，否则使用系统 SDK；可设 `MOON_BIN` / `MOON_HOME`。

```sh
git clone https://github.com/bzhangui/moonrestore.git
cd moonrestore
moon version --all
npm run build
npm run demo
```

demo 只创建临时合成资料，备份两稿并恢复首稿，不接触个人文件。首次构建需联网下载固定依赖；已构建的文件工作流离线运行，S3 命令除外。

以下路径需替换为自己控制的目录，仓库和恢复目标必须尚不存在，父目录必须存在。Unix 替换盘符，路径含空格时加引号。

```sh
node bin/moonrestore.mjs init "E:/paper-vault"
node bin/moonrestore.mjs plan "E:/paper-vault" "D:/papers" --exclude node_modules
node bin/moonrestore.mjs backup "E:/paper-vault" "D:/papers" --label "初稿" --exclude node_modules
node bin/moonrestore.mjs list "E:/paper-vault"
node bin/moonrestore.mjs verify "E:/paper-vault" all
node bin/moonrestore.mjs restore "E:/paper-vault" SNAPSHOT_ID "D:/recovered-paper"
```

ID 为完整 64 位小写十六进制。排除项是精确相对路径前缀，不是通配符。大字节计数为十进制字符串。错误/不完整退出 1，缺构建退出 2。确认结果后再自行处理工作文件，勿为试用删除原件。

## 工作台与运行包

```sh
npm run workbench
node scripts/package.mjs
# Windows x64 内置运行时与原生启动器
npm run package:desktop
```

工作台默认 `127.0.0.1:8790`，须使用控制台提供的完整临时会话链接，不可公开。浏览器不将凭据存入 localStorage。运行 `node bin/moonrestore.mjs help` 查看命令；索引、运输归档及部分高级参数仍为 CLI，图形向导不代表覆盖全部命令。

桌面包不需要全局 Node/MoonBit，需系统 .NET Framework 4.x；EXE 尚未代码签名。包仅本地生成，不等于已发布 GitHub Release。不要求关闭系统安全策略。见 [桌面包](docs/DESKTOP.md)、[工作台](docs/WORKBENCH.md)。

## 0.4 恢复优先用法

```sh
node bin/moonrestore.mjs emergency-preview REPO SNAPSHOT_ID NEW_TARGET
# 复制实际 confirmation，明确接受可能的部分恢复
node bin/moonrestore.mjs emergency-restore REPO SNAPSHOT_ID NEW_TARGET --accept-partial --confirmation HASH
node bin/moonrestore.mjs recovery-checklist REPO NEW_PRIVATE_JSON
node bin/moonrestore.mjs scrub REPO --files 100 --bytes 268435456
node bin/moonrestore.mjs health-status REPO --max-age-hours 168
node bin/moonrestore.mjs index-build REPO
node bin/moonrestore.mjs index-search REPO paper
node bin/moonrestore.mjs sqlite-backup REPO DATABASE_FILE --label "应用备份"
```

[恢复/重建/巡检/索引](docs/RECOVERY_0_4.md) · [SQLite 与 VSS 边界](docs/APPLICATIONS.md) · [远端副本与授权](docs/REMOTE.md)

## MoonBit 核心与结构

`core/` 实现分块、哈希、清单/路径/属性校验、范围、保留规则与巡检批次；`app/` 用 MoonBit 编排备份、校验、恢复及救援；`platform/` 用 Node/OS 提供文件、加密、网络、任务；`ui/` 为原生 JS/CSS。不是包装 Node 备份库。

核心支持 JS/Wasm/Wasm-GC/Native；完整磁盘、加密、网络及 GUI 运行时目前依赖 Node，不宣称四目标全具备这些系统能力。

```sh
moon run examples/core --target wasm
# 独立 MoonBit 项目消费正式发布版
moon add bzhangui/moonrestore@0.5.0
```

`moon.pkg` 导入 `"bzhangui/moonrestore/core" @backup`。见 [样例](examples/core/main.mbt)、[API](core/pkg.generated.mbti)。

## 维护与限制

```sh
npm run validate
node scripts/repeat.mjs 3 120
node scripts/history-scale.mjs
node scripts/large-file.mjs
node scripts/package.mjs
```

validate 覆盖四目标检查/构建/测试/样例、Node/HTTP/故障回归、三场景、核心覆盖率与包隐私。large-file 至少预留 6 GiB 临时空间。规模测试仅合成资料，不是生产压测。真实浏览器入口见 [维护报告](docs/QUALITY_REPORT.md)。

默认仓库明文；敏感资料请显式加密，恢复密钥与仓库分开保管。丢失全部解锁方式不能恢复。格式 3 的 64 GiB 单文件/1 TiB 快照是拒绝阈值，不代表上限实测；旧仓库不原地改写。保留/清理默认只预览，隔离与永久清除分别确认。见 [格式](docs/FORMAT.md)、[运维](docs/OPERATIONS.md)、[安全](SECURITY.md)。

采用 [Apache-2.0](LICENSE)，保留 [NOTICE](NOTICE) 和 [第三方来源](docs/THIRD_PARTY.md)。私人申报书、密钥、备份、报告、SDK 与运行时缓存不公开。

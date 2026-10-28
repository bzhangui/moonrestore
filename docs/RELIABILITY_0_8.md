# 0.8 日用可靠性、分页存储与应用恢复

源码开发版；Mooncakes 仍为 0.5.0。本轮仅授权测试后推送源码，未授权发布新注册表包或桌面附件。最低 moonc 0.10.15、Node 22.16.0；无 npm 运行依赖。先执行 `npm run build`。所有示例路径替换为自己控制的目录，不填密码到命令、申报书或仓库。

## 新仓库与迁移

```sh
node bin/moonrestore.mjs paged-init NEW_REPO --encrypted
node bin/moonrestore.mjs paged-backup NEW_REPO SOURCE --exclude cache --label first
node bin/moonrestore.mjs paged-verify NEW_REPO SNAPSHOT_SHA
node bin/moonrestore.mjs paged-restore NEW_REPO SNAPSHOT_SHA NEW_TARGET --confirm NEW_TARGET
node bin/moonrestore.mjs paged-migrate OLD_REPO OLD_SNAPSHOT NEW_REPO --confirm NEW_REPO --encrypted
```

加密密码仅取 `MOONRESTORE_PASSWORD`，建议安全交互设置环境后在操作结束清除；同账户的环境和内存不是密钥硬件保护。新格式仍复用已审计的 scrypt/AES-GCM 信封，每种对象/磁盘缓存各自绑定类型和 ID。迁移完整恢复到私有临时明文目录再备份/核验新仓库，原仓库只读。需要额外磁盘容量；失败目录保留，不自动删除恢复资料。迁移不会复制历史所有版本，须按快照分别规划。

MoonBit 负责 CDC、增量 SHA、文件边界、路径/页/记录/全局预算；Node 负责安全文件 IO、zlib、SQLite磁盘索引和系统集成。core 公共 API `PagedLedger`/`PagedRecord`/`validate_page_link` 可四目标使用；`cmd/storage` 只是 JS 字节桥。索引可删除重建，不是恢复或清理的真相来源；加密仓库缓存的路径、对象 ID 和内容值加密，数量/大小仍可能暴露。索引2MiB页缓存，最多约8GiB文件预算；不要把数据库缓存大小当整个进程RSS。

规范：根文件常数大小，反向 SHA 页链，最多128记录/页、256KiB/页；文件 begin/chunk/end 跨页；原始对象包最多8MiB，块最多1MiB，原始摘要绑定压缩前内容；解压上限拒绝炸弹。限制1百万条目/1百万页/32百万块引用/64GiB单文件/1TiB快照，均为拒绝预算，**不是上限压力测试承诺**。本轮实测范围以 QUALITY_REPORT 为准。备份重建历史对象索引需读取旧恢复点，历史很多时启动开销较高；没有索引即跳过校验的快速模式。

文件源不自动冻结。读前/后及提交前核对源身份/大小/mtime/ctime；发现变化不发布新根。拒绝链接、特殊文件、非法路径和大小写碰撞；备份根最后发布。format4目前不可续写已失败的事务，下次从新快照开始；旧恢复点不被替换。恢复先完整核验，再排他写新目录并逐文件读回；只恢复基础mtime，POSIX权限需 `--permissions`，不宣称 ACL/ADS/稀疏/硬链接完整保真。Windows目录fsync和硬件断电持久性不是已验证能力。

## 回收与中断

```sh
node bin/moonrestore.mjs paged-gc REPO --batch 100
node bin/moonrestore.mjs paged-gc REPO --batch 100 --confirm PREVIEW_HASH
node bin/moonrestore.mjs paged-recover REPO --confirm REPOSITORY_UUID
node bin/moonrestore.mjs paged-purge REPO BATCH_SHA
node bin/moonrestore.mjs paged-purge REPO BATCH_SHA --confirm BATCH_SHA
```

预览/执行均完整验证所有已发布根；只隔离没有根引用的页/包，不删历史快照、不传播业务删除。确认绑定根集合、库存、批次及内容；变化需重做。隔离最少7天后再次审计才可永久清理；系统时钟应可信，不是防管理员改时钟的WORM。执行中断写入pending标记，禁止新写入；`paged-recover` 仅接管同主机已死亡进程的锁，回滚精确批次或移除自身两链接临时别名，不猜测外来硬链接。普通孤立临时文件保留并计数，须操作者检查。永久清理仅针对确认批次，可恢复性以现有恢复点为准；已永久删除的无引用内容不可再恢复。

## 系统任务和远端周期

`os-task-status EXACT_TASK`、`os-task-disable EXACT_TASK --confirm EXACT_TASK`、`os-task-remove EXACT_TASK --confirm EXACT_TASK` 核对私有意图、当前SID、动作/参数/间隔等。注册先查询、写意图再RPC；超时后核对实际结果，未知不自动重试。移除运行中任务被拒绝，不强停业务。当前实现仅登录用户会话，不承诺关机/注销后备份。本轮真实专用任务查询未确认，不能算实际调度通过；旧遗留资源须单独精确核查。

`remote-audit-cycle RECEIPT SHA --cycle new --version PIN --endpoint URL --bucket NAME` 返回UUID，重复以UUID推进，失败需 `--retry`，死同主机租约需 `--recover`。私有HMAC绑定游标/供应商描述/固定版本；仅全部页检查完才标记完成。缓存完成记录明确不是新远端读；保留期随时间重新判断。这不是明文可恢复或同账户攻陷防护。

`s3-drill RECEIPT SHA NEW_REPO --endpoint URL --bucket NAME --version PIN` 串起固定回执下载、完整审计、解密恢复与磁盘读回，报告总恢复耗时。仍只支持旧加密format2/3，凭据通过现有S3环境变量。受控本机服务不是真实云/独立账户证明；要验证真实供应商必须另行授权端点及成本/保留设置。

## 认证心跳接收端

```sh
node bin/moonrestore.mjs monitor-init NEW_MONITOR_DIR --source SOURCE_UUID --max-age 3600
node bin/moonrestore.mjs monitor-serve MONITOR_DIR --port 8791
node bin/moonrestore.mjs monitor-send http://127.0.0.1:8791/heartbeat --source SOURCE_UUID
node bin/moonrestore.mjs monitor-status MONITOR_DIR
```

发送/接收端各自安全配置相同 `MOONRESTORE_MONITOR_TOKEN`（32..2048非空白字符），不要提供给本工具或提交Git。默认回环；非回环监听需 `--host IP --allow-remote --tls-key PRIVATE_KEY --tls-cert CERT`，远程发送需HTTPS及 `--allow-remote`，不关闭证书验证。独立管理员/主机才能隔离共同故障，当前不具备此环境。每个接收目录绑定一个来源UUID；多来源用独立实例/目录。8KiB请求/4KiB回执、120请求/分钟、32连接、10秒请求预算。只接受聚合计数；私有序号在联网前落盘，响应丢失可幂等重试，同序号不刷新存活时间。接收端先持久保存再返回回执，重启后保留过期判断，时钟回退失败关闭。意外终止留下锁须确认原进程停止后精确清理，不自动接管。状态为缺席/过期/源报告异常时需要外部报警系统轮询；**持久回执不等于邮件/短信投递**。

## VSS Windows请求器

```sh
node scripts/build-vss.mjs
node bin/moonrestore.mjs vss-plan SOURCE
node bin/moonrestore.mjs vss-backup REPO SOURCE --allow-native-vss
```

需已安装 MSVC/Windows SDK，编译不安装服务、不提权。运行需调用者已有授权管理员会话/本地固定卷，当前设备未授权此真实环境，因此只验证编译、协议、拒绝门禁与受控生命周期。请求器 GatherWriterMetadata/Status → PrepareForBackup → DoSnapshotSet → BackupComplete/Abort → 精确DeleteSnapshots/不存在核对，无 nowriters 或 live-copy 回退。进程自有非持久影子集、20分钟租期；Node暂存快照子树到私有明文目录，完整备份/审计/恢复演练后释放。默认2GiB/10万条目预算，可显式提高字节预算。释放未确认保留私有意图/夹具供核对，不任意删其他影子集。写入器参与不等于任意应用业务一致性；真实写入器/异常清理/断电仍待管理员环境验证，二进制未签名、未公开分发。

## PostgreSQL物理/WAL/PITR

```sh
node bin/moonrestore.mjs postgres-physical-backup PAGED_REPO --bin ABS_PG_BIN --user BACKUP_ROLE --host 127.0.0.1 --port 5432
node bin/moonrestore.mjs wal-archive-init NEW_WAL_DIR
node bin/moonrestore.mjs wal-archive-put WAL_DIR CANONICAL_SEGMENT SOURCE_SEGMENT
node bin/moonrestore.mjs pitr-prepare PAGED_REPO SNAPSHOT NEW_TARGET --confirm NEW_TARGET --bin ABS_PG_BIN --wal WAL_DIR --time 2026-10-28T00:00:00Z --trust-source
node bin/moonrestore.mjs pitr-drill PAGED_REPO SNAPSHOT NEW_TARGET --confirm NEW_TARGET --bin ABS_PG_BIN --wal WAL_DIR --time 2026-10-28T00:00:00Z --trust-source --allow-isolated-server --user DB_SUPERUSER
```

物理工具需绝对路径且同大版本PG≥16；检查服务端大版本/系统ID并拒绝外部tablespace，避免 plain basebackup 写原路径。使用 `pg_basebackup -X stream --no-slot`/SHA256manifest 和 `pg_verifybackup`，不创建永久复制槽，不自动修改原数据库配置。默认10GiB/30分钟预算，轮询体积不是OS硬配额；失败私有暂存保留，含明文数据库，需操作者清理。凭据仅PG环境/passfile，远程需 `--allow-remote` 与verify-full。WAL归档接收完整规范段或timeline history，不覆盖不同内容，摘要读回；**仍需操作者配置并监测连续归档，base自带WAL不等于后续历史已归档**。不自动向生产写入archive_command，不支持任意tablespace映射或多时间线自动挑选。

PITR目前Unix隔离服务器入口，Windows在恢复写入前拒绝。新目录先恢复并验证base，替换源conf/auto.conf/HBA/ident、清除standby配置、禁用归档/primary_conninfo/preload/逻辑复制worker，只回环，固定目标UTC/当前timeline/暂停。prepare默认全拒绝连接，只准备不启动；drill额外授权可信源/角色，仅在此新目录临时允许该角色本机trust，验证系统ID、恢复状态、暂停和LSN，最后精确停止自有pg_ctl并关闭临时trust。源集群来自可信来源：这不是容器/网络沙箱；不能执行陌生物理备份。缺WAL/坏manifest/目标不可达/停止未确认不报通过。默认不执行业务SQL、不自动提升为主库；业务语义须独立检查，真实生产PITR仍待授权。可运行真实合成集群专项 `MOONRESTORE_PG_PITR_NATIVE=1 node --test tests/postgres-pitr-native.test.mjs`；以本次提交CI结果为准。

依据：[Microsoft VSS请求器](https://learn.microsoft.com/en-us/windows/win32/vss/requestors)、[PG16连续归档与PITR](https://www.postgresql.org/docs/16/continuous-archiving.html)、[pg_verifybackup限制](https://www.postgresql.org/docs/16/app-pgverifybackup.html)。新适配均原创实现，许可证Apache-2.0，不复制其他备份工具代码。

## 兼容与回退

| 对象 | 兼容策略 |
| --- | --- |
| format1/2/3及旧CLI/计划/工作台/救援包/S3 | 保持原读写路径，不自动升级；完整旧回归保留 |
| format4 | 仅paged-*及物理备份CLI；旧命令不读取此格式，失败而非误解格式 |
| 新格式迁移回退 | 保留原仓库；新仓库/目标另建，不支持原地降级；可验证恢复后重新备份为旧格式（受旧上限约束） |
| 注册表/桌面安装 | 新API尚未发布注册表，不替换现有安装；只做本机打包验证 |

全量 `npm run validate`、`npm run package`；真实 OS 任务演练须显式授权才运行 `node scripts/plan-scheduler-qa.mjs --allow-os-task`，不并入默认测试。断点、磁盘故障、损坏/时钟/权限等受控用例不代表覆盖所有极端情况或真实停电。

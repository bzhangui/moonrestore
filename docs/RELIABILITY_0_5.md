# 0.5 可靠任务与离线归档

仅 GitHub 源码升级；不执行 Mooncakes 发布。先阅读 README 的安装要求。所有示例路径都必须替换为本人控制的目录，不要用私人资料试验故障注入。

## 1. 可续作备份和恢复

```sh
node bin/moonrestore.mjs backup-resumable REPO SOURCE --label "已核对的资料"
node bin/moonrestore.mjs operation-status REPO UUID
node bin/moonrestore.mjs operation-resume REPO UUID
# 仅原进程已停止时，允许恢复该操作自己在同一主机上的死锁
node bin/moonrestore.mjs operation-resume REPO UUID --recover
node bin/moonrestore.mjs restore-resumable REPO SNAPSHOT_ID NEW_TARGET
```

失败信息含操作 UUID。日志保存在私有状态目录 `operations/UUID`；加密仓库的日志也认证加密。不保存密码或解锁密钥。恢复这些日志仍需原仓库和有效解锁方式。不要公开日志。

备份是**文件级检查点**：重新核对源目录身份、完整目录清单、参数，已完成文件重新读源哈希并验证仓库对象；未完成文件从头分块，已存在对象可去重。不是任意源变化后仍可续作，也不是备份文件内部字节级续传。

恢复会重新完整校验快照，逐段比较已存在的暂存前缀，只补写缺少部分；不覆盖不同前缀，不截断额外字节。全部文件独立磁盘读回后才排他发布。发生“已经发布、日志尚未确认”的中断时，必须匹配原暂存目录身份并再次完整读回，才能消除不确定状态。

恢复源仍严格只读。未发布暂存保留在新目标同级 `.moonrestore-UUID.partial`，供诊断；不会自动递归清除未知目录。数据内容得到验证，不承诺恢复 NTFS ACL、ADS、EFS、稀疏属性或全部元数据。重复调用已完成操作不重复产生新快照。

## 2. 统一计划和清理保护

工作台下方“可靠任务”可创建文件/SQLite 计划、运行、查看分项证据、检查及续作操作、执行新目录完整恢复。无新增远程资源、无凭据 localStorage、无自动定时注册。旧 job 配置和原任务调度仍兼容，新增计划当前必须显式运行。

CLI 计划配置示例（本机私有 JSON）：

```json
{"name":"研究资料","type":"files","repository":"E:/vault","source":"D:/papers","dropPercent":30,"growthPercent":300,"reserveBytes":268435456,"rpoHours":24}
```

```sh
node bin/moonrestore.mjs plan-save PRIVATE_CONFIG_JSON
node bin/moonrestore.mjs plan-list
node bin/moonrestore.mjs plan-run PLAN_UUID
node bin/moonrestore.mjs plan-status PLAN_UUID
```

`type` 为 `files`、`sqlite`、`postgresql`。SQLite 的 source 是主库文件；PostgreSQL 使用 `postgres` 对象（下节同名配置），不传 source。可选 `replica` 是第二仓库路径，不传播删除。可选 `remote` 的键仅为 endpoint/bucket/region/prefix/allowRemote/accessKeyEnv/secretKeyEnv/sessionTokenEnv；凭据只引用环境变量名，不能填写密钥值；远端仍要求加密仓库、显式 HTTPS 授权。

成功证据逐步持久化为 backup/verified/drill/replica/remote。任何步骤失败保留前次成功点，但整体结果不报通过。`backup_age_ms` 为本机证据年龄；`observed_restore_ms` 仅本次合成或用户资料的实际恢复耗时，不是生产 RPO/RTO 保证。

源条目骤降或字节增长超阈值时停止，需要调查后显式 `--accept-anomaly`；该检测不是勒索软件识别。源已经改变而旧操作不能续作时，可显式 `--restart` 建立新操作，旧日志保留；不能重启仍在运行的操作。`--recover` 仅处理本计划自己的同机死锁，绝不强制接管活进程/外来锁。

新计划启用清理保护：未完成、失败、时钟倒退/大跳变、身份变化或证据超过 24 小时，prune/purge 拒绝。同一仓库所有启用计划都须成功验证，不能用另一个计划的成功覆盖失败状态。更新清理状态也使用排他租约；更新中断遗留的私有锁会阻止清理，需先核查进程和私有记录，不能盲目删除。普通备份仍可进行；不将异常删除传播到历史。31 天以上未运行需先调查时钟及状态，再显式重新配置，不静默重置信任。日志/保护是本机管理能力，不对抗掌握同一用户权限的恶意删除者；不要删除私有状态绕过保护。

## 3. PostgreSQL 单库逻辑导出

```sh
node bin/moonrestore.mjs postgres-backup REPO --database DB --user USER --pg-dump ABS_PG_DUMP --pg-restore ABS_PG_RESTORE
```

使用本人信任的绝对可执行文件，客户端版本须与服务器兼容；默认回环，远端另需 `--allow-remote`，强制 verify-full TLS。不在命令行/配置保存密码，使用进程环境/私有 PGPASSFILE。流程为 custom 格式导出、目录表读取、全归档展开到私有临时 SQL（不执行）、备份、完整验证、隔离恢复磁盘读回。超时、客户端失败、坏头、膨胀预算拒绝；临时明文导出仅清除本次拥有的目录。

**归档可展开和文件可恢复不等于数据库已经可启动**。默认命令不连接恢复目标、不自动执行 SQL、不覆盖生产库。单库 pg_dump 不覆盖集群角色、tablespace、WAL/PITR、跨库事务。恢复不可信 dump 可能执行源超级用户选择的代码，应在本人控制的隔离环境验证。依据 [pg_dump 官方文档](https://www.postgresql.org/docs/current/app-pgdump.html)、[pg_restore 官方文档](https://www.postgresql.org/docs/current/app-pgrestore.html)。

本机无 PostgreSQL 工具/运行中的 Docker；本机测试使用标注的受控客户端。新增专用 CI 为自建一次性 PostgreSQL 16 实例，真正执行客户端导出、恢复到新库和行数/长字段 SQL 验证；只有对应远端运行成功才能称此项通过，不代表外部用户或生产验证。

## 4. 分段运输归档与密钥迁移

```sh
node bin/moonrestore.mjs archive-export REPO NEW_ARCHIVE
# 校验码必须另行保管；不能从不可信归档本身获取后假装可信
node bin/moonrestore.mjs archive-import ARCHIVE EXTERNAL_CHECKSUM NEW_REPO
node bin/moonrestore.mjs key-migrate SOURCE_REPO NEW_ENCRYPTED_REPO
```

归档是离线运输格式，不是新 live 仓库格式。格式 1/2/3 保持不变；归档按 ≤1 MiB 数据段、每页 ≤64 个仓库成员、≤4 MiB 页、≤2 MiB 根、≤100000 成员/2000 页、≤1 TiB 声明总量读取。每段独立摘要，可选 raw/deflate；解压输出硬限 1 MiB。随机/已压缩内容自动保留 raw。根摘要固定页，页固定段；跨页路径重复/遍历、坏段、膨胀超限拒绝，目标存在拒绝。完整审计后才发布新仓库。导出仍受原清单 32 MiB、维护清单累计 64 MiB 等旧预算限制，**没有宣称无限规模或分段 live manifest 已完成**。

敏感资料先用加密仓库；归档保留原密文和加密配置，不另外创建密钥，导入仍需原解锁方式。明文仓库的归档也明文。外部校验码不是身份签名，必须经可信渠道保管。

`key-migrate` 要求全新目标及私有 `MOONRESTORE_DEST_PASSWORD` 环境变量；创建新随机仓库密钥，验证复制全部历史。源保留不动。它区别于只更改密码包装，不会撤销已流出的旧离线密钥。清空本次环境变量并分开保管新恢复密钥。

## 5. 故障、预算与验证边界

```sh
npm run validate
node --test tests/operations.test.mjs tests/plans.test.mjs tests/archive.test.mjs tests/s3-retry.test.mjs tests/postgresql.test.mjs tests/resilience.test.mjs
```

覆盖硬退出检查点、发布确认不确定、源/仓库身份变化、错误密钥、损坏日志/前缀、目标抢占、磁盘写入拒绝、短暂 429/5xx、403/409 不重试、坏归档与解压预算。`MOONRESTORE_TEST_CRASH/FAILURE` 仅给合成夹具使用，不对私人源或真实备份注入故障。

真实管理员 VSS 请求器仍未实现：windows_vss 能力显式不可用，拒绝 live-copy/nowriters 降级。保留 writer/租约受控生命周期演练与只读准备检查，不以模拟替代 VSS、独立硬件/跨主机、供应商 IAM/Object Lock、物理断电或长期生产。可用 SQLite 在线导出或受控 PostgreSQL 逻辑导出，不将普通文件备份当应用一致性快照。

版本升级先保留旧二进制包与原仓库。新版本验证后再替换启动入口；回退旧版仍可读原仓库，旧版不理解新增私有计划/操作日志和运输归档，请保留新程序用于续作或先导入归档。不得为回退删除原件或旧密钥。

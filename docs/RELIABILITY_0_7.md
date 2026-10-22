# 0.7 恢复目标、应用验收与日用工作流

源码开发版，不代表 Mooncakes 或桌面运行包已经发布。沿用 live 仓库格式 1/2/3，旧仓库不原地转换。Apache-2.0 与 NOTICE 保持不变。

## 1. 恢复目标与任务缺席

统一计划新增 `rtoMinutes`（0 不设置，最高 1440）；`rpoHours` 同时约束保守恢复点年龄和各项证据的新鲜度。文件使用原操作的起始时间（续作不刷新此时间），应用导出使用计划开始时的保守观测，记录为 `recoveryPointAt`；它不是数据库服务端的精确事务时间。不会把晚得多的备份完成时间冒充恢复点时间。旧计划缺少此记录时为未知，须重新运行，不沿用绿灯。首次无记录、旧快照、时间异常、过期、离线仓库、未完成或失败不能仅凭完成日期显示健康。

RTO 使用单调计时的**这次隔离演练耗时**，不包含生产系统切换、真实远端下载、人工响应和应用重启，不能承诺生产 RTO。结束前还核对本轮各步骤的时钟，回退/异常不解除清理保护。CLI `plan-status` 分开返回完成证据年龄与 `recovery_point_age_ms`，不修改旧 `backup_age_ms` 的完成时间语义。

```sh
node bin/moonrestore.mjs readiness
node bin/moonrestore.mjs watchdog-check --notify
# 只有显式调用才联网；不跟随重定向
node bin/moonrestore.mjs readiness-send https://YOUR-AUTHORIZED-MONITOR/heartbeat --allow-remote
```

心跳只含随机报告 ID、时间、计划数、缺席/超目标计数及独立副本验证计数，不含计划名/ID、路径、文件名、原始错误或密钥。可选 `MOONRESTORE_MONITOR_TOKEN` 仅由服务端环境提供。2xx 表示接收端接受请求，**不是最终通知投递确认**。同一主机休眠、关机或观察器未运行时不能及时发出本机报警；需另行部署有明确授权的独立接收端检查心跳缺失。本轮未部署此接收端。

RTO 超目标会保留已完成的有效快照，计划不报整体成功，清理保护不解除。离线计划列表仍可查看有限名称/类型及不可用原因；这不放松任何写入的身份/解锁门禁。

## 2. 私有配置迁移与回退

CLI 与桌面历史默认目录不同。不会自动搬迁或扫描个人目录。先停止使用旧状态的全部工作台、runner 和操作；检查 `state-status`，再显式选择共同的 `--home`。

```sh
node bin/moonrestore.mjs state-status
node bin/moonrestore.mjs state-migrate-preview OLD_STATE NEW_STATE
node bin/moonrestore.mjs state-migrate OLD_STATE NEW_STATE --confirm PREVIEW_HASH
node bin/moonrestore.mjs --home NEW_STATE workbench
```

目标必须不存在、在源目录外，父目录须已存在。只复制白名单任务、计划、调度、清理保护与保留策略；不复制密钥、密码、报告、运行控制或操作日志。不接受链接、活/中断租约、未完成操作或含凭据配置；环境变量**名称**可保留。预览绑定成员、摘要、来源和目标，源变化须重新预览。对静止状态做前后检查，不提供并发使用中的状态事务迁移。新进程重新解锁；当前进程不切换，原目录不删除，回退时使用原 `--home`。恢复密钥必须独立保管。

## 3. SQLite 恢复后重新打开验证

`sqlite-backup` 除在线导出和文件恢复读回，还实际打开恢复出的数据库执行完整性/外键检查。SQLite 在读取 WAL 模式数据库时可能维护 WAL/SHM 辅助文件，不承诺源目录逐字节不变；不向源库执行业务写入。

```sh
node bin/moonrestore.mjs sqlite-recover REPO SNAPSHOT NEW_DIR --confirm NEW_DIR --checks PRIVATE_CHECKS_JSON
```

检查配置示例（应在私有目录保存）：

```json
{"format":1,"tables":[{"name":"orders","columns":["id","status"],"minimumRows":1,"maximumRows":100000}]}
```

只接受结构化检查，不接受 SQL 脚本、视图或应用代码；数据库只读打开、禁用扩展加载/不可信 schema，独立子进程有时间/输入/输出预算。检查表、列与行数范围，不验证业务语义。资料须来自包含 `database.sqlite` 的 SQLite 导出快照。仅恢复到新目录，不连接或替换生产库；检查失败退出非零，保留恢复出的副本供私下排查，**不能称恢复业务验收成功**。

PostgreSQL 仍为单库逻辑导出与受控独立数据库 CI，不是 WAL/PITR。真实 VSS 请求器未实现，仍失败关闭且不退化为 live 文件复制。缺少管理员环境时只执行租约故障模拟，不能冒称已冻结应用。

## 4. 远端版本与保留信息审计

```sh
node bin/moonrestore.mjs remote-audit RECEIPT_KEY RECEIPT_SHA --endpoint https://YOUR-ENDPOINT --bucket YOUR-BUCKET --version PINNED_VERSION --batch 100 --offset 0 --remaining-days 7 --allow-remote
node bin/moonrestore.mjs remote-writer-policy YOUR-BUCKET moonrestore
```

凭据只使用明确的 `MOONRESTORE_S3_ACCESS_KEY_ID` / `MOONRESTORE_S3_SECRET_ACCESS_KEY` / 可选 `MOONRESTORE_S3_SESSION_TOKEN`，不读取其他云凭据链。回执与每个成员都必须有非空、非 `null` 固定 versionId；精确核对返回版本、密文 SHA-256、字节数及可选服务端 COMPLIANCE 保留返回。最新版本有删除标记时依然只读指定旧版本。无版本的旧回执可继续走原有授权恢复流程，但不能宣称满足此固定版本审计。

每批 1–1000 成员，结果提供 `next_offset`。后续页成功不等于整份回执已全量通过；本轮不实现持久审计周期合并。只读，不试删、不更改 IAM、不设置保留期。IAM 输出仅为需人工审查的桶/前缀模板，显式拒绝删除/绕过治理权限，不包含设置保留权限，也不是可不经审查部署的通用云策略。传输密文核验**不是明文恢复**，更不是独立账号、真实云商或同账号恶意删除防护证明。

## 5. 分块检查点与规模边界

持久备份在文件内部每 1024 个完整 CDC 分块记录一次认证检查点；提交顺序是对象落盘后才记录检查点，完整清单仍最后发布。加密仓库的部分日志同样认证加密。续作重新读取源前缀，重算分块及摘要，并验证已有对象，才复用已写分块；源/对象/日志变化拒绝提交。不是免读、seek-only 字节续传，也不等于硬件断电持久性证明。

本轮**不新增 live 存储格式**。仍有 32 MiB 清单、100000 条目、1000000 分块引用等既有预算；元数据仍受预算约束并驻留内存。live 分页清单、有界磁盘索引、对象 pack、压缩和新格式安全回收尚未实现，运输归档分页不能替代这些。64 GiB 单文件/1 TiB 快照是拒绝阈值，不是上限实测。

## 6. 工作台及系统任务

保留原生 JS/CSS、回环会话授权、离线资源和“不覆盖已有目标”行为。新增恢复目标、SQLite/本机 PostgreSQL 与加密 S3 计划配置、救援包生成/检查/新目录恢复、私有状态预览迁移、只读远端审计及 Windows 系统任务预览/精确确认。S3/数据库密钥不在表单输入或浏览器存储；网络与恢复写入各自确认。救援配方、运行包摘要和恢复密钥仍应独立保存。

Windows 系统任务为当前用户 InteractiveToken/LeastPrivilege，不提权，不覆盖既有同名任务。**注册调用超时可能已经创建任务**；结果未确认时先核查准确任务名，不能直接重试或假定未创建。受控 QA 只操作绑定自己临时状态的精确任务，清理不确认时保留私有夹具/记录，不报告清理完成。本机本轮注册/删除 RPC 超时，真实调度执行与清理未得到完整确认，不能将 XML 预览/模拟作为系统任务验收通过；具体边界见 QUALITY_REPORT。不要因此修改已有任务或重启系统服务。

## 7. 维护复现

```sh
npm run validate
node --test tests/readiness-state.test.mjs tests/readiness-http.test.mjs tests/remote-audit.test.mjs tests/sqlite-recovery.test.mjs
node scripts/readiness-browser-qa.mjs
node scripts/package.mjs
node scripts/large-file.mjs --checkpoint-resume --durable-restore
```

浏览器 QA 需另行安装 Playwright 并指定 `MOONRESTORE_PLAYWRIGHT`（模块目录）及必要时 `MOONRESTORE_BROWSER`。均为合成夹具；不访问真实云、注册系统任务、替代外部用户或长期生产验证。系统任务专项另需人类明确授权，不属于默认 validate。

本轮新核心 API 在 `core/pkg.generated.mbti`，仅源码提供；正式注册表仍为 0.5.0。原始申报书作为私有提交时点记录保留，不覆盖、不上传。当前实现及剩余路线以本指南和 NEXT_UPGRADE_EXECUTION 为准。

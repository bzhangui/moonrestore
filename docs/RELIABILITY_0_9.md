# 0.9 操作指南与能力边界

源码0.9.0；注册表仍0.5.0。本轮只授权测试后推送GitHub，不发布Mooncakes/运行包。以下都是可执行源码入口，不代表已经具备真实生产证明。Node >=22.16、moonc >=0.10.15，先 `npm run build`。新库/恢复目标须不存在且互不包含，父目录须存在；示例路径和ID要自行替换。

## 日用与认证续作

```sh
node bin/moonrestore.mjs storage-capabilities EXISTING_PARENT
node bin/moonrestore.mjs paged-init NEW_REPO --encrypted
node bin/moonrestore.mjs paged-capabilities REPO
node bin/moonrestore.mjs plan REPO SOURCE --exclude node_modules
node bin/moonrestore.mjs backup REPO SOURCE --label draft
node bin/moonrestore.mjs verify REPO all
node bin/moonrestore.mjs drill REPO SNAPSHOT_ID
node bin/moonrestore.mjs paged-operation-create REPO SOURCE --label draft
node bin/moonrestore.mjs paged-operation-status REPO UUID
node bin/moonrestore.mjs paged-operation-run REPO UUID --recover
```

密码仅从本机 `MOONRESTORE_PASSWORD`、独立密钥文件或工作台会话提供，不放命令参数、配置、截图或仓库。工作台可明确选择新格式，不转换旧库；历史/搜索/目录/差异/文本预览不等于全内容校验。密钥导出 `key-export REPO --output NEW_PRIVATE_FILE`，必须与仓库分开；换密码只重包主密钥，不撤销旧配置。

普通backup自动创建私有操作。完整对象包先落盘/读回，再写认证批次链；源身份/元数据清单冻结，源变动拒绝续作。`--recover` 仅恢复同主机、相同操作与仓库、PID已死亡的精确租约，不能抢活锁。恢复是**重新扫描源、核验复用对象**，不是免读前缀或任意源变化续写。暂停操作的未发布对象可能被GC回收，续作会从未变源重新生成，日志不是独立备份。

私有持久提示HMAC认证、加密源值也加密，24小时后重审。每个复用块仍重新读取并校验；坏候选重新存储，不覆盖旧坏内容。坏历史根/页/包不阻止新源独立备份，但历史健康与新备份结果分开；GC和完整审计必须重新校验全部live根，不能凭缓存删除。

## 选择恢复、巡检与极端情况

```sh
node bin/moonrestore.mjs paged-selected-preview REPO SHA NEW_TARGET --selections PRIVATE_PATHS_JSON
node bin/moonrestore.mjs paged-selected-restore REPO SHA NEW_TARGET --selections PRIVATE_PATHS_JSON --confirm TOKEN
node bin/moonrestore.mjs scrub REPO --snapshot SHA --files 100 --bytes 268435456
node bin/moonrestore.mjs recovery-health REPO --max-age-hours 24
```

选择文件是最多128个精确相对路径JSON数组，如 `["paper","code/main.mbt"]`，不是glob。预览绑定根、目标父目录身份、选择和健康摘要；目标已存在、越界或状态变化拒绝。每个恢复文件独立磁盘读回后才排他发布。

预览/执行都显式加 `--partial` 才跳过损坏文件；需新确认，返回 `ok:false,complete:false`/退出1表示仍有未恢复文件，不补零、不假装全量成功。根/页链损坏而无法证明边界时拒绝，需要健康副本；不承诺从任意残片恢复目录。恢复写出阶段不支持断点续写已有目标，旧“可续作恢复”专用入口不可当作分页能力。

巡检按完整文件预算推进认证游标、每批重新验证页结构，记录最早检查时间；`all_bytes_just_read:false`。超预算文件明确pending，需提高预算，不能被悄悄跳过。丢缓存仅丢进度，过期/时钟回退重新开始，不保证未来数据不会损坏。

介质探测只操作自己随机目录，检查条件硬链接/排他创建/发布并清理夹具。Windows目录fsync、NAS/硬件掉电语义不因探测通过而得到证明。不支持必要能力的文件系统拒绝建库。保存字节、路径、mtime与可选POSIX mode；ACL、ADS、xattr、稀疏洞、硬链接关系不保留，链接/特殊文件拒绝，不是系统映像。

## 保留、追加副本和新库重建

默认不删快照。私有策略例子：

```json
{"keepLast":10,"minimumDays":30,"pins":[],"graceDays":7,"acknowledgeLocalOnly":true}
```

最后一项是操作者明确接受尚无已验证独立副本的风险，不是程序默认勾选，也不是独立副本证明。

```sh
node bin/moonrestore.mjs paged-retirement-preview REPO PRIVATE_POLICY_JSON
node bin/moonrestore.mjs paged-retirement-request REPO PRIVATE_POLICY_JSON --confirm FIRST_TOKEN
# 至少7个真实日后：
node bin/moonrestore.mjs paged-retirement-finalize REPO REQUEST_UUID --confirm SECOND_TOKEN
node bin/moonrestore.mjs paged-replica REPO NEW_OR_SAME_IDENTITY_CLONE
node bin/moonrestore.mjs paged-rebuild REPO NEW_REPO --snapshots SHA,SHA
```

请求宽限期根保持live，GC仍保护对象。最新N、最小年龄、pins、共享保护策略和本机计划引用都保留，异常计划/清理保护阻断。最终全审计、复核保护和原库存，实际演练保留点后才删除根；原根变化/新增保护阻断。期间允许新增且通过完整审计的健康备份，但绝不扩展原先确认的删除集合，避免日常备份使保留流程永远无法完成。删除前私有保存根回执，不确定unlink中断需人工核对，不猜测。对象不随根删除；GC隔离和再等至少7日的purge是独立流程。私有根回执不是独立备份。容量预估不是空间预留。

退休宽限期还核对OS uptime与墙钟差值，误差超过60秒或uptime回退拒绝自动完成，不能只调快日期跳过等待。重启/休眠计时差异或未知时钟需重新发起观察/请求，不猜测累计天数；普通用户权限无法对抗整个OS/本机账号同时失陷。测试只在内部函数注入两套时钟，不在CLI暴露“跳过七天”。

副本只追加/不传播删除，已有目标必须是同仓库和主密钥身份；坏成员不覆盖。新库重建恢复并读回所选快照，再写新仓库，保留历史时间/标签和ID映射；不透明迁址原pack。需要额外空间与临时明文，失败新暂存保留，原库不变。默认新加密库，密码由 `MOONRESTORE_DEST_PASSWORD` 提供；`--plaintext` 是明确降密。新主密钥仍不能撤销旧副本/旧密钥。

## 远端、新状态与运行包

既有 `s3-push/s3-restore/s3-drill` 已识别格式4分页密文回执。仍需显式联网、加密源、条件不覆盖PUT、摘要/版本GET；不自动启用不可逆保留。128成员/页、256KiB/页、4096页、2MiB根、524288成员/2TiB是拒绝预算，不是云规模验证。根回执最后提交，独立保存receipt key/checksum/version和恢复密钥。

下载只发布完整审计通过的新仓库；s3-drill再做明文恢复读回。回执不含文件名/正文/凭据。`rescue-kit/rescue-check/rescue-restore` 支持同平台独立校验运行包和新状态恢复，不依赖旧任务/索引/DPAPI；包不含业务资料和密钥。本轮只私有打包检查，不上传附件。升级前保留旧程序/原库，先验证新包，不原地改格式。

旧运输归档、旧持久搜索索引、旧游标远端审计、双供体修复尚不通用于格式4；使用分页搜索、巡检、s3-drill、同身份副本或新库重建。元数据冗余、完整属性保真和跨时间线自动恢复仍是深化方向，不宣称完成。

## 后台、应用与通知

`plan-runner --interval 15000` 手动启动监督式当前用户进程，`--cycles N` 限定次数；单实例，计划预算/时钟/设备/源异常保护保留，休眠后处理到期计划不追赶连跑。退出/注销持续执行未验证，不安装服务或存账号密码；服务身份另需授权，见 [Microsoft安全上下文](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)。本轮专用OS任务注册前状态未确认，未尝试注册并清理本轮夹具；不处理旧遗留任务。

SQLite使用在线导出，恢复后重开检查；PostgreSQL保留逻辑/物理备份与Unix隔离PITR原生工具门禁，不改生产配置。

```sh
node bin/moonrestore.mjs wal-archive-bind ARCHIVE --cluster SYSTEM_ID --segment-bytes 16777216 --confirm ARCHIVE
node bin/moonrestore.mjs wal-health ARCHIVE PRIVATE_WAL_CONFIG_JSON
```

WAL配置例：`{"baseMetadata":"/private/physical.json","timeline":1,"expectedEndLsn":"0/5000000","archiveStatusDirectory":"/owned/pg_wal/archive_status"}`。绑定是操作者声明，`wal_header_identity_verified:false`；实际检查归档/回执、LSN段连续性、缺口与.ready积压。不从LSN推断时间，不自动跨时间线，不删WAL或基准。完整段、timeline history和backup history可归档；必须连续保留基准备份所需WAL，参考 [PostgreSQL官方文档](https://www.postgresql.org/docs/16/continuous-archiving.html)。原生回放证据看本次CI，合成字节不是有效WAL。

`alert-deliver MONITOR_DIR ADAPTER_URL --confirm ADAPTER_URL` 通过 `MOONRESTORE_ALERT_TOKEN` 授权；非回环另需 `--allow-remote`/HTTPS，不绕过证书。发送聚合状态和幂等事件ID，无业务路径。适配端须回同event_id、persisted:true、delivered:true和receipt_id，才记最终适配回执；丢回执重试同事件。真人已读/真实渠道/主机独立性仍不由回环测试证明，默认不联网发送。

MoonBit负责分块/SHA/路径/页与文件状态/汇总/操作状态/保留和宽限期，Node负责OS/加密/SQLite/HTTP/进程和应用适配。不是纯MoonBit系统运行时；测试通过不替代赛事对主要实现语言/完成度的判断。完整本机、CI、模拟/真实环境区别见 [QUALITY_REPORT](QUALITY_REPORT.md) 和 [PUBLICATION](PUBLICATION.md)。

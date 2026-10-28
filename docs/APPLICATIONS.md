# 应用备份：SQLite 与 VSS

0.8新增的物理PostgreSQL/WAL/隔离PITR及原生VSS授权、预算、临时明文和真实环境缺口见 [0.8完整指南](RELIABILITY_0_8.md)。SQLite旧入口不变，不把物理PITR或VSS自动加入现有计划。

## 单个 SQLite 主库

`sqlite-backup REPOSITORY DATABASE_FILE [--label TEXT --timeout 120000]` 需要 Node ≥ 22.16.0 标准 node:sqlite 在线 backup API。只读源库、禁止加载扩展，在私有区导出，integrity_check 后才请求备份，再 audit 和隔离恢复读回。包含 WAL 中已提交事务，不把未提交事务视为成功资料；不能直接复制 .db 替代此入口。

有界独立 worker、超时/取消；源最大 64 GiB，仓库更小格式/元数据预算仍适用。仅支持一个主库，不保证多 ATTACH 数据库、跨服务或其他数据库厂商的一致性。Node 的实验性 SQLite 警告是运行时状态，不等于外部审计。

即使目标仓库加密，导出会短暂落地明文。仅位于私有 application-staging/sqlite-stage-*，结束只删除本次自建目录。普通删除不保证 SSD 安全擦除；敏感场景需全盘加密和可信账号。后续校验失败不回滚已提交完整快照。tests/applications.test.mjs 实际开启 WAL、保持连接和未提交事务，恢复后重新用 SQL 查询；无效库无快照、暂存清理均有断言。

## VSS：受控生命周期，不冒充真实热备

`vss-plan SOURCE` 只读检查 Windows VSS 服务/管理员身份并列出要求，不创建阴影副本，不提权、不运行任意脚本。`provider-rehearsal REPOSITORY` 仅用内部合成文件演练租约、备份、audit、恢复和释放。会在指定仓库增加合成快照，请使用专用测试仓库。

writers 未就绪、挂载重叠、备份或释放失败不得报成功；取消也要释放精确租约。0.8已提供原创Windows SDK请求器和显式 `vss-backup --allow-native-vss`；只有品牌化、已授权的本机请求器可激活，伪装成windows_vss的自定义对象仍拒绝。当前只完成编译/协议/受控生命周期，**真实管理员snapshot/writer尚未验证**。绝不退化为live copy或nowriters，不全局删除影子副本。写入器参与也不等于任意业务一致性保证。

提供器的 create 若在返回租约前抛错，必须自行回滚其尚未交付的资源；协调器无法安全删除一个没有精确身份的外部快照。当前合成提供器没有真实系统资源。

后续需授权管理员环境、Diskshadow/原生请求器、实际 writer 健康/备份完成通知、精确清理及崩溃恢复验证。当前无此环境，普通目录备份仍要求先停写或使用应用官方导出。

官方依据：[Node SQLite](https://nodejs.org/api/sqlite.html)、[SQLite 在线备份](https://sqlite.org/backup.html)、[Microsoft VSS](https://learn.microsoft.com/en-us/windows-server/storage/file-server/volume-shadow-copy-service)。仅参考接口语义，不复制外部脚本/SDK。

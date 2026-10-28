# 0.8 故障验证范围

这里只记录可复现测试的覆盖面，不声称穷尽所有组合。合成资料不是真实用户试点；异常码注入不是实际填满用户磁盘。原始路径、报告和夹具不公开。

| 故障/行为 | 可复现入口 | 安全结果 |
| --- | --- | --- |
| 注册超时但实际已创建、核对未知、冲突任务、改变间隔、运行中删除 | tests/os-task-state.test.mjs | 意图先保存、后核对；未知不重试、不强停或误删 |
| 远端坏版本、403、保留期不足、审计跨页失败、游标篡改、活锁 | tests/remote-audit.test.mjs | 不推进失败页，不以部分审计冒称整轮完成 |
| 接收认证失败、重复/倒退序号、响应丢失重试、过期/缺席/时钟回退、重启 | tests/monitor-receiver.test.mjs | 私有持久回执；重复不刷新年龄，远端需TLS，未确认投递 |
| 多页、空源/空文件/空目录、排除、去重、加密索引与文件 | tests/paged.test.mjs | 全量记录与内容检查，恢复独立磁盘读回 |
| ENOSPC/EIO/EACCES/EROFS、提交前中断 | tests/paged.test.mjs | 受控注入，不发布新根；旧根仍可核验；恢复目标不出现 |
| 正确摘要的语义伪造、大小写碰撞、坏页/包、包膨胀上限 | tests/paged.test.mjs / core/paged.mbt | 不信任摘要以外的结构；写目标前拒绝 |
| 发布两链接窗口中断、GC移动中断、陈旧预览、活锁 | tests/paged.test.mjs | 精确别名修复/回滚、阻断写入、不接管活进程 |
| 隔离未满7天、错误永久清理确认、已到期批次 | tests/paged.test.mjs | 不删快照；再次审计所有根后只清理确切无引用批次 |
| 旧格式迁移 | tests/paged.test.mjs | 原仓库逐文件摘要不变，新仓库可恢复；不原地改写 |
| 64MiB随机文件+500小文件、多包/页、大文件完整读回 | scripts/paged-qa.mjs | 有512MiB余量门禁、单独SHA与进程峰值；非极限规模证明 |
| VSS状态失败/未释放/取消、假冒原生provider、变更set/无writer | tests/snapshot-provider.test.mjs / tests/vss-protocol.test.mjs | 释放失败不报备份成功，不回退活拷贝；仅受控协议 |
| VSS C++ SDK与协议版本 | scripts/build-vss.mjs | 编译和无副作用协议探测；不创建影子副本，不代表真实writer验证 |
| PG大版本混用、tablespace、假工具未标记、短/冲突/坏WAL | tests/postgres-physical.test.mjs | 受控生命周期与参数校验，未伪称原生数据库证明 |
| 原生物理基准、完整WAL、指定时间暂停、恢复行数2/源行数3、停止自有服务器 | tests/postgres-pitr-native.test.mjs | 专用PG16+合成集群，默认本机跳过，专项CI强制运行；结果见精确提交 |
| 旧SQLite/逻辑PG/任务/救援/加密/HTTP/签名/归档 | npm run validate | 维持原有行为及安全门禁，所有默认测试统一统计 |
| 下载→全审计→解密恢复读回总耗时 | tests/remote.test.mjs | 本机受控S3，真实云/独立主机不因此通过 |
| 新运行包无旧状态恢复 | npm run package | 白名单、摘要/许可、实际包内加密paged恢复；不公开包 |

未验证：真实云IAM/ObjectLock/独立账号、管理员VSS实际writer/异常释放、独立磁盘/NAS/跨主机、硬件断电、长期生产、多租户恶意并发、声明上限规模及所有故障组合。Windows任务本轮实际演练在注册前核对未知，禁止注册；旧轮遗留状态需操作者精确核查。本轮不为补齐证据而提权、重启服务、联系外部用户或上传私人数据。

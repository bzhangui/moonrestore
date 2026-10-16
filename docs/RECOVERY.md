# 校验、恢复演练、加密、副本与安全清理

## 校验和演练的含义

`report REPO [ID|all]` 运行 MoonBit 完整内容诊断，文件校验失败不会导致其余已验证清单的文件静默略过。清单本身不可信时，不按其中路径继续访问。每快照最多记录 100 个失败明细，并明确截断；失败不会标为通过。空仓库不能作为有效备份通过。

报告包含时间、版本、范围、快照 ID、经过校验的文件/字节数量和问题代码。JSON/HTML 默认去掉失败文件相对路径；`--details` 明确保存详细信息。报告是本次观测，不是永久认证；公开前仍应人工审查，SHA-256 和报告文件自身都不是独立签名。

`drill REPO ID [--parent EXISTING-DIRECTORY] [--prefix RELATIVE]` 在该父目录新建自有临时目录，完整预校验快照，恢复选定内容，再重新读取恢复后的文件核对大小与 SHA-256。部分恢复报告明确标为 selected_subtree；失败、空间不足、清理失败都不写成成功。只自动移除本次生成且身份/父目录匹配的临时目录，不清理原资料。

## 加密初始化和解锁

在安全的本机环境设置 `MOONRESTORE_PASSWORD`（12..4096 UTF-8 字节，建议使用密码管理器生成的强密码），然后运行：

```sh
node bin/moonrestore.mjs init-encrypted NEW-REPOSITORY
# 需要显式大文件 profile 时：
node bin/moonrestore.mjs init-large NEW-REPOSITORY --encrypted
node bin/moonrestore.mjs key-export REPOSITORY --output PRIVATE-DIRECTORY/recovery-key.json
```

不得把真实密码写进示例、源文件或 CLI 参数。解锁顺序为显式私有恢复密钥文件 `MOONRESTORE_KEY_FILE`、密码、当前用户已授权的 Windows DPAPI 存储。显式提供错误凭据不会悄悄回退为其他成功方式。

认证加密使用 Node/OpenSSL 的 AES-256-GCM；密码用 scrypt（N=131072,r=8,p=1）派生包装密钥，随机 32 字节仓库密钥、独立随机 12 字节 nonce。对象和快照在磁盘上加密，物理名称由带用途的 HMAC 派生；明文逻辑 ID 保存在认证密文内。AAD 绑定仓库、对象类型和物理名称，跨仓库/类型替换、改动密文或错误密钥均拒绝。不要描述为已完成独立密码学安全审计。

仓库标识、对象数量/长度、访问时间和本机锁的 PID/主机名等并不完全隐藏。删除权限未被加密限制；有写权限的攻击者仍可能销毁仓库。备份加密不等于防勒索、不可变存储或跨主机灾备。

恢复密钥文件可直接解密数据，是高敏材料；必须与仓库分开加密保管并测试可用性。POSIX 使用 0600/0700；Windows 普通导出文件仍依赖可信目录 NTFS ACL。Windows `key-store REPO` 是显式当前用户 DPAPI 授权，不导出密码，不保证换机后还能解锁。丢失全部解锁方式没有后门。

载荷加密密钥使用标准 HKDF-SHA256 从仓库密钥派生，与物理名称 HMAC 的用途分开；`encryption.json` 的 cipher 标识为 `AES-256-GCM-HKDF-SHA256-v2`。未发布开发草稿的临时加密配置不承诺兼容，不更改原有明文仓库。

## 独立副本与旧仓库迁移

```sh
node bin/moonrestore.mjs replicate SOURCE-REPO NEW-OR-EXISTING-DESTINATION
node bin/moonrestore.mjs replicate SOURCE-REPO NEW-DESTINATION --encrypted
```

源仓库使用通常解锁方式，目标使用 `MOONRESTORE_DEST_PASSWORD` 或 `MOONRESTORE_DEST_KEY_FILE`；已授权的当前用户目标 DPAPI 存储同样可用。新目标独立产生密钥，不直接搬运源解锁凭据。

复制前完整校验源数据，复制时持有双方仓库锁并核对规划期间仓库没有变化，逐对象核对，再提交完整快照；完成后对目标执行完整诊断。重复复制跳过已有相同内容；不传播删除、不覆盖损坏对象。中断可能留下已完成快照或未引用对象，不发布半个清单。已有目标内无关快照也必须通过最终诊断。

旧格式不原地升级。需要加密或大文件能力时迁移到新的相容仓库，保留旧仓库并在新仓库做恢复演练。格式 3 快照不能复制到旧 profile 目标；新建复制目标自动选择相容 profile。

同一设备上的第二个目录不是独立介质证明。程序不自动判断两个盘符是否位于同一物理盘，不声称已经完成 NAS 或第二主机验证。S3/远程存储适配尚未提供，不把普通目录复制称为云备份。

## 保留与回收：两个确认阶段

先运行预览：

```sh
node bin/moonrestore.mjs prune REPO --keep-last 10 --daily 7 --weekly 4 --monthly 12 --protect FULL_SNAPSHOT_ID
```

策略由 MoonBit 计算，按 UTC 自然日、周一开始的周和自然月，保留最新若干个有快照的时间桶；与 keep-last 和受保护 ID 取并集。保留数不是“过去若干天”的时间窗口。每仓库代表一个资料集；没有自动识别多个来源的分组策略。未来时间、未知/损坏清单、丢失对象、错误预算和过大的维护批次均拒绝。

使用同一组参数加 `--apply PREVIEW_CONFIRMATION` 才执行；仓库状态、保留策略或候选条目变化时原确认失效。每批最多 100000 个条目。保留快照的共享对象不回收。

第一阶段将候选快照/对象移到仓库 `trash/批次ID/`，记录原路径和校验和。**这一步没有释放对象所占空间。** 保留至少 7 天后，才可分别预览和确认永久清除：

```sh
node bin/moonrestore.mjs purge REPO BATCH_ID
node bin/moonrestore.mjs purge REPO BATCH_ID --apply PURGE_CONFIRMATION
```

永久清除后不可从该隔离批次恢复；应已有独立可恢复副本。时钟提前可能影响到期判断，程序不提供抗恶意时钟保证。日期推进单测不是实际等待七天的生产验证。

隔离中断会留下 `.maintenance.json` 并阻止普通仓库操作。先确认原进程已停止，再用预览中的仓库随机标识显式回滚：

```sh
node bin/moonrestore.mjs maintenance-recover REPO --confirm REPOSITORY_IDENTITY
# 已完成隔离且尚未开始永久清除，也可以指定批次恢复：
node bin/moonrestore.mjs maintenance-restore REPO BATCH_ID --confirm REPOSITORY_IDENTITY
```

恢复有冲突、隔离数据损坏或永久清除已开始时拒绝，不覆盖新资料。无价值空目录和维护收据可能保留；不使用递归删除来清理整个仓库。磁盘已满时隔离/清理也可能失败，因此容量预警必须提前处理，不能依赖“满了再自动删”。

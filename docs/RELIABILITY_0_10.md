# 0.10 恢复写出续作与元数据保真

源码开发版。本轮仅推送 GitHub；不发布 Mooncakes 或运行包。原有格式1/2/3/4保持可读且不原地改写，注册表0.5.0不含本轮新API。

## 可续作恢复：先创建，再运行

仓库、源及父目录须由使用者控制，恢复目标必须不存在。先在合成目录练习，不要删除原件。

```sh
# format4或format5：冻结快照、选区、目标、策略及源健康摘要
node bin/moonrestore.mjs paged-restore-create REPO SNAPSHOT NEW_TARGET --confirm NEW_TARGET
# 从实际输出复制operation UUID
node bin/moonrestore.mjs paged-restore-run REPO UUID
node bin/moonrestore.mjs paged-restore-status REPO UUID
# 仅原进程已经死亡、同主机、精确绑定的遗留租约才允许恢复
node bin/moonrestore.mjs paged-restore-run REPO UUID --recover
```

format5默认native，必须另加 `--permissions`；明确接受扩展属性损失时选 `--metadata portable`。`--selections PRIVATE_JSON` 内容为最多128个精确相对路径前缀的JSON数组，不使用glob。`--partial` 才允许跳过坏文件，结果complete/ok仍为false，不补零。一步入口为 `restore-resumable REPO SNAPSHOT NEW_TARGET [--permissions] [--metadata native|portable]`；返回operation，后续使用本页分页恢复状态/运行命令，不使用旧格式的operation-resume。

私有状态位于 `MOONRESTORE_HOME/paged-restores-v1/UUID`，应放在源目录以外、稳定且有空间的本机磁盘。每个文件收据独立认证；加密源日志负载同样加密。日志和密钥不是独立备份，不随普通配置迁移；丢失它们就不能接管旧暂存区，应保留旧区并创建另一个新目标。

### 写出协议

1. 完整验证快照/元数据链及选区健康；冻结目标父目录身份。新建私有同卷暂存容器，内容树和工作文件分离。
2. 核对暂存文件身份、长度及链接数，逐字节验证已有前缀，再从实际末端继续。已同步但未落检查点的尾部只在读回吻合时接纳；不保存或恢复内部哈希器状态。
3. 每块同步后保存认证检查点；完整文件核验后移入内容树。重放较早完成文件时不清除较晚文件活动收据。硬链接仅在选中且同组、数据/元数据相同的内部文件之间重建。
4. 重新清点路径、身份和外部链接，全部文件再独立读回，应用并验证元数据；排他发布到尚不存在的新目录。
5. 发布后、完成记录前退出，只能对账同一个已记录树身份并重新核对内容。陌生目标、坏前缀、源健康变化、活动/异地主机租约、外部硬链接或失效收据拒绝覆盖。

有意保留已完成私有收据和空暂存容器供发布对账，不自动删除用户目录。任意机器指令之间断电、目录创建与收据落盘间、文件创建与身份落盘间退出可能留下不能证明归属的孤儿，程序安全拒绝，不承诺每个指令边界都能自动续作。format4旧选择恢复入口保持兼容；需要写出续作使用本页入口。

## 显式format5归档扩展元数据

```sh
node bin/moonrestore.mjs fidelity-init NEW_REPO
# 密码仅通过交互/私有会话环境配置，不写入命令、配置或提交
node bin/moonrestore.mjs fidelity-init NEW_ENCRYPTED_REPO --encrypted
node bin/moonrestore.mjs backup NEW_REPO SOURCE
node bin/moonrestore.mjs verify NEW_REPO all
node bin/moonrestore.mjs restore-resumable NEW_REPO SNAPSHOT NEW_TARGET --permissions
```

工作台历史/备份识别format5，恢复权限勾选即原生属性的明确同意。便携有损策略与恢复ID高级管理目前使用CLI。普通restore及选择预览/恢复也不对format5悄悄降级。

| 属性 | 支持和限制 |
| --- | --- |
| 内容/目录 | 全部字节读回、相对路径、空文件/空目录，包含源根目录元数据 |
| 时间 | atime/mtime十进制纳秒归档；Windows原生100ns精度，含creation time恢复；POSIX原生utimensat读回。探测可能改变atime，之后重设并stat核对 |
| Windows | 原始DACL/owner/group的SDDL归档；恢复为受保护显式ACL，保持有效ACE顺序/权限/属主并阻止新父目录追加规则，不保留原继承拓扑。安全属性、每文件≤16个ADS/总64KiB；源EFS、压缩、重解析点拒绝。不启用特权，不处理SACL/完整性标签或全部NTFS特性 |
| Linux/macOS | uid/gid、基础mode、二进制xattr；macOS另含extended ACL。有权应用并读回才成功，不提权。特殊mode位不归档；POSIX birthtime只记录不恢复 |
| 稀疏 | 捕获系统报告的分配范围，只写这些范围并逐步扩长已处理前缀；Windows先设sparse。原生读回不一致即拒绝，不等于物理块/压缩/布局位级相同 |
| 硬链接 | 归档实际同inode的组，仅重建所选内部成员；单个选中成员nlink=1，不链接外部文件。旧格式仍拒绝硬链接源 |

metadata_profile_verified=true仅表示上表原生配置读回通过；**all_filesystem_metadata_preserved始终false**。ctime由OS管理，特殊mode位、POSIX birthtime恢复、厂商属性和物理布局不在承诺内。属性可能含作者、来源、SID、下载标记等隐私，建议加密；普通明文库的元数据也为明文。

Windows报告 `windows_acl_inheritance_frozen_original_descriptor_archived`：比较归一后的有效ACL/owner/group，不用忽略权限项来消除差异；普通allow/deny配置仅对同类可交换规则规范排序/合并，不把deny移过allow。原始SDDL仍在快照中，继承来源标记及随新父目录变化的行为不恢复。NULL DACL、deny在allow之后、object/callback/条件ACE等无法安全验证的配置拒绝，不用放宽访问作为回退。需要保留整套继承拓扑时还需独立的受控父目录/ACL迁移流程，不能把新位置的普通恢复当成完成。

native要求同平台和 `--permissions`。同平台不代表文件系统能力相同：目标不支持xattr/ADS/稀疏、权限不足、只读或属主不可设置时失败并保留暂存，不默认跳过安全属性或降级成功。portable明确只恢复内容/基础修改时间及可选基础mode，报告元数据损失，不称保真。

macOS空ACL与未取得ACL不能仅凭acl_get_file的ENOENT区分。帮助程序通过同inode的只读描述符、扩展安全能力、fstatx_np成功和FILESEC_ACL属性查询处理；成功查询的缺省ACL归一为零条目ACL，保持访问语义，不声称保留缺省/显式空的内部表示差别。能力/权限/查询错误仍拒绝，不将其归为空ACL。

### 格式、预算及其他入口

format5具有独立明文/加密标识；内容页/包沿用format4协议，根另绑定有序fidelity元数据页链。元数据路径与内容清单一一对应，额外含源根；组内内容摘要、长度及元数据必须一致。页/负载溢出拒绝整个快照，不截断。

每页≤128条/256KiB，单元数据记录≤245000字节，快照元数据≤1GiB；xattr≤128项、单值≤64KiB/总128KiB；Windows ADS≤16项/总64KiB；ACL≤64KiB；稀疏范围≤4096。文件/总字节沿用64GiB/1TiB拒绝预算，**不是上限性能认证**。续作同步每块日志、临时SQLite及收据也有IO/空间开销，仍须验证源及前缀。

内容基础mtime仍受原分页格式的非负毫秒/9999年上限约束，不支持源mtime早于1970；POSIX原生atime/mtime帮助程序限有符号64位纳秒范围，超出拒绝，不静默截断或取近似值。目标文件系统时间精度更低时原生读回失败。

物理复制/分页密文运输/GC完整索引保护元数据页。format5重新分块/换主密钥重建暂拒绝：文件系统往返会改变原始元数据，不能以内容相同冒称原样重建。先使用验证的paged-replica；format4重建不变。旧运输归档、双供体修复等仍依0.9限制，不因新标识自动支持。

## 验证与真实环境缺口

运行 `node --test tests/paged-restore-v10.test.mjs`，全量 `npm run validate`。测试覆盖真实子进程退出、短写、IO错误、检查点失败、前缀/身份/目标/租约篡改、发布对账、元数据链语义伪造、加密、稀疏/硬链接/只读、复制与GC。实际计数及精确CI见 [测试报告](QUALITY_REPORT.md) 与 [发布记录](PUBLICATION.md)。

不把进程退出等同物理断电，不把受控试点等同真实用户、生产、NAS或真实云；不能穷尽全部系统/文件系统/权限组合及故障交叉。本轮不创建系统任务、不请求管理员VSS、不发布包或原始报告。

# 仓库格式与兼容

## 0.8.0：显式 format 4

旧format1/2/3不变，只有 `paged-init` 在不存在的新目录创建format4。迁移原仓库只读，命令、边界和回退见 [0.8指南](RELIABILITY_0_8.md)。新格式尚未接入旧工作台/计划/S3/运输归档。以下的0.7及更早章节是旧格式规范，不约束format4。

- 目录：`moonrestore` 标识、`repository-id` UUID、可选 `encryption.json`、`pages/`、`packs/`、`snapshots/`、`tmp/`、`trash/`。标识为 `moonrestore-paged-repository-v4\n` 或 `moonrestore-paged-encrypted-v4\n`。
- 明文逻辑ID为SHA-256小写hex。加密物理文件名用原信封的分类型HMAC映射，AES-GCM绑定仓库密钥配置、类型和逻辑ID；包摘要是解压后原始包，不是压缩字节。顶层逻辑根ID应另存可信渠道。
- 根JSON：`format:4, repository:UUID, created:ISO, label:String, pages:Number, last_page:SHA|"", entries:Number, chunks:Number, bytes:十进制String, excludes:String[]`。空树零计数/空末页。最多1百万条目/1百万页/32百万引用/1TiB字节，标签200字符，排除最多64项/8KiB。
- 页JSON：`format:4, sequence:Number, previous:SHA|"", records:Record[]`，最多128记录/256KiB；序号0前序空，否则有效摘要。根指最后一页，先倒向校验全部链并写私有磁盘索引，再正向按文件状态机验证。不能靠单页通过冒称整快照通过。
- 记录：`kind,path,id,size,pack,offset`；size为十进制字符串，file/dir还需`mtime_ms`字符串及0..511的基础mode。dir大小0，file先声明长度；chunk只属于当前文件并指pack/offset/块ID，end给出完整文件SHA和相同长度。父目录必须已出现，路径合法、大小写唯一。单文件≤64GiB，单块1..1MiB；边界/总计由MoonBit验证。
- 原始包：ASCII `MRPK4\n`（6字节），随后每块为LE uint32长度+32字节块SHA+原始内容；原始包≤8MiB。物理编码ASCII `MRP4`+压缩标记u8（0或1）+LE uint32原始长度+原始内容或zlib deflate内容；解压输出硬上限8MiB，核对逻辑包SHA、块位置/长度/ID/摘要。加密额外使用现有64字节信封开销。
- 所有可见对象条件创建并读回，根最后提交。writer互斥；恢复先完整预校验，排他新目录写出并独立读回后提交。SQLite仅私有可重建缓存，单个一次性事务避免逐条fsync，关闭即回滚/清除；不会降低仓库对象/根本身的同步门禁，重启不复用它。
- GC完整审计所有根，隔离无引用页/包；清单SHA为批次ID，pending阻断写入，7天后独立确认清理，未完成的自身两链接移动精确回滚。不修复被篡改根，不删快照，不永久清理普通暂存孤儿。

这些是实现的拒绝预算，不是上限规模性能/断电保证；JSON字节编码和记录顺序属于根摘要，重排并不保留原ID。代码入口 `core/paged.mbt`、`cmd/storage`、`platform/paged-*.mjs`，互操作向量由 `tests/paged.test.mjs` 的实际创建/恢复验证。

## 0.7.0 及旧格式兼容范围（历史）

仍使用 live 格式1/2/3及其原有预算，不改分块/ID/快照编码，不原地迁移。新增部分文件检查点是**私有操作日志**，认证绑定仓库身份/操作/相对路径和分块引用；完整对象先提交，检查点每1024个完整块记录，最后提交完整清单。加密源的记录同样认证加密，物理日志文件名不暴露明文路径。续作要重读源前缀并验证已有对象，不能据日志推断源文件未变。

快照兼容与操作日志兼容分开：0.7操作请用同版本程序续作，不保证旧运行包能理解0.7内部协议；旧快照内容仍按原格式读取。配置迁移仅复制白名单静止配置，不迁移操作日志/密钥。live分页清单、对象pack/压缩、有界磁盘索引与新格式GC未实现，不能将独立运输归档格式冒称为live格式升级。

## 0.4.0 不改仓库编码

保留格式 1/2/3 的标识、分块和逻辑 ID，不原地迁移。健康证据与可丢弃索引位于私有状态目录，不能代替规范清单或内容校验。远端复制保留原密文对象/配置，用私有回执映射存储键/版本；恢复下载完整 audit 后形成新的本地仓库。未启用分段清单、对象打包或压缩。详见 RECOVERY_0_4、REMOTE；旧章节属于对应版本的历史说明。

## 0.3.0 可选属性扩展

清单可含 `metadata` 数组，条目为 path、十进制毫秒 `mtime_ms` 与精确整数 `mode`（0..511）。只接受快照中已有且不重复的路径，时间限定 0..253402300799000；扩展在原始清单字节哈希和原预算内验证。旧快照无需扩展，不改仓库标识。

默认恢复修改时间；POSIX 权限必须显式开启，不包含 setuid/setgid、所有者、Windows ACL、ADS 或 xattrs。基础 `Snapshot` 构造字段保持兼容；库作者需成对使用 `encode_with_metadata` / `decode_metadata` 保留扩展。0.2 可忽略新属性并恢复内容，不能恢复这些属性。实际旧/新运行包双向内容恢复与分块引用一致性有独立测试。

旧格式维护层累计清单模型预算 64 MiB，超出拒绝；不是无限规模/恒定内存。旧格式没有启用对象压缩；VSS属于0.8显式应用适配，不改变这些旧仓库的存储编码。

## 0.2.0 新增的存储/数据 profile

| 标识 | 含义 | 快照内 format |
| --- | --- | --- |
| `moonrestore-repository-v1` | 默认明文兼容仓库 | 1 |
| `moonrestore-encrypted-repository-v2` | 加密仓库，保持基础数据预算 | 1 |
| `moonrestore-repository-v3` | 显式大文件明文 profile | 1 或 3 |
| `moonrestore-encrypted-repository-v3` | 显式大文件加密 profile | 1 或 3 |

每个标识末尾有换行。旧工具会拒绝未知仓库标识。新工具不改写现有标识，不原地升级；复制迁移到新仓库后复核。大文件 profile 的单文件 64 GiB、单快照总内容 1 TiB 是预算，仍须同时满足原有 100000 条目、1000000 引用和 32 MiB 清单等上限。未提供分段清单或无限规模保证；元数据内存仍随受限条目/引用数量增长。

加密仓库增加 `encryption.json`：包含版本、仓库随机 ID、scrypt 标识/盐、认证包装后的仓库密钥、密钥校验值，不保存明文密码。磁盘物理对象 ID 为带用途 HMAC；文件包含 `MRV2`、12 字节随机 nonce、16 字节 GCM tag，以及认证加密的32字节逻辑 ID 和正文，总固定开销 64 字节。AAD 绑定仓库 ID、用途和物理 ID。Node 适配层解密后仍由 MoonBit 检查逻辑 SHA-256、长度和清单规则。

新增可选 `repository-id` 用于绑定任务与具体仓库，不参与数据内容身份。任务、报告和 OS 密钥封装存于独立私有状态目录。`trash/` 与 `.maintenance.json` 用于显式确认的维护事务，恢复规则见 [RECOVERY](RECOVERY.md)。

## 基础仓库格式 v1

```text
vault/
  moonrestore                  固定格式标识
  objects/ab/<64位sha256>       不可变原始分块；前两位决定目录
  snapshots/<64位sha256>.json   原始 UTF-8 清单字节的 SHA-256 即快照 ID
  tmp/<uuid>.part|.manifest     未提交临时文件
  .lock/owner.json              独占进程锁（PID、主机名、创建时间）
```

清单字段：`format`、`created`、`label`、`config`、`entries`。文件条目包含 `path/kind/size/hash/chunks`，目录条目显式保存空目录。`size` 为十进制 Int64 字符串，分块大小为精确 JSON 整数，SHA-256 为 64 位小写十六进制。

按源目录排序扫描，每个文件重新计算哈希和 CDC，不信任 mtime 缓存；同内容分块仅存一份。已存在对象也重新校验，损坏时拒绝备份而不是覆盖。快照清单最后提交。更改目录或标签不会影响对象复用，但会创建新快照 ID。

Gear v1：每字节从固定种子 `byte + 0x9e3779b9` 经 UInt 混合生成 gear 值，滚动值为 `(rolling << 1) + gear`；达到最小长度后低位 mask 命中或达到最大长度时分块。默认 min/avg/max = 8192/32768/131072 字节。算法确定、输入块边界无关，不是密码学指纹。

硬预算：每快照最多 100000 条目、单文件 2 GiB、总文件内容 64 GiB、1000000 分块引用、32 MiB 清单、16 层 JSON、64 层源目录、1024 字符相对路径；可复用核心允许下调预算，不允许突破这些上限。对象最大 1 MiB。字节缓冲流式，清单/路径索引仍随条目和分块数量增长，不宣称常量总内存。

v1 原格式不支持加密、压缩或跨机器分布式锁。0.2.0 的显式保留/回收在外层维护事务实现；`status` 仍不删除数据，`recover` 仍仅处理死锁/临时文件，不能代替 `maintenance-recover`。

# 仓库格式与兼容

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

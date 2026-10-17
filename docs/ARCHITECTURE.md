# 架构与实现边界

0.4 新增 MoonBit core/recovery.mbt（健康文件选择/巡检范围）及 app/recovery.mbt（逐文件救援/完整校验编排）。platform/recovery-target.mjs 将严格只读源 Host 与受限新目标 writer 分开，避免只读模式拥有源写/恢复写能力。工作台复用同一后端，部分结果和确认失效单独显示。

recovery.mjs 绑定确认、健康供体、独立清单与持久证据；search-index.mjs 是可丢弃非权威缓存；applications.mjs 调用 SQLite 标准在线导出；snapshot-provider.mjs 仅受控租约，无真实 VSS 请求器；s3.mjs/remote.mjs 适配显式授权网络 I/O 和密文副本，最终逻辑清单/内容仍回到 MoonBit audit。没有改变既有仓库编码。

0.2.0 新增 MoonBit `core/maintenance.mbt`（UTC 保留决策和精确容量规则）、`app/health.mbt`（逐文件诊断）、显式大文件 profile 与有界 16 对象校验缓存。缓存只在一次验证操作内存活，命中仍检查引用大小，文件完整哈希仍计算；不使用 mtime 跨运行跳过校验。

Node 新增 `vault.mjs`（系统密码学/DPAPI）、`maintenance.mjs`（调用 MoonBit 的报告、演练、复制编排）、`retention.mjs`（经确认的文件隔离/回收）、`jobs.mjs`（本机调度适配）、`workbench.mjs`（本机 HTTP）与 `ui/`。HTTP 界面和 CLI 复用内核，不维护另一套分块或恢复规则。保留算法仍为 MoonBit；物理 rename/unlink 是有界系统适配。

不把四目标核心说成四目标桌面应用；完整 Node 工具需要操作系统能力。加密仓库与逻辑快照格式分开，扩展 profile 不原地改变旧仓库。

MoonBit 核心库负责内容分块、SHA-256 内容标识、快照模型、路径与预算校验、恢复验证和快照比较。MoonBit 命令层负责编排备份、验证、恢复及中断处理。Node.js 提供操作系统文件接口；不是另一个备份引擎。

采用 JavaScript 目标是为了当前 Windows 设备可运行，并避免依赖尚未支持 Windows 文件系统的 async 适配。核心库同时验证 Wasm、Wasm-GC、JS 和 Native 目标。

仓库格式包含不可变内容对象、带 SHA-256 的快照清单、临时事务、独占写锁和恢复暂存目录。完整快照最后提交；不发布半个快照。恢复时先验证，再暂存所有内容，最后提交新目录。

只信任用户控制的源目录、仓库与目标父目录；拒绝链接和特殊文件，防止路径穿越、Windows 名称冲突及输出覆盖。文件变化时拒绝快照，不宣称运行中数据库或跨文件事务的一致性。

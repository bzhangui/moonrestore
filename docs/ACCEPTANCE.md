# 验收进度（可复核证据，不是正式申报书）

GitHub main 当前为 0.3.1 中文提醒源码补丁；本机完整回归 64 项及四目标核心验证通过。按用户选择，Mooncakes 仍为已正式发布的 0.3.0，0.3.1 未发布。下表保留 0.3.0 的完整发布证据，补丁记录见 [PUBLICATION](PUBLICATION.md)，不能把二者版本混同。

## 0.3.0 当前核查

| 标准 | 当前结果 |
|---|---|
| 1. MoonBit 主要实现 / 编译器 | 核心分块、SHA、清单、属性校验、选择范围、保留/容量及备份恢复编排在 MoonBit；Node/系统负责加密、I/O、GUI 和调度；最低 moonc 0.10.15，不宣称纯 MoonBit 全运行时 |
| 2. 公开仓库 / 提交 | 功能提交 60d6055 已推送公开 main，匿名 HTTP 200、远端 SHA 一致；不伪造提交或修改历史 |
| 3. 源码与核心功能 | core/app/platform/ui 分层，补齐任务管理、检索、多选、密钥、取消、副本和桌面分发；受控端到端测试 |
| 4. README 可复现 | 根 README、DESKTOP、WORKBENCH、PRACTICAL_0_3、FORMAT、RECOVERY 覆盖安装/使用/升级回退及安全边界 |
| 5. CI | [三平台 CI 38887889049](https://github.com/bzhangui/moonrestore/actions/runs/38887889049) 检查/构建/四目标测试、覆盖率、隐私、运行包冒烟全部通过；Windows 原生启动器编译通过 |
| 6. 示例 | 可运行 demo、四目标核心样例、三种受控应用场景均保留 |
| 7. 测试 | 本轮 22 核心用例 × 四目标；Node 专项、重复恢复、实际 >2 GiB、旧版双向兼容、真实浏览器及桌面非交互验证；不替代真实生产证据 |
| 8. Mooncakes | 0.3.0 已正式发布，200 OK、未撤回、包哈希一致，独立消费四目标各 2 测试通过，见 PUBLICATION |
| 9. OSI / 来源 | Apache-2.0、NOTICE 保留；可选内置 Node 必须附完整上游 LICENSE 与精确来源/哈希；系统 .NET 不随包分发 |

验收材料工程补强不等于赛事最终通过。尚缺人工原生窗口检查、真正独立设备/NAS/跨主机/断电和长期外部用户证据；VSS 仅准备检查，压缩仅原型。详见 [QUALITY_REPORT](QUALITY_REPORT.md)。以下保留 0.2 历史证据。

## 0.2.0 历史核查

0.2.0 本轮增加报告、演练、本机工作台、自动任务、加密/副本、安全保留和显式大文件 profile。下表已更新为本轮实际证据；细节与边界见 [QUALITY_REPORT](QUALITY_REPORT.md)、[PUBLICATION](PUBLICATION.md)。

发布过程中的状态可能更新；以 GitHub 仓库最新版本的本文件为准。

| 项目 | 当前证据与缺口 |
|---|---|
| 1. MoonBit 主要实现、moonc ≥ 0.10.14 | MoonBit 负责分块、清单、完整性、备份/校验/恢复编排、保留算法及容量/源变化决策；Node/C 提供系统、认证加密、自动任务及本机 HTTP/UI 编排，不宣称全应用纯 MoonBit。本机及三平台 CI 实测 moonc 0.10.15，源码最低要求 0.10.15。 |
| 2. 公开仓库和清晰提交 | [bzhangui/moonrestore](https://github.com/bzhangui/moonrestore) 已公开，main 与本地推送一致，匿名访问已验证；提交按实际功能组织。 |
| 3. 清晰源码结构和核心功能 | core/app/platform/cmd/ui 分层；历史恢复、诊断、演练、加密、副本和安全回收均有实际断言。 |
| 4. README 可复现 | 安装、构建、CLI/工作台使用、三场景、维护、密钥/中断恢复与限制齐全；源目录与临时测试隔离。 |
| 5. CI 检查/构建/测试 | [本轮三平台 CI](https://github.com/bzhangui/moonrestore/actions/runs/38866239121) 已通过：检查、构建、四目标核心测试、文件系统测试、覆盖率、隐私门禁与运行包真实功能冒烟。 |
| 6. 可运行示例 | 核心库例子、历史恢复 demo、三个受控应用场景。 |
| 7. 完整核心路径测试 | 18 个不同核心测试各跑四目标；Windows 50 项 Node 回归、Linux/macOS 各 47 项（3 项 Windows 专项跳过）；实际 >2 GiB 恢复回读、真实浏览器、DPAPI 与临时计划任务单轮验证通过。不是所有设备/文件系统或长期生产都已验证。 |
| 8. Mooncakes 发布 | [bzhangui/moonrestore@0.2.0](https://mooncakes.io/docs/bzhangui/moonrestore) 已正式发布，查询成功且未撤回，SHA-256 与本地发布包一致；独立消费者四目标检查/构建/运行/测试通过，见 [记录](PUBLICATION.md)。 |
| 9. OSI 开源许可与来源 | Apache-2.0 全文、NOTICE、第三方归属与来源边界齐全。 |

上述九项工程要求已有可复核证据，但不等于最终赛事评审已经通过；提交记录与 MoonBit 相关性、功能完成度仍由评审判断。私人申报书不随本轮发布，不为数量伪造空提交或拆分无意义提交。

后续生产验证包括独立介质/真实 NAS、断电持久性、外部用户、长期恢复演练。模拟测试不能替代这些证据。

# 验收进度（可复核证据，不是正式申报书）

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

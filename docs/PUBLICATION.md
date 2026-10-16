# 发布核验记录

## 0.3.0 正式发布（2026-10-16）

本轮已获用户明确授权，完成测试和隐私门禁后执行。

- 公开仓库 main 的功能/测试提交：`60d60558601279de6e7c56c3dc4e022f1f0a22c1`，推送后远端 SHA 一致，匿名页面 HTTP 200。
- 对应 [CI 38887889049](https://github.com/bzhangui/moonrestore/actions/runs/38887889049) 三平台全部成功。Windows 63 项 Node 回归通过；Linux/macOS 各 60 项通过，3 项 Windows 专项明确跳过。核心 22 个不同用例各跑四目标，三平台覆盖率均 384/416。普通包 Windows 34 文件、Unix 35 文件的校验/真实功能冒烟通过；Windows 原生启动器编译通过。
- 本机实际 Edge 新旧操作流程通过，包括加密创建/密钥导出/密码重包装/重新解锁/独立密钥演练；修复初始化成功被界面误报失败的问题。最终内置运行时包 40 文件，屏蔽全局 Node 后原生宿主授权访问和停止通过。非交互检查不冒充人工托盘/安装窗口测试。
- 真正的 0.2.0 运行包与新版本双向内容恢复、引用一致性通过；三轮 122 文件/三版本重复恢复及实际 2,147,483,649 字节恢复回读通过。完整限制见 QUALITY_REPORT。
- Mooncakes `bzhangui/moonrestore@0.3.0` 正式发布返回 `200 OK`，随后查询成功、未撤回，latest_version 为 0.3.0。发布时间 2026-10-16 18:35:04（UTC+8）；Apache-2.0，固定依赖 moonbitlang/x 0.5.5。
- 注册表 metadata.checksum 与本地正式发布 ZIP 的 SHA-256 一致：

```text
aaa8e22192967b225d5761b4db7a11d079bac7a283cd48eda8853d52e8ea055f
```

- 独立项目实际从注册表下载 `moon add bzhangui/moonrestore@0.3.0`，无本地 path/workspace 替换，四目标检查/构建/运行及各 2 个消费测试通过。公开消费覆盖新增元数据编解码和多选规则，以及原 SHA、分块、清单、保留/容量等接口。复现：`node scripts/verify-registry.mjs 0.3.0`。
- 临时发布凭据副本已在 finally 中删除，原登录文件未修改、内容未输出。正式发布后不覆盖已发布源码；本节后续证据提交不改变注册表 0.3.0 内容。

私人申报书、源资料/备份/恢复数据、密钥、私有报告、SDK/运行时缓存和本机安装状态均不公开。不改动 HookLab、MoonAPI、MoonJet 等其他仓库；本地桌面运行包不等于已公开 GitHub Release 附件。

## 0.2.0 正式发布（2026-10-16）

已获用户明确授权后执行。本轮没有推送私人申报书、个人资料、备份、恢复密钥、SDK、浏览器会话链接和运行报告，也没有改动 HookLab 等其他项目。

- GitHub：[bzhangui/moonrestore](https://github.com/bzhangui/moonrestore)，Public、main。
- 功能与测试源码提交：`a4b60a9345bc75f3b1d19ef955b91e831d620e0d`，提交后已核对远端 SHA 一致。
- 对应 [CI 38866239121](https://github.com/bzhangui/moonrestore/actions/runs/38866239121) 的 Windows、Ubuntu、macOS 全部成功。三平台实际使用 moonc 0.10.15+943464bfa、Node 22，执行四目标检查/构建/核心测试/示例、Node 回归、覆盖率和便携包功能冒烟。
- Windows：50 个 Node 测试通过、无跳过；Linux/macOS：各 47 个通过，仅 3 项 Windows 启动器/DPAPI 测试明确跳过。三平台核心覆盖率 319/345；运行包 Windows 27 文件、Unix 28 文件（含 C 排他提交辅助程序）校验通过，包内加密备份/报告/恢复回读通过。
- Mooncakes：`bzhangui/moonrestore@0.2.0` 正式发布返回 `200 OK`；随后 `moon view` 查询成功、未撤回、latest_version 为 0.2.0。发布时间为 2026-10-16 15:19:09（UTC+8）。许可证 Apache-2.0，依赖 moonbitlang/x 0.5.5。
- 注册表与本地发布 ZIP 的 SHA-256 一致：

```text
e823960c8069950c703c6b26188ae1136de89ed6562fef98238f3b6f36ee0c64
```

- 独立项目实际运行 `moon add bzhangui/moonrestore@0.2.0`，无本地 path/workspace 替换；四目标均通过检查、构建、可执行断言及 2 个公开 API 消费测试（共 8 次测试执行）。覆盖 SHA-256 标准向量、分块验证、清单往返、保留策略、容量与源变化门禁、大文件 profile 的公开接口。复现入口：`node scripts/verify-registry.mjs 0.2.0`。
- 发布临时使用已有登录文件的私有副本，完成后已删除；原登录文件未修改、内容未输出。后续文档证据提交不覆盖注册表已发布版本。

复核命令：

```sh
moon view bzhangui/moonrestore@0.2.0 --json
node scripts/verify-registry.mjs 0.2.0
```

此次 SDK 的 `publish --frozen` 会使新解包目录无法安装依赖；采用常规 `moon publish`，重新下载 moon.mod 中固定的依赖并通过解包检查。dry-run 的服务端 `202 Accepted` 曾被 CLI 显示为非零退出，因此未把 dry-run 当成正式发布；以上以正式 `200 OK`、注册表元数据、校验和和独立消费结果为准。

## 0.1.0 历史发布核验记录

2026-10-09，用户明确授权创建公开 GitHub 仓库并推送源码、发布 Mooncakes。仅操作本次新建的 MoonRestore；没有推送 HookLab、私人申报书、个人备份数据或 `.local` 运行包/消费测试目录。

## GitHub

- 仓库：[bzhangui/moonrestore](https://github.com/bzhangui/moonrestore)，Public，默认分支 main。
- 已验证匿名访问，远端 main 提交与推送源一致；功能和修复按实际工作记录，未创建空提交或修改历史时间。
- 发布源码对应提交：`6604064bc4c4388769c8bdead1c33532d28f2a5b`。
- 该提交的 [CI 37943163446](https://github.com/bzhangui/moonrestore/actions/runs/37943163446) 已完成且 Windows、Ubuntu、macOS 全部成功；包含检查、构建、测试、示例、核心覆盖率和运行包验证。
- 后续发布记录/使用说明的提交不改变 0.1.0 已发布的模块内容。最新 CI 状态可在 Actions 核实。

## Mooncakes

- 模块：`bzhangui/moonrestore@0.1.0`；[模块页面](https://mooncakes.io/docs/bzhangui/moonrestore)。
- 正式发布返回 `200 OK`，注册表查询成功、版本未撤回；注册表构建状态为 `success`。
- 注册表与本地发布 ZIP 的 SHA-256 均为：

```text
34f8a02659fa84de038a0bb919ff57a062ddefbec20428099b028fea0ea75b1e
```

- 发布时间：2026-10-09 22:18:17（UTC+8）。许可 Apache-2.0，依赖 moonbitlang/x 0.5.5，repository 指向上面的公开源码。
- 在独立项目执行 `moon add bzhangui/moonrestore@0.1.0`，实际从注册表下载；通过 JS、Wasm、Wasm-GC、Native 的检查、可执行示例和单元测试。
- 消费用例调用公开的内容分块、SHA-256、块验证和清单编码/校验 API，断言清单往返相等及 SHA-256 标准向量正确。四目标各一个消费测试通过。

可自行复核：

```sh
moon view bzhangui/moonrestore@0.1.0 --json
```

注册表发布的是源码模块和核心库 API；它不是包含 Node 运行时的桌面安装器。完整文件备份工具使用 GitHub 源码构建，或本地生成的对应平台运行包。

## 未验证的范围

公开发布和三平台 CI 不等于真实 NAS、断电可靠性、长期生产负载、外部合作方试点已经完成；这些缺口与产品限制仍按 README、SECURITY 和维护测试报告保留。

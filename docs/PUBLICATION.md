# 发布核验记录

## 0.5.0 正式发布（2026-10-17）

用户在 82d7223 源码四项 CI 全部成功后，另行明确授权“推送至 mooncakes”。现已发布 [bzhangui/moonrestore@0.5.0](https://mooncakes.io/docs/bzhangui/moonrestore)，不覆盖或撤回旧版。申报书、密钥、备份、私有报告、SDK 和运行时缓存不公开，桌面运行包不随注册表发布。

- 发布准备提交为 `adb24e4`，沿用已通过 [四项 CI 39014789498](https://github.com/bzhangui/moonrestore/actions/runs/39014789498) 的 82d7223 功能源码，只更新发布说明与独立消费脚本。本轮再次执行 fmt、四目标 check/test（各 27 核心用例）与实际 ZIP 隐私检查；147 个包条目未发现私有路径，LICENSE/NOTICE 保留。
- 正式 `moon publish` 本地及解包检查均通过，服务端返回 **200 OK**。随后精确版本与无版本 `moon view --json` 查询均成功，版本及 latest_version 为 **0.5.0**，未撤回。注册表发布时间为 **2026-10-17 15:56:18（UTC+8）**；许可证 Apache-2.0，固定依赖 moonbitlang/x 0.5.5。
- 注册表 metadata.checksum 与实际上传 ZIP 的 SHA-256 一致：

```text
383cdb04294ff1fbc5e6fbfb8ff4cd51931a8a955dd3c15ecaa9120c513664f1
```

- 独立临时消费项目实际从注册表安装 0.5.0，无 path/workspace 替换；JS/Wasm/Wasm-GC/Native 各自 check、release build、运行断言及 **3 个消费测试全部通过**，共 12 次测试执行。包含公开恢复选择/巡检批次、检查点验证、操作状态转换、时钟门禁及既有完整性/维护 API。复现：`node scripts/verify-registry.mjs 0.5.0`。
- 首次 `publish --frozen` 在上传前因新解包目录不能安装依赖失败，查询确认当时注册表仍为 0.3.0；改用正常 `moon publish`，固定依赖未改变，未跳过源代码或解包验证。临时发布凭据仅当前用户可读，两个尝试均在 finally 清除；原登录文件未修改，内容未输出。
- Mooncakes 安装提供 MoonBit 核心库，不等于发布 Windows EXE 或完整桌面运行包。原生 VSS 请求器、live 分段清单、真实云商及长期生产证据等缺口仍按 QUALITY_REPORT 保留。下面历史记录不代表当前注册表仍停留在旧版；本次证据补录不覆盖已发布的 0.5.0 包。

```sh
moon add bzhangui/moonrestore@0.5.0
moon view bzhangui/moonrestore@0.5.0 --json
node scripts/verify-registry.mjs 0.5.0
```

以下为获得本次新增发布授权之前的源码开发历史记录。

## 0.5.0 源码升级（不发布 Mooncakes）

用户授权测试及隐私检查后推送 bzhangui/moonrestore main，明确“暂不发布 Mooncakes”。本轮不执行 moon publish、不上传本地运行包或私人申报书/原始报告。新功能及未完成边界见 RELIABILITY_0_5、THREE_STAGE_PLAN；精确提交与 CI 状态在核验后补录，不沿用旧提交成功结果。

- 功能提交 `3f6c7f0aabea83fd1aa041ca4a65b5b389d9df32`、原生 PostgreSQL 修补 `6e8117e5c09f8dafc7d467bd3e5516cd45c39981` 已推送 main，使用 GitHub noreply 提交邮箱。修补后本机完整 114 项中 113 通过/1 原生 PostgreSQL 专项跳过；27 核心用例 × 四目标、425/458 core 覆盖率、包隐私全部通过。
- 首次 [CI 39014311481](https://github.com/bzhangui/moonrestore/actions/runs/39014311481) 暴露真实 libpq 空服务环境变量错误；修补后新运行替代并取消剩余旧作业，不能将首次失败描述为通过。
- 修补后 [CI 39014458667](https://github.com/bzhangui/moonrestore/actions/runs/39014458667) 对精确提交 6e8117e 的 Windows/Ubuntu/macOS 检查、构建、四目标测试/示例、覆盖率、包隐私与便携包功能冒烟 **全部成功**，Windows 原生启动器编译通过。原生 PostgreSQL 专项也成功：一次性真实 PostgreSQL 16、实际 pg_dump/pg_restore、新库 SQL 恢复、行数和长字段断言；与本机替身测试分开记录。后续纯文档补录不改变该功能提交的代码证据，后续提交自身结果仍以对应 Actions 为准。
- 最终本机 Windows 内置运行时包 60 文件，官方 Node v24.15.0；加密/SQLite/救援/巡检/索引及新增可靠备份恢复、计划、分段归档、新密钥迁移真实冒烟通过，屏蔽全局 Node 后宿主检查通过。包只在本机，原有包保留回退，不公开私人状态。
- 实际 2,147,483,649 字节新恢复 writer 与独立 SHA-256 读回、旧 0.2 包双向恢复、三轮重复恢复、实际 Edge 桌面/窄屏新旧界面流程通过；范围见 QUALITY_REPORT。原生 VSS 请求器/live 分段清单未实现，真实外部生产证据缺口不因此消失。
- 本轮只读查询 Mooncakes latest_version 为 **0.3.0**，未执行发布/撤回。0.5.0 的源码、本地包与注册表旧包明确区分。私人申报书、源数据/备份、密钥、SDK、原始运行报告无 Git 跟踪路径。

## 0.4.0 源码升级（本轮不发布 Mooncakes）

用户明确授权测试和隐私检查后推送 GitHub main，明确选择真实 S3/VSS/跨主机先做受控适配。正式注册表仍为 0.3.0，本轮未执行 moon publish，也不发布运行包附件。新 API 只能使用对应源码/本地构建，不能将注册表旧包混同为最新版。

本轮最终本机完整回归 94 项 Node/HTTP、24 核心用例 × 四目标、411/444 core 覆盖率；真实浏览器、规模/大文件/重复恢复、真实旧版兼容及独立本地运行包通过，具体见 QUALITY_REPORT。远端本轮状态在推送后记录，不把旧版本 CI 当作新提交通过。私人申报书、备份、密钥、SDK、运行报告和本机安装状态排除。

- 功能提交 bc14c69、验证说明提交 f7453db 已推送公开 main；本地、ls-remote、GitHub API 的精确 SHA 一致，匿名仓库页面 HTTP 200，公开树无私人申报书/本地状态/密钥路径。
- [CI 38998994913](https://github.com/bzhangui/moonrestore/actions/runs/38998994913) 对 f7453dbaacdaa40d0dc74c08ae12a5636eeb9adf 的 Windows/Ubuntu/macOS 全部成功，包含最终源码及新包内 SQLite 冒烟。
- 注册表只读核对 latest_version 仍为 0.3.0，未撤回、原哈希不变；0.4.0 未发布。新源码不冒充正式注册表包。
- 本地最终桌面包 52 文件，官方 Node v24.15.0；最终包 SQLite 在线导出/读回与无全局 Node 的原生宿主检查通过。不上传包、运行状态或原始报告。
- CI 发现旧 action 的 Node 20 弃用提示，后续维护将 checkout 固定至官方 v7.0.1 SHA、setup-node 固定至 v7.1.0 SHA（两者 action 运行时 Node 24），关闭检出凭据持久化与自动 npm 缓存；项目本身仍以 Node 22 测试。此 CI 维护不改变仓库数据格式；对应新运行以 Actions 为准。
- 末次边界复核修复大索引 Base64 正则栈溢出，补丁后全量 94 项本机回归通过，并重新打包/验证；下方 f7453db 的 93 项远端记录不能冒充该补丁的 CI。最新提交的检查/构建/测试/包结果在 [Actions](https://github.com/bzhangui/moonrestore/actions/workflows/ci.yml) 按精确 SHA 核对，本轮仍不发布注册表版本。

## 0.3.1 GitHub 补丁，未发布 Mooncakes

0.3.0 发布后的补查复现 Windows PowerShell 用默认 OEM 编码读取 JSON 标准输入会损坏中文，影响桌面提醒显示，不影响已验证的备份内容。主分支修复为显式 UTF-8 输入/输出，并新增包含中文/引号/表达式样式文本的真实进程回归。用户明确选择“先只修复和推送 GitHub”，因此未执行 Mooncakes 0.3.1 发布，注册表 0.3.0 不覆盖。0.3.1 源码/本地包与正式注册表版本需区别。

本机完整验证 64 项 Node 测试全部通过，22 个核心用例 × 四目标通过，core 覆盖率保持 384/416，三个受控场景及隐私门禁通过。本地 0.3.1 内置运行时包 40 文件，校验/加密备份/报告/恢复读回及无全局 Node 的原生宿主检查通过；没有实际安装或点击托盘窗口。远端运行记录见 [对应 main 提交的 CI](https://github.com/bzhangui/moonrestore/actions/workflows/ci.yml)，不把 0.3.0 的大文件/浏览器结果冒充重新执行的 0.3.1 规模测试。

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

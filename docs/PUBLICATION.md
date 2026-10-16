# 发布核验记录

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

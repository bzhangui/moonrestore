# 0.1.0 发布核验记录

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

# 持续运行、保护策略与独立救援

0.6 开发版，暂不发布 Mooncakes；正式注册表仍为 0.5.0。以下入口需从当前源码构建，不能把旧包称为已包含新增 API。

## 显式计划调度

先按 RELIABILITY_0_5 保存并手动验证计划。私有调度 JSON 示例：

```json
{"enabled":true,"intervalMinutes":1440,"retryMinutes":15,"attemptLimit":3,"maxRuntimeMinutes":30}
```

```sh
node bin/moonrestore.mjs plan-schedule PLAN_UUID PRIVATE_JSON --confirm PLAN_UUID
node bin/moonrestore.mjs plan-schedules
node bin/moonrestore.mjs plan-run-due
# 仅运行指定计划的到期项
node bin/moonrestore.mjs plan-run-due --plan PLAN_UUID
```

默认不启用。只有显式调用 runner 或开启工作台自动任务时运行；以上命令不注册服务/系统计划。每次 runner 最多运行一个到期计划，补跑只执行一次，不重放全部错过时段。运行/更新使用同一私有排他租约，同仓库继续受原仓库锁保护，不自动处理源异常、不强制接管锁。短暂失败有次数/间隔上限，达到上限停止，重新确认配置才能启用。密码/令牌不写入调度文件；会话解锁失效时失败关闭，不能为自动备份保存明文密码。

Windows 可先 `plan-schedule-preview PLAN_UUID` 查看当前用户任务 XML、精确 task 名和程序路径，再自行决定是否执行 `plan-schedule-install PLAN_UUID --confirm EXACT_TASK_NAME`。只有此独立确认命令才注册，已有同名任务绝不覆盖，不请求管理员或密码；任务以交互令牌运行，关闭工作台后仍可在用户保持登录时执行，注销后不保证运行。它周期性调用指定计划 runner，由计划到期/重试状态再次门控；禁用计划不删除 OS 任务，但后续唤醒不会备份。卸载前可在系统任务计划程序核对并删除该精确任务。包/程序路径变动需重新预览，不自动改写旧任务；不能依赖浏览器会话解锁，须另行明确配置已支持的安全解锁方式。**本轮不实际注册系统任务**，XML/确认门禁测试不冒充系统执行已验证。Linux/macOS 可由用户现有调度器显式调用 runner，本项目不自动写 cron/systemd。

异常退出保留租约与运行标记，先检查所有相关进程已停止，再执行 `plan-scheduler-recover --confirm recover-stopped-plan-scheduler`。这只恢复调度器租约，不恢复计划/子操作的锁；计划续作仍按旧指南显式核验。时间回退或超过 31 天的大跳变停止自动执行，调查后重配。停用已有调度不要求连接源盘或解锁仓库。间隔按 UTC 毫秒计算，不承诺本地墙钟时刻。

## 分项健康

`plan-status` 的 stages 分别报告 backup/verified/drill/replica/remote 的 unknown/current/stale/future/different_snapshot/invalid。必需步骤必须绑定当前备份快照且各自在窗口内，活跃/中断/失败计划不能报整体通过。副本设备独立性与真实供应商验证不因时间戳存在而变为通过。

## 固定恢复点和保护窗口

私有策略 JSON：`{"minimumDays":30,"pins":["完整快照ID"]}`。先预览，再将返回摘要用于应用；应用核验所有固定快照内容。业务正确性需用户自行确认，校验通过不能证明资料未被源应用错误修改。

```sh
node bin/moonrestore.mjs protection-preview REPO PRIVATE_JSON
node bin/moonrestore.mjs protection-apply REPO PRIVATE_JSON --confirm PREVIEW_HASH
node bin/moonrestore.mjs protection-status REPO
```

启用后，prune 自动保留固定快照和保护窗口内的快照；策略变化使旧清理确认失效。永久清理还受策略的隔离等待期与旧七天最短期保护。旧隔离批次缺少快照清单时拒绝按新策略永久删除，应先回滚再预览。策略不是不可变存储，不能防御同账户恶意删除策略文件，不替代异地账户/离线副本/Object Lock。

## 标准签名与本地防回滚

仅签名最多 64 MiB 的快照清单、归档根或包 manifest，不读取整个大归档。私有环境变量 `MOONRESTORE_SIGNING_PASSWORD` 为 12..4096 UTF-8 字节，不通过命令行传密码。私钥使用密码加密 PKCS8；公钥与可信首条摘要应通过独立渠道保存。

```sh
node bin/moonrestore.mjs signing-key-create NEW_PRIVATE_KEY_DIR
node bin/moonrestore.mjs artifact-sign FILE PRIVATE_PEM NEW_SIGNATURE --subject package
node bin/moonrestore.mjs artifact-verify FILE SIGNATURE TRUSTED_PUBLIC_PEM
# 初始化可信锚点：摘要必须独立核对，不可直接信任攻击者自带的值
node bin/moonrestore.mjs artifact-verify FILE SIGNATURE TRUSTED_PUBLIC_PEM --anchor PRIVATE_ANCHOR --trust TRUSTED_SIGNATURE_HASH
```

后续签名使用 `--sequence N --previous PREVIOUS_SIGNATURE_HASH`，同一条链使用同一 anchor。后续核验拒绝倒退、跳号、相同序号不同内容和错误链；无 anchor 的签名核验明确不提供防回滚。不要把不同仓库/产品混在同一链。攻击者若控制本机状态或签名私钥，仍可绕过保护；签名不证明业务内容健康，不是 Authenticode 证书，也不会自动签名所有快照或发行包。

可选运行包核验：在可信源码环境执行 `node scripts/verify-package.mjs BUNDLE --signature DETACHED_SIGNATURE --public-key TRUSTED_PUBLIC_PEM`，先核对整包清单再核验 manifest 签名。该入口不自动建立回滚锚点；需要时先使用 artifact-verify 的 anchor 流程。包内 components.json 为版本化组件清单，记录自身、固定 MoonBit 依赖与可选 Node，不声称覆盖外部系统所有依赖或符合完整第三方 SBOM 认证。

## 独立救援包

先 `node scripts/package.mjs` 或 `npm run package:desktop` 构建同平台运行包，独立核对其 manifest.json 的 SHA-256，再执行：

```sh
node bin/moonrestore.mjs rescue-kit REPO SNAPSHOT_ID NEW_KIT --bundle VERIFIED_BUNDLE --bundle-sha256 TRUSTED_MANIFEST_HASH
node bin/moonrestore.mjs rescue-check KIT TRUSTED_RECIPE_HASH REPO
node bin/moonrestore.mjs rescue-restore KIT TRUSTED_RECIPE_HASH REPO NEW_TARGET
```

救援包包含固定快照 ID、仓库格式/加密配置摘要、核验后的程序和许可证；不包含仓库、原始源路径、旧索引/任务/操作日志、密码或恢复密钥。将返回的 recipe_sha256 独立保管。使用相同平台/架构；普通包仍需兼容 Node，Windows 内置运行时包无需全局 Node/MoonBit。加密仓库需单独设置密码或 `MOONRESTORE_KEY_FILE`。加密配置重包装后摘要变化，需要重新生成救援配方。

恢复前验证配方、运行包全清单和仓库配置，使用全新私有状态运行完整可续作恢复并独立读回，不覆盖目标。失败会保留私有会话供诊断，不能自动删掉。`rescue-check` 只核验准备条件，content_verified=false，不等于已恢复。实际跨主机/介质仍需验证；不是系统镜像、启动 U 盘或裸机操作系统恢复工具。

救援取消通过私有父控制文件转发至内层恢复 worker；控制文件丢失/无效或协调器不再存在时拒绝继续。只结束外层进程不被当作“内层已经完成”。取消不是撤销已发布的完整恢复；强制结束与不可中断系统 I/O 仍有平台边界，失败后保留状态并检查实际目标，不盲目重复或删除。

## 尚未交付的远期范围

默认完整维护：`npm run validate`。可选真实 Windows 任务演练：仅本人授权临时系统任务后执行 `node scripts/plan-scheduler-qa.mjs --allow-os-task`，仅操作随机私有夹具和精确归属任务，结束清理；默认维护不调用此脚本。未执行或权限拒绝时必须保留验证缺口，不可把 XML 预览说成真实运行成功。

本轮不改 live 仓库格式。分段 live manifest、对象 pack、通用备份文件内部续传、原生管理员 VSS、WAL/PITR、真实不可变云存储和发布者代码签名未实现。人工安装/托盘、真实云权限、跨设备/物理断电、长期生产未验证。不要将有用的受控适配与测试描述为上述能力全部完成。

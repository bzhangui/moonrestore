# 本机工作台与自动任务

需要 Node ≥22，源码先 `npm run build`，再 `npm run workbench`。默认只监听 `http://127.0.0.1:8790/`；端口占用可执行 `node bin/moonrestore.mjs workbench --port 8791`。

启动输出的链接含临时会话令牌，使用完整链接进入。令牌只放在当前页面内存，页面会移除地址栏片段；刷新或关闭后重新使用原启动链接。服务重启会生成新令牌。不要把完整链接截图、放进公开工单或代理到公网。

## 首次使用

1. 为重要资料准备独立磁盘；页面创建的是普通明文仓库。需加密时先用 CLI 初始化，再授权解锁。
2. 填写任务 ID、源目录和仓库完整路径。新仓库路径必须不存在，源目录和仓库不能重叠。
3. 预检查容量并保存任务。一个仓库只配置一个任务，避免保留策略混淆不同资料集。
4. 点击立即备份并确认。任务在备份后完整校验，首次成功及之后指定轮次进行恢复演练。
5. 打开版本，选择快照，浏览每页 100 个条目；可选择一个相对路径或恢复整个快照。
6. 输入尚不存在的恢复目标，先预览，再确认写入。确认与仓库状态/快照/目标/选择绑定，变更后需重新预览。

工作台只列最近 100 个快照；完整历史可使用 CLI。操作中不显示虚假的百分比，关闭页面不意味着已经取消后台文件操作。不同仓库的长期任务也由当前工作台串行执行；这是本机产品，不是多用户服务。

工作台、自动任务、报告/演练/复制等 Node 编排对每个底层核心子进程设置 10 分钟超时。超时是失败而不是成功，可能留下待恢复的锁或暂存文件，应先确认进程已退出，再按恢复说明处理。大规模资料应先测量单步耗时；直接 `backup`、`verify`、`restore` CLI 不受这个编排时限约束。大文件 profile 的容量阈值不意味着工作台能在 10 分钟内处理上限规模。

## CLI 任务

```sh
node bin/moonrestore.mjs job-add papers --repo E:/paper-vault --source D:/papers --every-minutes 1440 --drill-every 7 --exclude cache
node bin/moonrestore.mjs jobs
node bin/moonrestore.mjs job-run papers
node bin/moonrestore.mjs run-due
```

默认空源目录拒绝；明确需要备份空目录时配置 `--allow-empty`。与上次成功运行相比，条目数下降超过默认 30% 时拒绝，阈值可用 `--max-drop-percent` 调整。这个检查不是勒索软件检测，无法发现所有误删、内容变化或业务异常。源目录尚未存在时不会自动创建它。

容量预检查考虑当前 profile 的默认分块、逻辑大小与估算块开销，不依赖预计去重收益，不预留实际磁盘空间；并发占用、配额、文件系统元数据等仍可能使运行失败。失败保留上次成功时间，不伪造健康记录。任务绑定仓库随机标识，离线磁盘或盘符被其他仓库占用时拒绝执行。

保存任务**不自动注册系统调度**。Windows 可以预览并明确安装：

```sh
node bin/moonrestore.mjs schedule-preview papers
node bin/moonrestore.mjs schedule-install papers --confirm EXACT_TASK_NAME_FROM_PREVIEW
```

注册使用固定脚本和 XML 数据，不将路径拼成 PowerShell 代码，不覆盖同名已有任务。运行级别为当前用户、非管理员、需要用户登录会话；不是无人登录的 Windows 服务。设置了 StartWhenAvailable，但不能承诺电脑关机期间执行，也未完成实际日历时刻的长周期验证。可在任务计划程序中查看、停用本项目创建的精确任务名。

macOS/Linux 暂不自动注册系统服务，可由操作者按自身调度系统调用 `run-due`。不要把“有 CLI 任务”说成“三平台均已验证自动计划服务”。

## 私有状态与解锁

默认状态目录 `.local/state/`，包含 jobs.json、报告和 DPAPI 密钥封装。可用环境变量 `MOONRESTORE_HOME` 或前置参数 `--home PRIVATE-DIRECTORY` 指定。调度预览绑定同一私有目录；移机时路径和运行账号变化需要重新配置，不能把开发机绝对路径当成可移植配置。

加密任务不会在 jobs.json 保存密码。Windows 可在正确密码解锁后显式执行 `key-store REPOSITORY`，使当前用户使用 DPAPI 封装密钥；换用户、换机或丢失 Windows 用户密钥时，仍需独立恢复密钥/密码。其他平台应由受控环境注入解锁方式，当前没有通用凭据管理器集成。

任务进程意外终止可能留下私有状态锁。确认原进程已停止后执行 `jobs-recover recover-stopped-local-job`；存活进程的锁不能强行打破。仓库自己的锁/中断维护要按另一份恢复说明处理。

## 页面安全边界

仅回环监听；API 需要临时 Bearer、精确 Host/Origin，拒绝跨站来源；写请求限定 JSON 和 64 KiB，单个工作台只执行一个操作。使用 CSP、禁止嵌入、无第三方 CDN/遥测，界面数据通过 textContent 呈现。可信本机用户仍能通过其账号权限访问文件；这不是用于对抗已控制本机的恶意软件或多租户隔离。

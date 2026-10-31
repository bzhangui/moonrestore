# 0.12 使用与边界

源码0.12.0，Mooncakes正式版仍为0.11.0。需要moonc≥0.10.16、Node≥22.16；本轮不发布注册表或运行包，不自动更改已安装程序、资料仓库或用户任务。Apache-2.0及NOTICE、上游许可不变，无新增npm运行依赖。

## 格式4/5生命周期

以下REPO、DONOR、SNAPSHOT均须替换为自己控制的仓库/完整ID；目标父目录存在且目标不存在。

```sh
node bin/moonrestore.mjs repository-capabilities REPO
node bin/moonrestore.mjs paged-rebuild REPO NEW_REPO
node bin/moonrestore.mjs archive-export REPO NEW_ARCHIVE
node bin/moonrestore.mjs archive-import NEW_ARCHIVE EXTERNAL_ROOT_SHA NEW_REPO
node bin/moonrestore.mjs paged-repair PRIMARY DONOR SNAPSHOT NEW_REPO
```

`paged-rebuild`的新密码由私有环境`MOONRESTORE_DEST_PASSWORD`提供（原密码/独立密钥解锁来源）；默认加密，`--plaintext`是显式降密。逻辑页、打包编码和format5元数据页不经文件系统往返，保留创建时间和旧→新根映射；新仓库使用新主密钥，不撤销旧副本或旧密钥权限。原库保留。

双供体须同仓库身份、格式和主密钥，供体只读；用另一份健康认证成员补缺，不修补原库、不合成丢失内容。两份同一成员均坏、头部/密钥不可用或完整审计失败，则不发布目标。若两个目录位于同一设备，本地测试不证明物理独立。

分页运输根format2保留旧format1读取，固定外部根摘要后按有界段导入，再完整校验所有选定快照、原生元数据及库存后发布。加密库运输密文；未加密库运输明文。失败仅保留自有临时目录供诊断，不能作为完整备份。

MoonBit `PagedWriter`负责128记录/250000编码字节的分页边界、落盘页摘要确认、根汇总；`GCPlanner`负责完整候选计数和最多1000成员批次。宿主仍须证明实际页读回、不可达对象、身份/锁、宽限期和真实I/O。新增公共核心样例见[examples/core](../examples/core/main.mbt)。语言占比风险没有因为新API自动消除。

## 恢复与应用契约

工作台新增“恢复向导”：仓库能力→完整预览→全新目录与明确元数据策略→认证续作→独立读回→可选应用检查。格式5原生模式须同平台且明确允许权限；portable明确有损，不提权。恢复操作ID与备份操作ID分入口，关闭页面不会自动取消已开始的任务；状态不明先查询，不删除暂存、不接管陌生目标。

```sh
node bin/moonrestore.mjs application-validate RESTORED_ROOT PRIVATE_CONTRACT_JSON
```

私有JSON示例（仅合成说明，无个人资料）：

```json
{
  "format": 1,
  "json": [{ "path": "config.json", "equals": { "schemaVersion": 1 } }],
  "sqlite": [
    {
      "path": "app.sqlite",
      "checks": {
        "format": 1,
        "tables": [
          {
            "name": "documents",
            "columns": ["asset", "digest"],
            "minimumRows": 1
          }
        ],
        "references": [
          {
            "table": "documents",
            "column": "asset",
            "sha256Column": "digest",
            "maximumRows": 1000
          }
        ]
      }
    }
  ]
}
```

`files`可声明`path/sha256/bytes`；JSON为顶层标量精确比较；SQLite完整性、外键、表列/行数和数据库引用的相对路径附件在只读事务检查。不允许脚本、任意SQL或启动业务应用。仅验证声明的业务约束，不能证明跨文件原子采集、多库事务或完整业务语义。路径逃逸、链接、非规则文件、缺失/篡改附件、超预算及主库变化均拒绝。

契约≤64KiB；files/json各≤128，SQLite≤8；单附件≤64MiB、文件组/引用组各≤128MiB；JSON文件≤1MiB；引用规则≤16、总引用≤10000。默认30秒，可编程接口最多30分钟，合作取消保留。报告不包含业务行、附件名或凭据。

## 独立追加接收协议

```sh
node bin/moonrestore.mjs receiver-init NEW_RECEIVER_DIRECTORY owned
node bin/moonrestore.mjs receiver-serve RECEIVER_DIRECTORY 8792
node bin/moonrestore.mjs receiver-push ENCRYPTED_PAGED_REPO SNAPSHOT http://127.0.0.1:8792 owned
node bin/moonrestore.mjs receiver-restore http://127.0.0.1:8792 owned RECEIPT_KEY RECEIPT_SHA NEW_REPO
```

writer/admin分别从私有环境`MOONRESTORE_RECEIVER_WRITER_TOKEN`和`MOONRESTORE_RECEIVER_ADMIN_TOKEN`读取不同的32—256字符令牌，不入URL、不存仓库/日志。初始化不创建凭据。CLI服务只监听回环；跨主机由管理员配置可信HTTPS反向代理，或以可编程`startObjectReceiver`的TLS选项启动；非回环无TLS拒绝，客户端不跳过证书验证/重定向。没有自动部署主机、开端口或修改防火墙。

writer只读/追加，admin只读状态/对象，协议没有覆盖、删除、配额更改或保留更改端点；只有加密分页仓库客户端可上传。单对象≤8388704字节、默认1GiB/100000对象、4个在途对象、最多16连接，有限请求/响应时间。单帧原子不可变发布、摘要读回和排他运行锁；丢失响应后同内容重试幂等，异内容冲突拒绝。遗留pending占配额，不自动删除；仅明确`--recover`可核对同主机已死进程锁。

这是协议层权限分离，不是硬件WORM、云Object Lock、抵御同OS账户入侵或物理独立证明。管理员文件系统权限仍可删除数据。接收端无法从不透明载荷证明其加密语义；客户端强制加密源。生产需独立账户/主机、TLS/令牌轮换、外部审计和实际恢复验证。

## 分页远端审计

原`remote-audit`/`remote-audit-cycle`增加format2分页回执；固定根和各页/成员versionId、SHA和长度，可检查COMPLIANCE保留头；只读取覆盖当前批次的元数据页（128成员/页）。每批1—1000成员、最多524288成员/4096页/2TiB。失败不前移认证游标，重试须明确，绑定、单调时间和1小时周期不放松。

累计周期完成只表示该周期观测过全部固定版本；明确`inventory_uniqueness_verified=false`和`cleanup_authorized=false`，不冒称跨批全局唯一、解密审计或明文恢复。单次全量批次可核对所见库存唯一/头部/字节总计。真正恢复仍下载到新库并做全局去重、解密/逻辑页/元数据/内容全审计。服务端保留头也不是实际云供应商或真实防删验收。

## 资源、调度、升级与回退

`npm run profile:recovery -- 8`只创建8MiB合成资料；附加参数`unique`/`compressible`可切换独特字节/可压缩资料，默认`repeated`观察跨文件复用。冷备份/未变备份/完整校验/恢复读回分别测量耗时、进程RSS/CPU、宿主read/write/fsync调用和自有目录占用，最后清理。允许1—64MiB且预检空间；不读个人目录，不禁用同步。调用计数不是物理I/O，未计原生子进程全部峰值，拒绝预算不是规模性能保证。原大文件压力测试仍需另外预留至少6GiB。

当前用户任务仍为InteractiveToken/LeastPrivilege；只在用户登录会话运行，不宣称注销/重启后服务常驻。Windows返回的等价ISO间隔按分钟比较，账户名解析为当前SID；实际启动/禁用/删除前再次绑定动作、工作目录、触发器和用户。查询不明则不写；执行请求回执不冒充任务完成。本轮受控任务证据见维护报告。历史未确认任务不随本轮自动清理。

```sh
node bin/moonrestore.mjs bundle-transition-preview OLD_BUNDLE NEXT_BUNDLE TRUSTED_OLD_SHA TRUSTED_NEXT_SHA
node bin/moonrestore.mjs bundle-copy-verified BUNDLE TRUSTED_MANIFEST_SHA NEW_VERSION_DIRECTORY
```

从带外可信摘要核对有限清单、文件/总字节预算，仅复制清单到独立新目录，逐文件同步和最终读回；不执行新代码、不改快捷方式/服务/旧版本，不复制私有状态/密钥/额外文件。预览报告格式交集；旧包缺能力声明则返回未知，不能推断兼容。回退必须保留旧包及兼容的私有状态，并先停止相关进程；没有自动状态降级或自动激活。SHA清单不是发布者签名，尚无可信Authenticode证书，本轮不公开包。

## 测试与未验证项

`npm run validate`含四目标核心、Node/HTTP/进程故障、合成场景和包/公开树门禁；新增固定种子组合故障重放及保持失败指纹的缩减器自测，不声称全局最小或穷尽所有故障。具体计数、性能观测、实际计划任务及精确CI见[维护报告](QUALITY_REPORT.md)和[发布记录](PUBLICATION.md)。真实云、独立主机/介质、管理员VSS、物理掉电、可信签名和外部用户效果仍待授权环境验证，模拟不能替代。

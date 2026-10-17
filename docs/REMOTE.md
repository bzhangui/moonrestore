# S3 兼容加密副本（0.4）

实现路径式 S3 SigV4，已用本机 HTTP 模拟服务验证；**真实云供应商、物理独立介质、IAM、跨主机及保留期仍未验证**。模拟不能证明生产不可变性。默认不联网，只有明确 S3 命令连接指定端点；不自动读取 AWS 默认账号/凭据链。

## 授权与使用

使用专用最小权限桶/前缀，先核对地域、费用和策略。仅支持加密源，明文上传拒绝；密码/独立密钥只在本机解锁，不上传。密钥须另存。

凭据环境变量：MOONRESTORE_S3_ACCESS_KEY_ID、MOONRESTORE_S3_SECRET_ACCESS_KEY，可选 MOONRESTORE_S3_SESSION_TOKEN。不放命令参数/回执/报告、不自动保存；环境变量不防本机管理员。

```sh
node bin/moonrestore.mjs s3-push REPO ID --endpoint https://REGIONAL_ENDPOINT --bucket YOUR_BUCKET --region YOUR_REGION --prefix moonrestore --allow-remote
# 私有保存返回的 receipt_key、receipt_checksum 及可用的 receipt_version
node bin/moonrestore.mjs s3-restore RECEIPT_KEY RECEIPT_CHECKSUM NEW_REPO --endpoint https://REGIONAL_ENDPOINT --bucket YOUR_BUCKET --region YOUR_REGION --allow-remote --version RECEIPT_VERSION
```

非回环必须 allow-remote + 已验证 HTTPS；拒绝 URL 内凭据、子路径、查询和 fragment，不跟重定向。用桶所在地域端点，回环 HTTP 仅受控测试。虚拟主机寻址、代理/自定义 CA 及所有兼容商未完整适配。

## 上传与恢复

先完整 audit 源，仅上传原认证密文对象/清单、加密配置和标识，无明文内容或文件名。回执含快照 ID/时间、密文映射、大小/摘要/版本，仍属私人元数据。

内容键用 If-None-Match:*；412 后仍须 GET 匹配 SHA-256，无无条件覆盖回退。全部读回后最后提交回执并读回。409/403/超时直接失败，不自动扩大权限。中断重跑复用一致对象，不覆盖坏对象；孤立对象不自动删除。适配器无 DELETE、不传播源删除；管理员、其他账号和生命周期规则仍可能删除内容。

恢复必须给出另存回执摘要，优先附 --version；逐项版本/摘要读取，写新仓库暂存，用户本机解锁并完整 audit 后排他发布。错误密钥、摘要、内容或已有目标拒绝；失败可能保留加密暂存，不覆盖旧资料。随后普通/应急入口恢复文件。

固定预算：单请求 10 秒、整个 backend 会话 30 分钟，响应至多 32 MiB+64 B；数据对象至多 1 MiB+64 B；100000 唯一对象、32 MiB 回执、1 TiB 下载总量。超限拒绝，不是无限规模或字节级续传。

## 可选保留的不可逆成本

仅理解并预配置 Versioning/Object Lock 后添加 --retention-days N --allow-retention（1..3650 天），请求 COMPLIANCE，可能造成期限内不能删除的费用，不应随意试用。

逐对象及回执 GET 均返回有效版本、COMPLIANCE、至少指定日期才记录 server_retention_reported:true。缺权限/信息失败，但已上传对象可能存在。已有对象保留不足不会自动改策略，需新前缀或管理员评估。字段只是服务端返回证据，不证明真实不可变；delete marker 与版本可见性仍须正确管理。

测试入口 tests/remote.test.mjs：官方签名独立向量、本机端到端、条件写、版本、保留返回缺失、坏内容、重定向及明文拒绝。参考 [AWS SigV4](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html)、[条件写](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)、[Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)。签名用 Node 标准 crypto，未复制 AWS SDK。

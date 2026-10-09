# 来源、复用与许可证

| 组件 | 来源与版本 | 使用方式 | 许可 |
|---|---|---|---|
| MoonBit core | 编译器配套 core，验证基线 moonc 0.10.14 | JSON、字节、UTF-8、容器等标准库 | Apache-2.0 |
| SHA-256 | [moonbitlang/x](https://github.com/moonbitlang/x)，0.5.5 | 调用公开 crypto API；未自创加密原语 | Apache-2.0 |
| Node.js | 用户安装的 Node ≥ 22 | 文件/进程接口；不随程序打包 | [上游许可](https://github.com/nodejs/node/blob/main/LICENSE) |
| C 目录提交辅助程序 | 本项目 `platform/rename_noreplace.c` | Linux renameat2 / macOS renamex_np 排他重命名 | Apache-2.0 |

本项目是原创备份应用，不是 HookLab/MoonMQTT 的改名，也不是 Restic 或 MoonChunk 的代码移植。CDC 使用通用 Gear 滚动指纹思路，确定性表由本项目种子公式生成；指纹只决定分块边界，实际对象身份使用 SHA-256。

设计调研参考 [Restic CDC 介绍](https://restic.net/blog/2015-09-12/restic-foundation1-cdc/) 和 [MoonChunk](https://github.com/xgzh1111/1234) 的职责边界。未复制两者的源代码，也不兼容其仓库格式。持久仓库、安全恢复和文件系统事务由本项目实现。

完整 Apache-2.0 文本在根目录 `LICENSE`，依赖归属在 `NOTICE` 和 `licenses/`。发布源码和构建产物时同时保留这些材料，不把第三方实现称为本项目自研成果。

# DSH 0.2.1-rc.5 兼容验证

日期：2026-11-04。插件版本 1.4.2，基于 1.4.1。仅覆盖官方 npm `latest` / `next` 指向的 0.2.1-rc.5，不适配 `alpha` 分支。rc.5 的名称仍含 rc，并非声称已发布不带后缀的稳定版本。

官方来源：[发布记录](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5)、[npm 包](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.1-rc.5)。rc.4 修复 ACP 诊断输出，rc.5 改善思考展示。

## 检查结论

使用干净目录安装完整官方 `@deepseek-ai/dsh@0.2.1-rc.5`，比对本机桌面 rc.3 的实际运行代码：`dsh-settings`、`dsh-config-editor`、`dsh-hmr`、`dsh-llm-pi-ai`、`dsh-compaction` 与 `dsh-client-ui-settings` 的 `lib/index.js` 内容一致。Cordis 保持 4.0.5，pi-ai 为 1.5.0。未发现需要改写的插件宿主接口。

本版保留现有设置保存、请求元数据、图片、压缩及故障恢复接法。另纳入 [Argon 长工具参数修复](Gemini-Argon-streaming-fix.md)，它是插件现有功能的缺失，不是 rc.5 的破坏性接口变化。补强实际 Web profile 的适配状态断言，确保首次启动、停用再启用、重启后适配器确实挂接，验证停用状态与配置持久化。没有为了版本更新人为改写协议。

## 验证范围

| 环境 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| 官方 npm rc.5 完整宿主，Node 24.19.0 | 330 | 0 | 0 |
| 本机提取 rc.3 完整宿主，匹配桌面运行时 | 330 | 0 | 0 |

覆盖真实 SettingsForms / ConfigEditor / HMR 文件保存、完整 Web profile 启停和重启、模型与自定义阈值保留、原生适配器、工具调用及回传、多图编码、压缩、413 恢复、取消、超时与同模型故障切换。推理上游使用本地模拟，未验证或消耗真实账号额度。

账户、API key 与 Token 历史均未读取或迁移；模型参数、缓存策略和 dispatch 子代理规则未修改。本机安装阶段已按用户授权备份并更新旧插件、重启桌面应用；实际保存并恢复测试设置，账号文件与原有配置保留。

复现：

```sh
DSH_FACTORY_HOST_ROOT=/path/to/rc5/node_modules node --test --test-concurrency=1 test/*.mjs
```

需完整宿主与匹配的原生依赖；缺失宿主导致跳过不能计为适配通过。

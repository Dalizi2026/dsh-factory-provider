# dsh-factory-provider

把 **Factory（Droid）订阅额度接入 DeepSeek Harness（DSH）**。使用自己的 Factory API key，在 DSH 中选择 Claude、GPT、Gemini、Grok、Muse 和 Core 模型，并查看额度、Token 用量及调整压缩阈值。

**当前版本：1.3.9** · [下载插件](https://github.com/Dalizi2026/dsh-factory-provider/releases/latest) · [更新记录](CHANGELOG.md) · [反馈问题](https://github.com/Dalizi2026/dsh-factory-provider/issues)

这是社区插件，与 Factory、DeepSeek 无官方隶属关系。需要已有的 Factory 账号、模型权限和可用额度；不会提供额外额度或绕过账号限制。

## 1.3.9：适配 DSH 0.2.1-rc.1

新版 DSH 改为从插件自身的 Config 生成设置，移除了旧的 `installSection` / `register` 接口。本版已接入新版设置服务，保留自定义设置页、已有选择与阈值；保存配置后延后更新模型目录，避开当前设置事务。无效阈值仍会在写入前被拒绝，旧版设置接口分支保留。

在桌面端 0.2.1-rc.1 提取的实际宿主上，**304 项离线测试通过、0 失败、0 跳过**；新增测试使用实际 SettingsForms 与 Cordis，仅将配置文档编辑器放在内存中，覆盖保存、热生效、版本冲突、停用和卸载清理。图片恢复测试同步传入新版必需的取消信号。旧版 0.2.0-rc.2 原有 300 项通过，四项新版专用测试按能力检测跳过。本轮未调用付费模型。

## 模型目录（含 1.3.8 新增）

依据官方 **Droid CLI 0.243.0** 补齐三个模型：

| 模型 | 分类 | 倍率 | 最大输入 / 输出预算 | 默认思考 | 图片 |
| --- | --- | --- | --- | --- | --- |
| Nemotron 3.5 Super | Core | 0.08× | 934,464 / 65,536 | high，可关闭 | 支持 |
| Muse Spark Open | 标准池 → Muse | 0.5× | 908,928 / 131,072 | high | 支持 |
| Muse Spark 1.2 | 标准池 → Muse | 0.5× | 908,928 / 131,072 | high | 不支持 |

三者默认 **250,000 token 开始压缩**，可在模型卡中修改。以上是 CLI 的适配器预算，不是实测服务器硬上限。Nemotron 3.5 Super 与 Muse Spark Open 登记上游为 Baseten；Muse Spark 1.2 为 Fireworks。

**旧版升级后**，完整退出并重新打开 DSH，再到 **设置 → Factory (Droid) → 模型**：在 Droid Core 中勾选 Nemotron；启用标准池下的 Muse 分组、勾选模型并保存。已有模型选择和自定义压缩阈值保留，新增模型不会自动覆盖旧选择。

## 安装

需要 Node.js 20+、可用的 `dsh` 命令和 Factory API key。已用 macOS 桌面包的 **DSH 0.2.1-rc.1 / 0.2.0-rc.2** 完成离线宿主集成测试。代码包含 Windows / Linux 适配，其他系统尚未逐一实机验证。

### 从 Release 安装（推荐）

```sh
dsh plugin --profile desktop add https://github.com/Dalizi2026/dsh-factory-provider/releases/download/v1.3.9/dsh-factory-provider-1.3.9.tgz
```

也可以从 [Release](https://github.com/Dalizi2026/dsh-factory-provider/releases/latest) 下载 `.tgz`，把命令末尾替换成本地文件路径。`dsh-factory-provider.tgz` 与带版本号的文件内容相同，附带 `SHA256SUMS.txt` 供校验。源码 ZIP 是仓库快照，安装请使用插件 `.tgz`。

`desktop` 是桌面版使用的 profile；使用其他 profile 时替换为对应名称。

### 从源码安装

```sh
git clone https://github.com/Dalizi2026/dsh-factory-provider.git
cd dsh-factory-provider
npm install
dsh plugin --profile desktop add "link:$PWD"
```

**安装或更新后必须完整退出并重新打开 DSH。** 只刷新设置页可能仍在使用旧网关；修改模型勾选后若选择器没有刷新，也请完整重启。

### 配置 API key

1. 在 [Factory](https://app.factory.ai) 设置里创建 API key。
2. 打开 **DSH 设置 → Factory (Droid) → API key**，粘贴 `fk-…`，点击「保存并使用」。
3. 在「模型」卡中启用需要的分组、勾选模型并保存，然后到聊天界面的模型选择器选择。

可以点击「测试连接」检查链路；**这会发送一条真实小请求并消耗额度**。新模型是否可用仍取决于账号、地区与 Factory 服务状态。

卸载：

```sh
dsh plugin --profile desktop remove dsh-factory-provider
```

## 模型分类与额度

| 设置页分组 | 额度池 | 接入方式 |
| --- | --- | --- |
| Droid Core：GLM、Kimi、MiniMax、DeepSeek、Mistral、Nemotron 等 | 先用标准额度，耗尽后可用 Core | Chat Completions |
| Claude | 标准 | Anthropic Messages |
| GPT | 标准 | Responses |
| Gemini（含 Gemini 4 Argon） | 标准 | 插件内置原生 Gemini 流转换 |
| Grok | 标准 | Responses |
| Muse | 标准 | Chat Completions |

「倍率低」不等于「Core 模型」，两个 Muse 不归入 Core。模型倍率和促销有效期按已核实的目录显示；实际可用性及额度计算由 Factory 决定。

每组可以独立折叠、启用和全选。模型勾选列表为空代表全部显示；列表非空时，只显示已勾选模型。禁用分组会移除该组的插件配置，不影响其他来源的模型。

## 设置页

| 卡片 | 可以做什么 |
| --- | --- |
| 连接状态 / API key | 查看接入状态，保存、切换或删除多个 key |
| 订阅额度 | 查看标准池与 Core 池的 5 小时、周、月用量和重置时间，开启额度悬浮窗 |
| Token 统计 | 按模型查看未缓存输入、输出、缓存读取、缓存写入和总计 |
| 上下文与压缩 | 设置摘要模型、摘要输出上限、上下文对齐和可选工具清理 |
| 模型 | 选择模型，编辑每个模型的压缩阈值，恢复默认 |
| 高级 | Anthropic 上游优先开关、缓存模式、请求大小保护与诊断 |

### 上下文与压缩

在 **模型 → 压缩阈值** 中选择模型，输入 token 数并保存。预算详情默认折叠，窗口明显小于原厂标称窗口的渠道会显示提醒。

- Opus 5.5 / Sonnet 5.5 普通版默认 400,000；GLM-5.3 Flash 默认 900,000。这些是插件已有策略。
- 本版三个新模型默认 250,000，与 Droid CLI 对齐；其他模型依各自已登记策略设置。
- 「恢复默认」移除该模型的用户覆盖；升级保留已有有效自定义值。
- 实际阈值还受 Factory 输入预算、DSH 窗口、输出预留和思考档位限制。

提高阈值会减少压缩次数，也会增加每轮历史输入量；不能保证越大越省。模型能容纳的 token 数与请求文件的字节大小是两种限制，多图仍可能先触发请求大小保护。

压缩摘要默认可使用 GLM-5.3 Flash；修改位置是「上下文与压缩 → 压缩用的模型」。所选模型须已启用且支持历史内容，含图片的摘要需要读图能力；不可用时的回退可能增加消耗。

### 缓存与工具清理

Claude 默认缓存模式为 `auto`：客户端已有缓存标记时保留其管理方式，否则补充缓存断点。默认 TTL 为 `5m`；`1h` 取决于上游支持，写入成本也更高。Gemini、GPT 等渠道使用各自的服务端机制，不能套用 Claude 标记。

**工具结果清理默认关闭。** 开启后，Anthropic 上游可分批清除旧工具结果，减少后续输入；它也可能导致缓存重建或重新读取。已有合成样本验证过节省，但不能保证所有任务更省。需要反复引用早期文件的任务，建议保持关闭；扫描任务可以先让模型把结论写进笔记文件。

### 上游线路

插件按当前 key 的官方配置选择候选上游，并让同一会话保持成功线路。正常线路不会因为候选排序更新而随意切换；遇到可重试故障时，为下一次 DSH 重试选择后续候选，重试次数由 DSH 控制。

在 **高级 → 连接** 开启「优先使用 Anthropic 官方上游」，会让 Claude **新会话** 优先选账号允许的 Anthropic 线路；已有正常会话继续保持原线路。这仍然经过 Factory 转发并使用 Factory 额度，不是直接拿 Factory key 请求 Anthropic API。

切换上游可能需要重建缓存。失败线路恢复后，同一会话不会主动切回；重启、会话状态淘汰或候选资格变化可能重新选择线路。

## 图片与 413 处理

插件复用 DSH 图片编码器，根据图片数量及文字、工具占用分配预算，支持多图自适应。不会修改原始图片文件，也不承诺任意数量图片都能装进一次请求。

最终 JSON 默认本地保护预算为 **4 MiB**，并非 Factory 服务器已实测上限。超限时优先请求移出旧图片，再通过 DSH 原生事务压缩历史；恢复有次数限制。最新一批图片仍无法容纳时会明确报错，不会原样无限重发。

## Token 统计与隐私

时间范围包括 **今天、24 小时内、7 天、30 天、总计**；30 天只是筛选，历史不会自动删除。

`总计 = 未缓存输入 + 输出 + 缓存读取 + 缓存写入`。OpenAI 总输入中的缓存读取会先扣除，避免重复计数；上游未报告的字段显示 `—`。这些是 token 数，不是 Factory 的标准额度或计费权重；仅统计经本插件处理的请求，按模型合并多个 key 的用量。

| 本机数据 | 位置与说明 |
| --- | --- |
| API key | `~/.dsh-factory-provider/accounts/`；POSIX 文件权限 0600，不写进插件设置或日志 |
| Token 记录 | `~/.dsh-factory-provider/token-usage/`；只保存请求标识、时间、模型和计数 |
| 诊断日志 | 插件目录的 `journal.jsonl`；记录请求形态、实际线路、状态及发送阶段 |

支持多个 key，切换后下一次请求使用新 key。删除当前 key 会停用凭据。模型请求经本机回环网关发往配置的 Factory 主机；额度和路由配置也会向 Factory 查询。

## 常见问题

**升级后没有新模型？** 完整重启 DSH，在 Factory 插件的模型卡里启用对应分组、勾选并保存。旧版的勾选范围会保留，不会自动全选新模型。保存后选择器仍旧时再重启一次。

**Core 用了很多，仍显示 0%？** 插件显示 Factory 返回的额度数据。先与官网同账号的 Usage 页面比较；如果官网也为 0%，不能仅凭百分比判断未产生用量或额度无限。Token 统计与额度百分比不是同一口径。

**出现 503 / Overloaded 或长时间等待？** 查看实际上游、发送与结束日志，区分上游失败、网络等待和本地超时。插件有故障候选轮换，但无法保证 Factory 一定有健康线路。不要把所有错误都当作同一种原因。

**缓存命中率低？** 同时看每次请求的缓存读取与新增输入。新会话首次写入、长代码生成、压缩、清理或切换上游都可能降低累计比例。短请求无法验证长前缀缓存，不保证固定命中率。

**界面是新的，但接口 404 / 功能不生效？** 完整退出并重新打开 DSH；前端与网关可能加载了不同批次的代码。诊断状态接口 `/api/dsh-factory-provider/status` 应报告 `version: 1.3.9` 和目录版本 `0.243.0`。

**子代理提示 route is not allowed？** 先让主代理调用 `list_subagent_models`，使用当前会话允许的准确 provider/model。插件的 Factory 路由与其他插件的同名模型不是同一条路由；会话授权也由 DSH 管理。

提交问题时请附 DSH / 插件版本、模型、错误时间、脱敏报错及相关日志。不要附 API key、完整请求正文或私人对话。

## 开发与验证

```sh
npm install
npm test

# 使用本机 DSH 的 node_modules，运行全部离线宿主集成测试
DSH_FACTORY_HOST_ROOT=/path/to/dsh/node_modules npm test
```

1.3.9 在新版 DSH 0.2.1-rc.1 上完整回归为 **304 项通过、0 失败、0 跳过**，包括真实 DSH 适配器配合本地模拟网关的工具回传、缓存统计、会话线路保持，以及多图、压缩、配置生命周期和界面检查。旧版 0.2.0-rc.2 原有 300 项通过，四项新版 SettingsForms 专用测试跳过；未设置宿主路径时其他宿主集成测试也会跳过。

1.3.8 加入的三个模型已完成离线验证及本机配置加载检查，**尚未逐一做真实上游调用**。此前 Gemini 4 Argon、Gemini 3.8 Flash 和 Claude 的真实请求结果见 [更新记录](CHANGELOG.md)，不能据此保证所有账号或服务状态都可用。离线测试无需真实 key，不会调用付费模型。

模型预算证据保存在 `test/fixtures/`；已有模型以 CLI 0.241.0 审计表为基础，本版新增条目取自 0.243.0。压缩策略单独维护，避免把插件策略误写成官方默认。

## 致谢与许可

感谢 [@huangzhenhao90](https://github.com/huangzhenhao90) 通过 [PR #1](https://github.com/Dalizi2026/dsh-factory-provider/pull/1) 贡献 DeepSeek V4.1 Flash 与 GPT-6.1 Sol 的目录更新。原始提交与署名保留；维护者随后补齐旧条目清理、官方路由、预算核实、升级兼容和回归测试。

[MIT License](LICENSE)。

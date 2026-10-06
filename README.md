# dsh-factory-provider

把 [Factory](https://factory.ai) 的模型接进 [DeepSeek Harness](https://github.com/deepseek-ai) —— 用 Factory 订阅额度跑 DSH，支持 Claude、GLM、Kimi、MiniMax 等模型。

**当前版本：1.3.5**

## 1.3.5 更新

- **修复上游线路固定的问题**：38 个模型按当前 API key 的官方路由配置选择线路；过载、5xx 或传输故障时，下一次 DSH 重试切到后续候选线路。
- **成功线路按会话保持**：减少反复换线路导致的缓存重建；不同 key、模型和会话的线路状态独立。
- **Claude 可优先使用 Anthropic**：设置页顶部新增「Claude 上游」卡片，默认关闭；开启后将当前 key 允许的 Anthropic 上游排到首位，故障时仍按后续候选切换。
- **处理流内过载和本地超时**：请求尚未输出内容时，识别过载错误并交给 DSH 重试；确认本地超时后可切换线路，手动停止不会触发切换。
- **补齐发送阶段日志**：能区分请求进入网关、等待上游响应头、流中失败，日志不记录 API key 或完整请求内容。

验证：**273 项离线测试全部通过，包含真实 DSH 宿主集成，0 跳过**。2026-10-06 的 6 次真实小请求也全部成功（Opus 5.5 四次、GLM-5.3-Flash 两次）；当时未出现 503，因此真实故障切换仍由离线模拟验证。这组短请求不用于评估长对话缓存率。2026-10-07 新增的 Anthropic 优先开关已验证保存、热生效、故障回退与路由隔离，尚未追加真实上游测试。

**更新后请完整退出并重新打开 DSH**，让新的服务端网关加载。

---

## 目录

- [它做什么](#它做什么)
- [支持的 DSH 版本](#支持的-dsh-版本)
- [安装与使用](#安装与使用)
- [设置页说明](#设置页说明)
- [省额度](#省额度)
- [Token 统计](#token-统计)
- [多账号切换](#多账号切换)
- [跨平台](#跨平台)
- [配置项](#配置项)
- [常见问题](#常见问题)
- [工作原理](#工作原理)
- [开发](#开发)
- [许可](#许可)

---

## 它做什么

| 功能 | 说明 |
| --- | --- |
| **三条协议路由** | Anthropic Messages、OpenAI chat/completions、OpenAI responses，SSE 流式原样透传 |
| **上游故障切换** | 按当前 API key 的官方路由顺序切换；成功线路按会话保持，避免一直重试故障线路 |
| **模型目录** | 把 Factory 的模型表写进 DSH，含每个模型的思考强度档位（low/medium/high/xhigh/max） |
| **凭据管理** | 粘贴 API key 即用，可存多个切换；key 只存本机（0600），不进设置文件、不进日志 |
| **订阅额度** | 设置页显示标准池与 Core 池的 5 小时 / 周 / 月用量、重置倒计时、超额策略 |
| **额度悬浮窗** | 可选：桌面悬浮小窗，渐变进度条 + 状态圆点 + 环形折叠态，可拖动、可关闭 |
| **服务器端工具清理** | 默认关闭；可选分批清理旧工具结果，减少后续重复输入，实际节省取决于缓存重建和重新读取 |
| **Token 统计** | 按模型累计输入 / 输出 / 缓存读取 / 缓存写入，支持今天 / 24h / 7 天 / 30 天 / 总计 |
| **压缩优化** | 逐模型上下文预算与压缩阈值；可用便宜的 GLM-5.3-Flash 做摘要（实测压缩比 3.4%）|
| **图片自适应** | 按图片出现次数分配编码预算，复用 DSH 图片编码器 |
| **413 恢复** | 有次数限制的恢复：先移出旧图片，再压缩历史；不会原样无限重发 |
| **诊断日志** | `journal.jsonl` 记录每次转发的请求形态与上游状态 |

**三条路由的区别**：

| 路由 | 协议 | 典型模型 |
| --- | --- | --- |
| `generic` | OpenAI chat/completions | GLM-5.3-Flash、Kimi、MiniMax、DeepSeek |
| `anthropic` | Anthropic Messages | Claude Opus 5.5、Sonnet 5.5 等 |
| `openai` | OpenAI responses | GPT 系 |

---

## 支持的 DSH 版本

| | |
| --- | --- |
| **已验证** | DeepSeek Harness **0.2.0-rc.2**（macOS 桌面版，实测通过）|
| 更早版本 | **未测试** —— 接口可能不存在，见下表 |
| 更新版本 | **未测试** —— 若接口有变动，插件会记日志而不是静默失败 |

查自己的版本：

```sh
dsh --version
```

### 插件依赖的 DSH 接口

这些是插件与 DSH 的接触面。缺哪个，对应功能就失效 —— 插件会在日志里写明原因，不会静默出错。

| 接口 | 用途 | 缺失时的表现 |
| --- | --- | --- |
| `ctx.inject(["webServer", "settings"])` | 取得 web 端口与设置服务 | 插件不注册任何路由，日志：`webServer/port unavailable` |
| `webServer.register(route)` | 注册回环网关与设置页接口 | 同上 |
| `settings.installSection(ctx, ns, schema, entry, hooks)` | 注册设置页 | 自动降级到 `settings.register` |
| `settings.describe()` / `settings.mutate(ns, ops, revision)` | 写入 provider 配置 | provider 写不进去 → 模型列表为空，日志：`provider reconcile failed` |
| schemastery 的 `.volatile()` | 让设置项可写 | 保存设置报 `has no volatile fields` |
| `ctx.emit("loader/volatile-update")` | 通知 DSH 重建模型目录 | 模型能用，但选择器可能要重启才刷新 |

### 怎么确认在你的版本上正常

1. 装好并重启 DSH
2. 打开 **设置 → Factory (Droid)**，看「连接状态」徽标是不是 **API key**
3. 点 **测试连接** —— 返回 200 就说明从 DSH 到 Factory 整条链路通了

任何一步不对，先看插件目录下的 `journal.jsonl`（最后几行会写明是哪一步失败）。

---

## 安装与使用

### 第 1 步：拿一个 Factory API key

在 [Factory](https://app.factory.ai) 的设置里生成一个 API key（形如 `fk-…`）。

**还需要 DSH 本身**，并确认 `dsh` 命令可用。

### 第 2 步：安装插件

把仓库 clone 到本地任意目录，然后：

```sh
dsh plugin --profile desktop add link:<你 clone 的目录>
```

- `desktop` 是 DSH 桌面版 GUI 使用的 profile 名；如果你是别的 profile，换成对应的名字
- 用 `link:` 安装表示直接引用本地目录——**你改了源码，插件就跑新代码**（改完需重启 DSH 生效）

安装完成后，**重启一次 DeepSeek Harness**，让插件完整加载。

> ⚠️ **重启是必须的，插件管理器的热重载不够。** 客户端那半（界面）会立刻更新，但服务端那半（路由、网关）只在进程启动时加载一次。所以会出现「界面是新的、接口却 404/401」的错配。

**卸载**：

```sh
dsh plugin --profile desktop remove dsh-factory-provider
```

卸载时插件会自动清理它写进 DSH 的 provider 配置（按 baseURL 识别，不会碰你自己的其他 provider）。

### 第 3 步：把 key 粘进插件

打开 **设置 → Factory (Droid) → API key**：

1. 在「粘贴 Factory API key（fk-…）」输入框里粘上那串 key（可选填备注名）
2. 点 **保存并使用**

保存后插件立刻切到这个 key，**不需要重启**。key 只存在本机（`~/.dsh-factory-provider/accounts/<id>/api-key`，权限 0600），不写进设置文件，也不进日志。

### 第 4 步：确认接入成功

打开 **设置 → Factory (Droid)**，看「连接状态」卡片：

- 徽标显示 **API key**（表示已配置）
- 能看到 **token 有效期**和**组织 ID**
- **Provider 写入**显示 `clean` 或 `applied`

最直接的验证：点 **测试连接** 按钮。它会真实发一条 16-token 的请求走完整链路：

- 成功 → 说明从 DSH 到 Factory 全线打通 ✅
- 失败 → 面板会给出上游返回的状态码和消息

### 第 5 步：在 DSH 里选模型

接入成功后，**Factory 的模型会出现在 DSH 的模型选择器里**，按 provider 分组（`Factory (Droid) — …`）。直接选就行。

每个模型的可选**思考强度**（low / medium / high / xhigh / max 等）按 Factory 官方模型表的实际取值写入，在 DSH 的模型选项旁直接选。Claude 系走自适应 thinking（Factory 的 bedrock_anthropic 路由只接受这种），旧式 budget 参数会被上游拒绝。

**遇到模型不可用？** 部分模型有**地区门禁**（上游返回 `Provider not available in this region`），插件已把确认受限的几个从列表里剔除。

### 第 6 步：按需精简模型列表

DSH 的模型列表太长会很碍事。在「模型」卡片里：

1. 每个模型左侧有**勾选框**，逐条挑选；卡片右上角有**全选 / 清空**
2. 勾完点**保存**

语义：

- **一个都不勾 = 显示全部**（默认行为，不会把列表清空）
- 某条路由的模型被**全部取消勾选** → 该 provider 整条从列表消失
- 想恢复全部，点「全选」再保存

---

## 设置页说明

设置页的卡片**都能折叠**，而且**会记住你的折叠状态** —— 收起某个卡片后，下次打开还是收起的。

| 卡片 | 首次默认 | 内容 |
| --- | --- | --- |
| **连接状态** | 展开 | 凭据徽标、上游地址、组织 ID、Provider 写入状态、测试连接 |
| **Claude 上游** | 展开 | 优先使用 Anthropic 官方上游的开关与保存；默认关闭 |
| **API key** | 展开 | 账号列表、粘贴新 key、切换、删除 |
| **订阅额度** | 展开 | 标准池与 Core 池的用量进度条、重置倒计时、超额策略；额度悬浮窗开关 |
| **Token 统计** | 收起 | 按模型的用量累计（展开后才开始请求）|
| **上下文与压缩** | 展开 | 工具清理、上下文对齐开关、摘要设置 |
| **模型** | 收起 | 选择模型、编辑压缩阈值并保存；三条路由的模型显示范围 |
| **高级** | 收起 | 连接与缓存配置、请求保护、诊断日志 |

> **改完记得保存。** 「Claude 上游」「模型」「上下文与压缩」和「高级」均可保存当前修改。

---

## 省额度

Factory 的额度按**计费权重**扣：缓存读取 ×0.1、缓存写入 ×1.25、未缓存输入 ×1、输出约 ×5。再乘模型倍率（Opus 5.5 是 1.6x，Sonnet 5.5 是 0.8x，GLM-5.3-Flash 只有 0.06x —— **相差 27 倍**）。

这个插件有三处直接影响花费：

### 1. 服务器端工具清理（默认关闭）

开启后，插件在请求里加 `context_management`，让 **Anthropic 的服务器在把提示词送进模型之前**清掉旧的工具结果。

清理后可以减少后续输入，但可能触发缓存重建，也可能需要重新读取被清掉的工具结果；是否更省要看实际输入、缓存写入和输出用量。

实测数据（`claude-sonnet-5-5`，合成样本）：

| 策略 | 计费权重合计 | 相对关闭 |
| --- | --- | --- |
| 关闭 | 77,227 | — |
| 每次请求清理 | 49,090 | −36.4% |
| **分批清理（当前实现）** | **45,420** | **−41.2%** |

分批清理比每次请求清理**再省 7.5%**，而且缓存读取率更高（第 2/3 轮 83.9% / 86.1%，原策略是 0% / 76.2%）。

**质量验证**：把一个唯一密钥埋进会被清掉的文件再问模型 —— 它如实回答「看不到，我也绝不会猜」，并准确指出哪些文件被清、哪些还在。**没有编造。**

> ⚠️ **这些数字是合成样本，不能当作所有任务的额度降幅。** 未计入输出、模型重读文件的成本，以及真实任务的复杂开销。工具输出多且不再需要的会话收益大；需要反复交叉引用早期内容的会话收益小甚至为负。

**扫描类任务请让模型边扫边写笔记。** 清理掉的是原始工具输出，模型自己的分析结论（助手消息）不会被清 —— 但只留在对话里的细节会丢。开始扫描前交代它「把每个模块的理解写进 `NOTES.md`」，这样原始内容被清也不丢知识。

**什么时候该关**：需要反复交叉引用早期文件内容的重构任务。

### 2. 用便宜模型做压缩摘要

DSH 压缩历史时要用模型生成摘要。默认会**沿用主模型** —— 用 Opus 5.5 做摘要，一次就是几万额度。

把「压缩用的模型」设成 `GLM-5.3-Flash`（0.06x），摘要成本降到约 **1/27**。

实测：14,864 字符的对话转写 → 摘要 500 字符（**3.4%**），6 个埋入事实**全部保留**。

含图片的历史需要模型能读图 —— 已验证 `glm-5.3-flash` 可以（用一张带唯一四位数的图测过，它读回无误）。未验证的模型会在花掉一次全历史调用**之前**被拒绝。

### 3. 提高压缩阈值

普通 Opus 5.5 / Sonnet 5.5 的压缩阈值仍默认 40 万 token。提高阈值通常减少压缩次数，也会增加历史读取量与缓存失效后的冷输入量；重写成本还受压缩方式和缓存状态影响。是否更省额度要比较实际输入、摘要、缓存读写及额度，不只看命中率。

### 逐模型压缩阈值

在「模型」卡中选择一个模型，输入整数 token 数，然后保存。「恢复默认」会移除该模型的用户覆盖；切换模型不会丢失其它模型的待保存修改。预算详情默认折叠，Factory 窗口显著小于原厂标称窗口的条目显示简短提醒。

默认值属于经用户批准的插件策略，保留原始 Droid 预算表，**不是已实测最优值，也不是原厂在 Factory 上的默认值**：

| 模型组 | 默认压缩阈值 |
| --- | ---: |
| GLM-5.3-Flash / GLM-5.3 | 900000 / 890000 |
| Qwen3.8-Max / Kimi K3 | 118000 / 190000 |
| MiniMax M3 / M2.7 | 420000 / 185000 |
| Opus 5、4.8、4.7；Fable 5、5.1；Sonnet 5 | 850000 |
| Sonnet 4.6 | 910000 |
| DeepSeek V4 Pro / Flash-0731 | 830000（参考 DSH 通用规则） |
| GPT / Inkling | 250000 |
| Nemotron-3-Ultra | 136464 |
| 普通 Opus 5.5 / Sonnet 5.5 | 400000 |
| Opus 5.5 Fast | 250000；地区限制保留 |
| Haiku 4.5 | 按思考档位：low 153904、medium 145712、high 133424 |

GLM / Qwen 留13000额外缓冲，其他长窗口Claude借用同样缓冲；MiniMax留2048，DeepSeek留65536。可保存上限为 `min(Factory输入预算,窗口−目录最大输出)−缓冲`。实际执行还受更小宿主窗口、本轮输出预留、Haiku思考档位和宿主显式低阈值限制；413字节保护继续独立生效。摘要输出设置与压缩后的目标比例保持现有配置。

用户覆盖保存在 `modelCompactionTokens` 中。优先级是：逐模型覆盖 → 三个旧专用字段的已有值 → 新默认策略。旧配置不会被静默清掉，普通 Opus 5.5 / Sonnet 5.5 / GLM Flash 的旧字段继续兼容。

策略依据：[ZCode](https://zcode.z.ai/cn/docs/qa)、[Qwen Code](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatCompressionService.ts)、[Kimi CLI](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/configuration/config-files.md)、[MiniMax Code](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/agent-modules/context-manager/src/provider-budget.ts)、[Claude Code](https://code.claude.com/docs/en/model-config#context-window-and-auto-compaction)。无可靠原厂精确触发线的模型继续保留Droid设置；MiniMax有不同运行路径，本插件参考新本地预算函数。

---

## Token 统计

按模型累计用量，支持**今天 / 24 小时内 / 7 天 / 30 天 / 总计**五个范围。

```
模型              输入 token  输出 token  缓存读取  缓存写入  总计
GLM-5.3 Flash     14.1K       3,537       1.3M      —        1.3M
```

- 数字用紧凑格式（`1.3M`），**鼠标悬停显示精确值**
- 未上报的字段显示 `—`，**不当成 0**
- 展开卡片后才开始请求，收起时停止轮询

**统计口径**：

| 渠道 | 「输入」列的含义 |
| --- | --- |
| Anthropic | 上游报告的**未缓存**输入；缓存读取、缓存写入单独计数 |
| OpenAI Chat / Responses | 上游总输入**已含**缓存读取；先扣除再填入输入列 |

所以 `总计 = 未缓存输入 + 输出 + 缓存读取 + 缓存写入`，**不会重复计算**。

**数据保存**在 `~/.dsh-factory-provider/token-usage/`：

```
metadata.json
YYYY-MM-DD.jsonl
```

- **不自动删除历史**（「30 天」只是显示筛选）
- 首次初始化会从现存 `journal.jsonl` 导入有效记录，**只导入一次并去重**
- 只保存时间、请求标识、模型和计数 —— **不保存 key、提示词、图片或回复**
- 目录权限 0700、文件 0600

> **这些是实际 token 数，不是 Factory 标准额度或扣费权重。** 跨 key 按模型合并；其他客户端的用量不会进来。

---

## 多账号切换

可以存多个 API key 并在设置页切换。切换后**下一次请求**就用新 key，不需要重启。

- 删除正在使用的 key 会停用凭据（不会偷偷回退到别的 key）
- key 之间互相隔离：额度按 key 查询、模型目录按 key 的权限生成
- 旧版本用 droid CLI 登录态建的快照**本版本不再读取**，可以直接删

---

## 跨平台

**macOS / Windows / Linux 都支持。** 已做的适配：

| 项 | 做法 |
| --- | --- |
| 家目录 | `os.homedir()` —— Windows 上自动是 `C:\Users\…` |
| 路径拼接 | 全部 `path.join`，**没有手写 `/`** |
| 文件权限 | Windows 上**跳过** `chmod`（那套语义只对 POSIX 有意义）|
| 回环判断 | 同时接受 `127.0.0.1`、`::1`、`::ffff:127.0.0.1` |
| 数据文件名 | `YYYY-MM-DD.jsonl` —— 不含 Windows 非法字符 |
| 换行符 | 自己写 `\n`；读入时容忍 `\r\n` |
| import 路径 | 全部小写且与磁盘逐字一致（Linux 区分大小写）|
| 依赖 | **零运行时依赖、零原生模块、零外部命令** |

**一个已知限制**：在不支持 `chmod` 的文件系统上（某些 Docker 卷、网络盘、特殊挂载），**保存 API key 会失败并报错**。这是刻意的 —— 与其把密钥明文存下去，不如报错。失败是干净的：不会留下残缺文件，已有账号不受影响，环境恢复后照常工作。Windows 不受影响。

---

## 配置项

`cordis.patch.yml` 里是出厂默认值；**设置页的修改优先**且写入插件自己的 settings 命名空间。两边字段一致：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后只保留诊断路由，并清理已写入的 provider |
| `routes` | `["generic","anthropic","openai"]` | 启用哪几条路由 |
| `cliVersion` | `"0.231.0"` | 网关呈现给 Factory 的 CLI 版本（UA）。保持默认即可，它是边缘校验的一部分 |
| `apiBaseURL` | `"https://prem.factory.ai"` | 推理主机。EU 等区域账号若不同，在这里改 |
| `quotaHost` | `"https://api.factory.ai"` | 额度端点主机 |
| `keyEnv` | `"FACTORY_API_KEY"` | 未选择任何 key 时，从这个环境变量（以及 DSH 凭据存储）取 key |
| `anthropicCacheMode` | `auto` | Anthropic 缓存断点：`auto`（客户端自带标记时不插手）/ `rewrite`（插件统一接管）/ `passthrough`（完全不改，诊断用）|
| `anthropicCacheTTL` | `5m` | 插件自己创建的断点用多长 TTL。`1h` 是实验选项，上游不支持时会报错，改回 `5m` |
| `anthropicPreferOfficial` | `false` | Claude 优先选择当前 key 允许的 Anthropic 上游；仍经 Factory 转发并扣订阅额度。不可用时沿用官方顺序，故障时可回退。保存后下一次请求生效 |
| `anthropicToolClear` | `false` | **服务器端工具结果清理**（默认关闭，需主动开启）。仅影响 Anthropic 普通请求，插件产生的摘要请求跳过自动注入。清理会让模型看不到旧结果；客户端仍保留完整历史，上传体积不变 |
| `anthropicToolClearKeep` | `3` | 至少保留最近几个工具结果；分批模式在两次清理之间会暂时保留更多，以固定清理范围 |
| `anthropicToolClearTrigger` | `20000` | 输入低于此值时不清理，避免小请求也被动 |
| `anthropicToolClearBatchTokens` | `20000` | 分批清理：用 `clear_at_least` 设置一次清理的最小量；按会话与账号隔离批次，确认服务端清理数量后固定范围。`0` 使用原策略（每次请求都清）|
| `factoryAdaptiveImages` | `true` | 按图片出现次数、文字/工具估算占用分配压缩预算，复用 DSH 图片编码器；不兼容宿主显示未接入，可关闭回退 |
| `factoryRequestRecovery` | `true` | 只对 Factory 的 413 做有次数限制的恢复：旧图片移出请求，再由 DSH 原生事务压缩历史；不会原样无限重发 |
| `factoryRequestMaxBytes` | `4194304` | 三条路由最终 JSON 的本地保护预算（4 MiB），不是上游实测硬上限；`0` 关闭，最大 `33554432` |
| `factoryContextAlignment` | `true` | 启用 Droid CLI 0.233.0 的逐模型输入输出预算；普通 Opus/Sonnet 5.5 和 GLM Flash 使用下方单独阈值，其余保留 Droid 阈值 |
| `opus55CompactionTokens` | `400000` | 普通版 Opus 5.5 的压力压缩阈值，范围 `16384..872000`；有效值还受输入预算约束 |
| `sonnet55CompactionTokens` | `400000` | 普通版 Sonnet 5.5 的压力压缩阈值，同上 |
| `glmFlashCompactionTokens` | `900000` | GLM-5.3-Flash 压力压缩阈值，范围 `16384..904504`。参考 [ZCode](https://zcode.z.ai/cn/docs/qa) 的 13000 安全缓冲；有效阈值不超过 `min(Factory 输入预算, 宿主窗口−实际输出预留)−13000`，尊重宿主更低阈值。90 万是预算推导，尚未实测接近上限的真实请求；413 保护仍独立生效 |
| `modelCompactionTokens` | `{}` | 逐模型用户阈值覆盖，例如 `{"kimi-k3":180000}`；模型卡编辑并保存。整数下限16384，上限按模型安全预算校验；空字典使用推荐策略并兼容旧专用字段 |
| `anthropicContextOptimization` | `true` | Claude 摘要长度、摘要模型和兼容压缩优化开关；关闭它不会关闭逐模型阈值 |
| `anthropicSummaryModel` | `"factory-g/glm-5.3-flash"` | 压缩摘要用哪个模型。留空则沿用 DSH 的摘要模型设置（通常是主模型，贵得多）|
| `anthropicSummaryMaxTokens` | `16384` | 压缩摘要的输出上限，范围 `512..16384` |
| `anthropicCompactionHeadroomTokens` | `16384` | 摘要容量检查及关闭逐模型对齐后的兼容压缩安全空间，范围 `0..65536` |
| `quotaFloat` | `false` | 显示额度悬浮窗（可拖动、双击折叠、右上角可关闭）|
| `proactiveRefreshMinutes` | `5` | provider 写入未落地时的重试周期；`0` 关闭定时器 |
| `modelAllowlist` | `[]` | 模型显示范围：`[]` = 全部；非空则只显示列出的模型（建议在设置页勾选，不要手填）|

---

## 常见问题

**Q：官方 Opus 已恢复，插件仍反复报 Bedrock 503？**

当前网关按 key 从 Factory `/api/feature-flags` 读取路由配置，每 5 分钟刷新；无法读取时沿用上次成功配置，首次安装则使用随包附带的官方快照。Opus 5.5 当前顺序为 Bedrock → Snowflake → Azure → Anthropic；GLM-5.3-Flash 为 Fireworks → Baseten。不同账号、模型可能不同，最终以该 key 的官方配置为准。候选线路还需符合模型的注册能力与禁用规则。

429、5xx、传输故障及流内过载会为下一次 DSH 重试选择后续线路，成功后保持该会话的线路。认证失败、额度不足、413 不触发轮换；手动停止不触发轮换。DSH 的超时在下一次请求用本地尝试标识确认，内部标识不发给 Factory。插件不增加一层重试循环，次数与间隔仍由 DSH 控制。切换线路可能首次重新建立缓存，不能保证服务器故障时一定有可用线路。

这部分是服务端修改，更新后需要完整退出并重新打开 DSH。`/api/dsh-factory-provider/status` 应返回版本 `1.3.5`，并出现 `providerRouting` 字段，才表示新网关已加载。

**Q：故障线路恢复后，会自动切回吗？**

同一会话成功切到另一条线路后会继续使用它，不主动探测旧线路是否恢复。正常线路不会因为时间经过或官方候选排序变化而被切走。当前线路再失败时才继续轮换；官方配置将当前线路移出候选列表时也会重新选择。新会话、重启网关或会话状态被容量限制淘汰后，会重新从当时候选顺序的第一条开始（开启 Anthropic 优先时先选择允许的 Anthropic）。路由配置每 5 分钟刷新不等于每 5 分钟切回。

**Q：可以指定 Opus 5.5 使用 Anthropic 上游吗？**

可以。在设置页顶部「Claude 上游」卡片中勾选「优先使用 Anthropic 官方上游」，然后保存。它只对 Claude 生效，不影响 GPT 或 Core 模型；再次关闭会恢复官方顺序。更改开关会重置 Claude 的本地线路选择，下一次请求生效，不中断正在输出的请求。

候选中的 `anthropic` 代表通过 Factory 转发到 Anthropic，并非用 Factory key 直接请求 Anthropic API；不能据此保证更快或更稳。只有模型、账号候选配置与区域允许的 Anthropic 才会优先选择，否则保持可用线路，并在下一次 Claude 请求后显示提示。遇到故障时可回退，成功后继续保持回退线路，避免每轮重试故障上游。开关不是「强制只能用 Anthropic」。

**Q：切换上游会影响缓存吗？**

可能会。插件继续携带对话历史和缓存标记，但不能迁移上游服务器的缓存。应按切换后可能重新写入缓存来估算消耗，不能保证跨上游命中。因此成功后保持同一会话的线路，减少反复切换；实际读取与写入以返回的 usage 为准。

**Q：模型列表是空的？**

先点「测试连接」。如果返回 401，是 key 无效；如果返回 200 但列表还空，看 `journal.jsonl` 里的 `provider reconcile failed`。

**Q：界面更新了但某个功能报错（比如 Token 统计）？**

**需要重启 DSH。** 插件分两半加载：客户端（界面）从磁盘现取、立刻更新；服务端（路由）在进程启动时 `import` 一次。所以会出现「界面是新的、接口不存在」的错配。插件管理器里的热重载只换客户端那半。

**Q：改了设置，第一次点击没反应，要点第二次？**

1.2.7 及更早版本有这个 bug（轮询的依赖数组写错，第一次编辑会被立刻重载覆盖）。**1.3.0 已修复。**

**Q：勾了模型但列表没变？**

保存后模型列表**可能需要重启 DSH 才会刷新**（配置已正确写入并持久化，但运行中的模型目录不会立刻重建）。设置页的勾选本身立即生效、不会丢失。

**Q：额度悬浮窗勾了没反应？**

1.2.x 有这个 bug（组件用了未定义的变量，一渲染就崩）。**1.3.0 已修复**，并且开关搬到了「订阅额度」卡片里。

**Q：开启工具清理后，模型说它看不到某个文件？**

这是**预期行为** —— 那正是省钱的方式。模型会如实告诉你它看不到，并在需要时重新读取。如果它开始**编造**内容，请立刻关掉这个功能并反馈。

**Q：上游返回 403 / 400 且没有响应体？**

多半是边缘校验。检查 `cliVersion` 是否是默认值（它是校验的一部分），以及 `apiBaseURL` 是否匹配你的区域。

**Q：能同时用别的 provider 吗？**

可以。插件只写自己那几条 provider 配置（按 baseURL 识别），卸载时会清理，不会碰你自己的其他 provider。

---

## 工作原理

给想深入了解的读者：

- **凭据** — 你粘贴的 API key 存在本机（0600），网关每次转发时作为 `Authorization: Bearer` 附加；key 不过期，所以没有刷新与回写。实测同一个 key 也能查额度（与订阅额度是同一份）
- **请求重写** — 注入完整的 `factory-cli` 头集合（UA / `X-Factory-Client` / `x-stainless-*` / `traceparent` / `x-api-provider`）、补齐 droid 身份 system 行（边缘硬门槛）、剥离未知字段；客户端 attribution 头一律不透传
- **会话亲和** — key 与模型隔离；宿主提供会话标识时使用其哈希，否则按 system 提示与首条用户消息近似派生。每轮保留同一个 `x-session-id`，不同 key 不会合并
- **线路选择** — 按当前 key 的官方路由配置，过滤不支持或禁用的后端；故障时为下一次 DSH 重试轮换，完整成功后保持该会话的线路
- **协议适配** — 三条路由分别处理三种协议，SSE 流式原样透传；上游 401 会重新解析凭据并重试一次
- **缓存断点** — Anthropic 的提示词缓存是**显式**的，需要客户端自己打标记。插件支持三种模式，默认 `auto`（客户端已管理时不插手）
- **工具清理** — 走 Anthropic 官方的 `context_management` + `clear_tool_uses_20250919`，在服务器端分批清理；清理后可能需要重建缓存或重新读取工具结果，不保证每次开启都更省额度
- **诊断** — `journal.jsonl` 记录请求形态、实际线路、发送与结束阶段；`handler-error` 记录失败阶段，`apply-error` 记录插件加载异常

---

## 开发

```sh
npm install          # 必须：lib/index.js 需要 peer 依赖 @deepseek-ai/schemastery

npm test             # 基础回归与压缩策略测试；无需真实 API key

# 可选：对本机 DSH 的已提取 node_modules 做离线宿主集成测试
DSH_FACTORY_HOST_ROOT=/path/to/dsh/node_modules npm run test:context-host
```

> `npm install` 是必需的 —— 少了它，`test/run.mjs` 会直接报
> `ERR_MODULE_NOT_FOUND: Cannot find package @deepseek-ai/schemastery`。

**测试共 273 项**，覆盖：API key 账号库与权限、凭据解析与切换竞态、请求净化规则、模型目录、桥接路由的回环守卫、设置生命周期与卸载回滚、网关端到端（本地 mock 上游，含 SSE 流式、断连取消与 401 重试）、官方线路排序与故障轮换、账号与会话隔离、Anthropic 优先开关的保存与热生效、流内过载和本地超时、压缩预算与范围、工具清理的批次逻辑、Token 统计口径与持久化，以及设置页的界面结构。

宿主集成测试使用实际 DSH 会话、token meter、代理作用域和压缩事务，但模型响应为本地 mock；**未设置 `DSH_FACTORY_HOST_ROOT` 时这部分会跳过** —— 所以只看「tests passed」不够，要确认**跳过数为 0**。

测试无需访问 Factory 或调用真实模型。

macOS 上如果系统 `git`/`python3` 因 Xcode 许可不可用，可用：

```sh
/Library/Developer/CommandLineTools/usr/bin/git --version
```

---

## 许可

MIT，见 [LICENSE](LICENSE)。

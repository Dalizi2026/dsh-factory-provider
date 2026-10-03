# dsh-factory-provider

把 **Factory（Droid）的订阅额度**接入 DeepSeek Harness（DSH），让你在 DSH 里直接选用 Factory 的模型——GLM、Claude、GPT、Kimi、Qwen、Nemotron 等，走你自己的订阅额度。

零构建：装完即用，不需要编译。

> **免责声明**：本项目是非官方的第三方插件，与 Factory 无隶属关系。它通过本机已登录的 droid CLI 凭据访问 Factory 服务，属于个人使用场景。请遵守 [Factory 服务条款](https://factory.ai/terms)，多账号轮换等用法风险自负。

---

## 目录

- [它做什么](#它做什么)
- [使用流程](#使用流程)
  - [第 1 步：准备工作](#第-1-步准备工作)
  - [第 2 步：安装插件](#第-2-步安装插件)
  - [第 3 步：确认接入成功](#第-3-步确认接入成功)
  - [第 4 步：在 DSH 里选模型](#第-4-步在-dsh-里选模型)
  - [第 5 步：按需精简模型列表](#第-5-步按需精简模型列表)
- [设置页说明](#设置页说明)
- [API key 模式（测试版）](#api-key-模式测试版)
- [多账号切换](#多账号切换)
- [Windows / Linux 用户必读](#windows--linux-用户必读)
- [配置项](#配置项)
- [常见问题](#常见问题)
- [工作原理](#工作原理)

---

## 它做什么

DSH 本身不认 Factory。这个插件在中间架了一座**只监听本机**的桥：

```
DSH（模型选择器）
   ↓
llm-pi-ai  provider 条目（factory-g / factory-a / factory-o）
   ↓
本插件在本机开的回环网关（127.0.0.1）
   ↓  自动附加你的 Factory 登录凭据 + 官方 CLI 头集合
Factory 推理服务（prem.factory.ai）
```

于是 **Factory 的模型会直接出现在 DSH 的模型选择器里**，和内置模型一样选用；用掉的是你的 Factory 订阅额度，而不用另配 API key。

**三条路由**分别对接不同的上游协议：

| 路由 | 覆盖模型 | 额度池 |
| --- | --- | --- |
| `factory-g` | GLM / Kimi / MiniMax / DeepSeek 等 | **Core 免费池**（有自己的限额，不占标准额度） |
| `factory-a` | Claude 全系（Opus / Sonnet / Fable） | 标准订阅额度 |
| `factory-o` | GPT / Codex 系 | 标准订阅额度 |

---

## 使用流程

### 第 1 步：准备工作

**需要一个已登录的 droid CLI。** 这是凭据来源，插件自己不做登录：

```sh
npm i -g droid     # 安装 droid CLI
droid              # 运行一次，走浏览器完成登录（用你的 Factory 订阅账号）
```

登录态默认在 `~/.factory/`（Windows 是 `%USERPROFILE%\.factory`）。

> macOS 上 droid 0.231+ 会把 AES 密钥放进**登录钥匙串**，插件首次读取可能弹出一次钥匙串授权——选「始终允许」。
>
> **不想装 droid CLI？** 可以直接用 **API key 模式**（见 [API key 模式](#api-key-模式测试版)）：在设置页粘贴一串 `fk-...` 就能用。实测它与 droid 登录态**扣同一份订阅额度**，不是另一套计费。

**还需要 DSH 本身**，并确认 `dsh` 命令可用。

### 第 2 步：安装插件

把仓库 clone 到本地任意目录，然后：

```sh
dsh plugin --profile desktop add link:<你 clone 的目录>
```

- `desktop` 是 DSH 桌面版 GUI 使用的 profile 名；如果你是别的 profile，换成对应的名字
- 用 `link:` 安装表示直接引用本地目录——**你改了源码，插件就跑新代码**（改完需重启 DSH 生效）

安装完成后，**重启一次 DeepSeek Harness**，让插件完整加载。

**卸载**：

```sh
dsh plugin --profile desktop remove dsh-factory-provider
```

卸载时插件会自动清理它写进 DSH 的 provider 配置（按 baseURL 识别，不会碰你自己的其他 provider）。

### 第 3 步：确认接入成功

打开 **设置 → Factory (Droid)**（在左栏「内置插件」下方），看「连接状态」面板：

- 徽标显示 **droid CLI 已登录**（或 API key）
- 能看到 **token 有效期**和**组织 ID**
- **Provider 写入**显示 `clean` 或 `applied`

最直接的验证：点 **测试连接** 按钮。它会真实发一条 16-token 的请求走完整链路：

- 成功 → 说明从 DSH 到 Factory 全线打通 ✅
- 失败 → 面板会给出上游返回的状态码和消息

同一个面板还能看「订阅额度」：标准池与 Core 池各自的 **5 小时 / 周 / 月** 用量进度条、重置倒计时、超额策略。

### 第 4 步：在 DSH 里选模型

接入成功后，**Factory 的模型会出现在 DSH 的模型选择器里**，按 provider 分组（`Factory (Droid) — …`）。直接选就行。

每个模型的可选**思考强度**（low / medium / high / xhigh / max 等）按 Factory 官方模型表的实际取值写入，在 DSH 的模型选项旁直接选。Claude 系走自适应 thinking（Factory 的 bedrock_anthropic 路由只接受这种），旧式 budget 参数会被上游拒绝。

**遇到模型不可用？** 部分模型有**地区门禁**（上游返回 `Provider not available in this region`），插件已把确认受限的几个从列表里剔除。

### 第 5 步：按需精简模型列表

DSH 的模型列表太长会很碍事。在设置页「路由与模型」面板里：

1. 每个模型左侧有**勾选框**，逐条挑选；卡片右上角有**全选 / 清空**
2. 勾完点**保存**
3. DSH 的模型列表之后只保留你勾选的模型

语义：

- **一个都不勾 = 显示全部**（默认行为，不会把列表清空）
- 某条路由的模型被**全部取消勾选** → 该 provider 整条从列表消失
- 想恢复全部，点「全选」再保存

> ⚠️ **已知问题**：保存后模型列表**可能需要重启 DSH 才会刷新**（配置已正确写入并持久化，但运行中的模型目录不会立刻重建）。设置页的模型勾选本身立即生效、不会丢失。

---

## 设置页说明

装好后在 **设置 → Factory (Droid)** 下有几个面板：

| 面板 | 内容 |
| --- | --- |
| **连接状态** | 登录态徽标、token 有效期与剩余时间、组织 ID、推理主机、信封密钥来源、provider 写入状态、**测试连接**按钮 |
| **账号切换** | 保存多个 Factory 登录态快照、一键切换、按账号查额度、添加/删除账号 |
| **订阅额度** | 标准池与 Core 池的 5h/周/月 进度条、重置时间、超额策略、Extra Usage 余额 |
| **路由与模型** | 三条路由的开关 + 每路由模型表（勾选 / ID / 名称 / 倍率 / 思考档位） |
| **配置** | 各项配置可视化编辑 + 模型显示范围 |
| **诊断日志** | 最近 10 条转发记录（时间 / 路由 / 模型 / 事件 / 上游状态 / 耗时） |

页面每 60 秒自动刷新状态与额度（编辑中的配置不会被轮询覆盖）。

---

## API key 模式（测试版）

不想装 droid CLI、不想碰系统钥匙串，就用这个模式：**去 [Factory 的 API Keys 页面](https://app.factory.ai/settings/api-keys) 建一个 key，粘贴到设置页**，立即生效。

```
设置 → Factory (Droid) → 账号切换 → 粘贴 Factory API key（fk-…）→ 保存 API key
```

**为什么可以这么用**：API key 是「机器身份」凭证（官方设计用途是让 CI/CD、脚本这类没有浏览器的场景也能跑 Droid）。实测它还**可以直接作为推理凭据**——用同一个 key 请求推理主机返回 200，查额度返回的也是同一份订阅窗口（5h/周/月 百分比与 droid 登录态完全一致）。

> ⚠️ 这是**官方文档未记载**的用法（官方 API 文档里 key 只用于 `api.factory.ai` 那套管理端点）。能用，但 Factory 随时可能调整，风险自负。

**对比 droid CLI 登录态**：

| | droid CLI 登录态 | API key |
| --- | --- | --- |
| 有效期 | 24 小时，自动续期 | **不过期** |
| 读取方式 | 解密信封 + 系统钥匙串 | 直接读存下来的字符串 |
| Windows / Linux | 依赖凭据管理器 / Secret Service（**未在真机验证**） | **不依赖任何系统组件** |
| 安装要求 | 必须装 droid CLI 并登录 | 不需要 |
| 一个凭据对应 | 一个账号 | 一个账号 |

**关于切账号**：一个 key 属于一个 Factory 账号，所以**想切账号就为每个账号各存一个 key**——key 会作为账号条目出现在列表里，和登录快照一样选中即切换。选中的账号**优先于**环境变量 `FACTORY_API_KEY`。

**安全提示**：key 存在 `~/.dsh-factory-provider/accounts/<id>/api-key`，权限 0600（目录 0700）。它是长期有效凭证，泄露等于账号被别人用——不要提交进 git，不要在截图里露出来。

---

## 多账号切换

「账号切换」面板可以把多个 Factory 登录态存在本地，一键决定网关用哪个账号。账号库在 `~/.dsh-factory-provider/accounts/`。

- **保存当前登录态** — 把 droid CLI 当前登录快照进账号库（用 droid 自己的机器级密钥加密，不引入新密钥）。同一身份重复保存是更新而非新建
- **添加账号** — 生成一个独立登录目录，在**终端里运行面板给出的命令**完成官方浏览器 OAuth，账号自动出现在列表。命令已按你的操作系统生成（Windows 有 PowerShell 与 cmd 两种写法）
- **切换** — 选中即生效，无需重启；网关随账号的推理主机自动切换（EU 账号主机不同）
- **按账号查额度** — 每行「额度」按钮直接读该账号的账单端点
- **删除** — 移除快照。⚠️ 删除**正在使用**的账号会让插件**停用凭据**——额度查询与模型调用随即失败，直到你选别的账号或点「切回默认登录」
- **停用** — 显式不使用任何登录

凭据有三种状态，随时互切：**默认登录**（跟随 droid CLI）/ **某个账号** / **停用**。

**边界**：切号**只影响本插件的网关**，终端 droid CLI 和 Factory.app 的登录态完全不动（插件从不写 `~/.factory`）。设置了 `FACTORY_API_KEY` 时 Key 优先，切号不生效。

---

## Windows / Linux 用户必读

插件不依赖任何 macOS 专有机制，三平台都支持——但它需要**读到你机器上的 droid 加密密钥**。不同系统的密钥存放位置不同：

| 事项 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 登录信封文件 | `auth.v2.loginkeychain` | `auth.v2.keyring` | `auth.v2.keyring` |
| 密钥存放 | 登录钥匙串 | **Windows 凭据管理器** | Secret Service |
| droid 位置 | `~/.local/bin`、`/usr/local/bin`、`/opt/homebrew/bin`、`Factory.app` | `%LOCALAPPDATA%\Programs\Factory`、`%APPDATA%\npm`、`%ProgramFiles%\Factory` | `~/.local/bin`、`/usr/local/bin`、`/usr/bin` |

插件按这个顺序找密钥，命中即用：

```
该 home 的 auth.v2.key 文件
  → 默认 home 的 auth.v2.key（快照 home 共用机器密钥）
  → 环境变量 FACTORY_AUTH_KEY（base64）
  → 环境变量 FACTORY_AUTH_KEY_COMMAND（自定义取密钥命令，stdout 即密钥）
  → 系统钥匙环（macOS 钥匙串 / Windows 凭据管理器 / Linux Secret Service）
```

**如果设置页显示「未检测到登录态」但你确实登录了**，说明密钥没读到。面板会直接列出**每一项尝试的结果**（如 `windows-credential-manager:absent`）并给出针对你系统的补救方法。三条出路：

1. **改用 [API key 模式](#api-key-模式测试版)**（推荐，最省事：不依赖任何系统组件）
2. **设置 `FACTORY_AUTH_KEY`** 为 base64 密钥
3. **用 `FACTORY_DISABLE_KEYRING=1` 重新登录一次 droid** —— 这会让 droid 把密钥改存到 `auth.v2.key` 文件，插件直接读文件
4. **用 `FACTORY_AUTH_KEY_COMMAND`** 接上你自己的取密钥方式

> **诚实说明**：Windows 凭据管理器与 Linux Secret Service 的读取路径**尚未在真机验证过**（开发机是 macOS）。如果你在 Windows/Linux 上跑通了或遇到问题，欢迎提 issue 告诉我结果——设置页「连接状态」里的**信封密钥来源**字段会显示实际命中的来源，把这个值发出来就够定位了。

---

## 配置项

`cordis.patch.yml` 里是出厂默认值；**设置页的修改优先**且写入插件自己的 settings 命名空间。两边字段一致：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后只保留诊断路由，并清理已写入的 provider |
| `routes` | `["generic","anthropic","openai"]` | 启用哪几条路由 |
| `cliVersion` | `"0.231.0"` | 网关呈现给 Factory 的 CLI 版本（UA），跟随你装的 droid 版本 |
| `apiBaseURL` | `"https://prem.factory.ai"` | 推理主机（账号的 `whoami.premBaseHostV2` 会覆盖它，EU 账号不同） |
| `quotaHost` | `"https://api.factory.ai"` | 额度端点主机 |
| `keyEnv` | `"FACTORY_API_KEY"` | 长效 API key 的环境变量名，同时读 DSH 凭据存储。实测与 droid 登录态**扣同一份订阅额度**（官方文档未记载此用法） |
| `refreshWindowMinutes` | `15` | access token 到期前多久主动刷新 |
| `proactiveRefreshMinutes` | `5` | 定时刷新周期；`0` 关闭定时器 |
| `modelAllowlist` | `[]` | 模型显示范围：`[]` = 全部；非空则只显示列出的模型（建议在设置页勾选，不要手填） |

---

## 常见问题

**Q：会消耗我的 Factory 额度吗？**

会。`factory-g` 走 **Core 免费池**（有自己的限额，不占标准额度），`factory-a` / `factory-o` 走**标准订阅额度**。设置页「订阅额度」可实时看用量。

**Q：插件会读走或上传我的凭据吗？**

不会上传到任何第三方。凭据只在**本机**用于向 Factory 发起你主动触发的请求，网关**只接受本机回环调用**（即使 DSH 绑了 `0.0.0.0` 供局域网访问，外部调用也会被拒绝）。诊断日志 `journal.jsonl` 只记录请求形态和上游状态码，**不含 token 和完整请求体**。

**Q：会改动我的 droid CLI 登录吗？**

不会。插件**从不写 `~/.factory`**。唯一的例外是它会在你切换到的**账号快照目录**里回写刷新后的 token（保持快照可用），与你 CLI 的登录互不污染。

**Q：模型列表怎么这么长 / 有些模型用不了？**

用设置页「路由与模型」勾选精简（见[第 5 步](#第-5-步按需精简模型列表)）。部分模型有地区门禁，已被剔除。模型清单是对着账号**实弹探测**整理的——只有真实返回 200 的才收录。

**Q：保存勾选后 DSH 模型列表没更新？**

这是已知问题：配置已正确写入，但运行中的模型目录不会立刻重建。**重启 DSH 后即可看到新列表**。

**Q：DSH 提示「API 密钥无效」怎么办？**

先看设置页「连接状态」的徽标，再点「测试连接」看真实上游响应。若徽标是「未检测到登录态」，多半是**密钥没读到**（见 [Windows / Linux 用户必读](#windows--linux-用户必读)）。

**Q：改了插件源码，为什么没生效？**

插件用 `link:` 安装，但 DSH 只在**启动时**加载模块。改完代码需要**重启 DSH**。

---

## 工作原理

给想深入了解的读者：

- **凭据** — 读取 droid CLI 的加密信封（AES-256-GCM，`iv:tag:ciphertext` base64），access token 过期时走 WorkOS refresh 并**原子回写**同一信封（临时文件 + rename），droid 本身继续可用
- **请求重写** — 注入完整的 `factory-cli` 头集合（UA / `X-Factory-Client` / `x-stainless-*` / `traceparent` / `x-api-provider`）、补齐 droid 身份 system 行（边缘硬门槛）、剥离未知字段；客户端 attribution 头一律不透传
- **会话亲和** — `x-session-id` 按（组织 × 模型 × system 提示 × 首条用户消息）哈希派生，同一会话每轮相同，对齐官方 CLI 的会话级 id，避免打散 Factory 侧的前缀缓存（实测 20K+ token 会话命中率约 85%）
- **协议适配** — 三条路由分别处理 Anthropic Messages、OpenAI chat/completions、OpenAI responses 三种协议，SSE 流式原样透传；上游 401 会触发一次强制刷新 + 重试
- **诊断** — `journal.jsonl` 记录每次转发的请求形态与上游状态；`handler-error` 记录转发前就抛出的失败、`apply-error` 记录插件加载崩溃（这两类失败原本会被宿主静默吞掉）

---

## 开发

```sh
node test/run.mjs     # 77 项离线测试，不需要网络、不需要 droid CLI
```

测试覆盖：凭据加解密与 WorkOS 刷新闭环、账号库、**三平台矩阵**（Windows/Linux 的路径、登录命令、钥匙环读取）、请求净化规则、模型目录、网关端到端（本地 mock 上游，含 SSE 流式与 401 重试）。

macOS 上如果系统 `git`/`python3` 因 Xcode 许可不可用，可用：

```sh
/Library/Developer/CommandLineTools/usr/bin/git --version
```

## 许可

MIT，见 [LICENSE](LICENSE)。

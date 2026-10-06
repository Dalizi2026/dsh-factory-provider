# 插件市场上架材料（awesome-dsh-plugin）

> 2026-10-05 更新到 **1.3.0**。所有前置条件已满足，随时可提交。

## 要提交的文件

**目标仓库**：`awesome-dsh-plugin/awesome-dsh-plugin`
**文件路径**：`data/plugins/Dalizi2026__dsh-factory-provider.yml`

```yaml
url: https://github.com/Dalizi2026/dsh-factory-provider
name: Dalizi2026/dsh-factory-provider
category: model
tarball: https://github.com/Dalizi2026/dsh-factory-provider/releases/download/v1.3.0/dsh-factory-provider-1.3.0.tgz
description:
  en: Factory (Droid) subscription quota as native DSH model providers, with three protocol routes, your own API key through a loopback gateway, and a settings page for connection status, quota, per-model token statistics and key switching.
  zh: 把 Factory (Droid) 订阅额度接入 DSH 的原生模型 provider：三条协议路由、用你自己的 API key 经本机回环网关认证，并提供设置页查看连接状态、订阅额度、按模型的 token 统计与切换 key。
```

**就这一个文件，不要改那两个 README** —— 它们由 `data/plugins/*.yml` 生成，手改会冲突。

## 前置条件自查（全部满足）

| 要求 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle` | ✅ `{"patch": "./cordis.patch.yml"}` |
| `cordis.patch.yml` 存在 | ✅ 仓库根目录 |
| `repository` 指向真实仓库 | ✅ `Dalizi2026/dsh-factory-provider` |
| 官方包用 `peerDependencies` | ✅ `@deepseek-ai/schemastery: ^3.18.2`（宿主实际提供 3.18.4）|
| 仓库带 `dsh-plugin` topic | ✅ 已加 |
| 真实可用代码 | ✅ 18 个 lib 模块 + 235 项测试 |
| 仓库创建满 1 天 | ✅ 创建于 2026-10-02T17:43:37Z |
| 描述不带营销词、可对着代码核对 | ✅ 见上，每条都能在代码里找到 |
| `tarball` 钉住 tag（不用 `latest/download/`）| ✅ 钉在 v1.3.0 |
| 目录里没有重复条目 | ✅ 已确认无 `factory` 相关条目 |

## 执行方式

### 方式 A：网页手动（5 步，推荐）

1. 打开 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 右上角 **Fork**（fork 到你自己的账号）
3. 进 `data/plugins/` → **Add file → Create new file**
4. 文件名填 `Dalizi2026__dsh-factory-provider.yml`，内容粘上面的 YAML
5. **Commit changes** → 回到原仓库 → **Contribute → Open pull request**

**注意**：文件名必须是 `<owner>__<repo>.yml`（**两个下划线**），拼错会被 CI 拒。

### 方式 B：全自动（GitHub API，需要 token）

需要细粒度 token，权限：**Contents: Read and write** + **Pull requests: Read and write**，目标仓库 `awesome-dsh-plugin/awesome-dsh-plugin`。

三步：

1. `POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/forks` —— 建 fork
   （**异步**，要轮询等它就绪，否则下一步 404）
2. `PUT /repos/<你>/awesome-dsh-plugin/contents/data/plugins/Dalizi2026__dsh-factory-provider.yml`
   —— body 里带 `message` 和 base64 编码的 `content`
3. `POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls`
   —— `{title, head: "<你>:main", base: "main", body}`

## 规则要点（摘自官方 contributing.md，2026-10-05 核对）

- **一个 PR 最多 3 条**，我们只交 1 条
- 只有 `description.en` 必填，`zh` 可选
- 描述里含 `: `（冒号加空格）**必须加引号**，否则 YAML 解析失败
- `tarball` 必须是 GitHub Release 托管的 `https` `.tgz`
  - ⚠️ `latest/download/` 只在请求时解析 `latest`，**文件名照字面取** —— 资产名带版本号的话，下次发版就 404
  - 要么资产名不带版本号，要么**钉住 tag**（我们选后者）
- `category` 取值之一：`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`
- **CI 通过只是前置条件**，维护者会实际读代码核对描述
- **描述夸大是主要打回原因** —— 提到某个命令或数字，代码里就得真有
- 分类选不准不会被打回，维护者直接改

## 评审会看什么

1. 代码是否与条目声明一致（含描述里的数字与 API 名称）
2. 分类是否合理（不会因此被打回）
3. 是否真实可用的代码，而非占位或空壳
4. 是否已被现有条目覆盖
5. 源码有无可疑之处（混淆、凭据外传、异常安装期行为）
6. PR 是否动了无关条目
7. 是否纯聚合包（只有依赖清单、自己不带行为）
8. 依赖是否指向原作者

## 市场是怎么运作的

```
dsh-market（DSH 界面里的插件市场）
      ↓ 读 https://dshmarket.com 的 plugins.json
awesome-dsh-plugin/awesome-dsh-plugin（真正的目录，1000+ 插件）
      ↑ 上架 = 往 data/plugins/ 交一个 YAML
```

- `dsh-market/dsh-market` 仓库**只是市场应用本身，不是目录** —— 官方明确要求不要往那里提插件
- 市场安装**只允许 registry 里列出的来源**，其他一律拒绝 → 所以必须上这个列表
- 合并后网站自动重建，**一天内**出现在市场里

## 提交前再核对一遍

```sh
# 仓库年龄（必须 ≥24 小时）
curl -s https://api.github.com/repos/Dalizi2026/dsh-factory-provider | grep created_at

# topic 还在吗
curl -s https://api.github.com/repos/Dalizi2026/dsh-factory-provider | grep -o '"topics":\[[^]]*\]'

# tarball 链接有效（应 200）
curl -sIL -o /dev/null -w '%{http_code}\n' \
  https://github.com/Dalizi2026/dsh-factory-provider/releases/download/v1.3.0/dsh-factory-provider-1.3.0.tgz

# 目录里有没有重复条目
curl -s https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/data/plugins | grep -i factory
```

## 发新版本时要更新什么

条目里的 `tarball` 钉在 tag 上 → **每次发版都要提一个 PR 改这一行**，否则用户装到的还是旧版。

只改自己的条目，不要碰别人的，也不要手改 README。

## 可选：发布到 npm

不是必须的，但**发布后安装体验更好** —— 预构建安装可以跳过 `allowBuilds` 构建授权那一步。

包名 `dsh-factory-provider` 目前可用（未占用）。

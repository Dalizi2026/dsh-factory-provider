# 插件市场上架材料（awesome-dsh-plugin）

> 2026-10-03 准备。仓库满 1 天后（**2026-10-04 01:43 本地时间**）执行提交。

## 状态：万事俱备，只等仓库满 1 天

| CI 门槛 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle` | ✅ 有（最常见被拒原因，我们没问题） |
| `repository` 指向真实仓库 | ✅ 1.0.3 已修（原来指向不存在的 `dsh-factory/...`） |
| 官方依赖用 `peerDependencies` | ✅ 1.0.3 已修（`@deepseek-ai/schemastery: ^3.18.2`） |
| 仓库带 `dsh-plugin` topic | ✅ 已加 |
| 真实可用代码 | ✅ 65 项测试，35 个模型实测通过 |
| 仓库创建满 1 天 | ⏳ 创建于 2026-10-02T17:43:37Z → 满于 **2026-10-04 01:43 本地** |
| npm 包（可选） | ⚪ 未发布，名字 `dsh-factory-provider` 可用 |

## 要提交的文件

**仓库**：`awesome-dsh-plugin/awesome-dsh-plugin`
**路径**：`data/plugins/Dalizi2026__dsh-factory-provider.yml`

```yaml
url: https://github.com/Dalizi2026/dsh-factory-provider
name: Dalizi2026/dsh-factory-provider
category: model
tarball: https://github.com/Dalizi2026/dsh-factory-provider/releases/download/v1.1.1/dsh-factory-provider-1.1.1.tgz
description:
  en: Factory (Droid) Pro/Plus/Max subscription as native DSH LLM providers, authenticated with your own Factory API key through a loopback gateway, with a settings page for status, quota and key switching.
  zh: 把 Factory (Droid) 订阅额度接入 DSH 的原生模型 provider，通过本机回环网关用你自己的 Factory API key 认证，并提供设置页查看状态、额度和切换 key。
```

### 规则要点（来自官方 contributing.md）

- **只加这一个文件**。那个仓库的两个 README 由 `data/plugins/*.yml` 生成，手改会冲突。
- **一个 PR 最多 3 条**，我们只交 1 条。
- 只有 `description.en` 必填，中文可留给维护者补。
- 描述**不能有营销词**，且会被**逐句对着代码核对**。
- `category` 取值：`model` 对应「Models & Providers」。分类选不准维护者会自己改，不会打回。
- **`tarball` 必须钉住 tag**（不能写 `latest/download/` + 带版本号的文件名）——规则明确警告：`latest` 只在请求时解析，文件名是照字面取的，下次发版就 404。
- 合并后**一天内**自动出现在 dsh-market 插件市场里。

## 执行方式（两种，任选）

### 方式 A：全自动（需要 GitHub token）

用 GitHub API 三步完成，不需要 clone：

1. `POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/forks` — 在你账号下建 fork
2. `PUT /repos/Dalizi2026/awesome-dsh-plugin/contents/data/plugins/Dalizi2026__dsh-factory-provider.yml`
   — 带 base64 内容提交到 fork 的默认分支
3. `POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls`
   — `{title, head: "Dalizi2026:main", base: "main", body}`

**注意**：`PUT contents` 需要 fork 已就绪（建 fork 是异步的，要等几秒并轮询确认）。

### 方式 B：手动（网页，5 步）

1. 打开 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 右上角 **Fork**
3. 进 `data/plugins/` → **Add file → Create new file**
4. 文件名 `Dalizi2026__dsh-factory-provider.yml`，粘上面的内容
5. **Commit** → **Contribute → Open pull request**

## 提交前要重新核对的（防止中间有变）

```sh
# 仓库年龄（必须 ≥24 小时）
curl -s https://api.github.com/repos/Dalizi2026/dsh-factory-provider | grep created_at

# topic 还在吗
curl -s https://api.github.com/repos/Dalizi2026/dsh-factory-provider | grep -o '"topics":\[[^]]*\]'

# tarball 链接是否有效（应 302 到实际文件）
curl -sIL -o /dev/null -w '%{http_code}\n' \
  https://github.com/Dalizi2026/dsh-factory-provider/releases/download/v1.1.1/dsh-factory-provider-1.1.1.tgz

# 目录里是否已有人提交过同名条目（避免重复）
curl -s https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/data/plugins | grep -i factory
```

## 需要的凭据

**明天需要一个有效的 GitHub token**（`repo` 或细粒度 Contents+PR 写权限）。
今天那个已在对话里明文出现，用户会吊销 → 明天要新的。

推荐方式：让用户写进文件，避免再进对话记录

```sh
printf '%s' '<TOKEN>' > /tmp/gh-token.txt && chmod 600 /tmp/gh-token.txt
```

## 背景：市场是怎么运作的（调查结论）

```
dsh-market（用户界面里的插件市场，用户已装）
      ↓ 读 https://dshmarket.com 的 plugins.json
awesome-dsh-plugin/awesome-dsh-plugin（真正的目录，1550+ 插件）
      ↑ 上架 = 往 data/plugins/ 交一个 YAML
```

- dsh-market 仓库（`dsh-market/dsh-market`）**只是市场应用本身，不是目录** —— 官方明确要求「不要往这个仓库提插件条目」。
- 另有第三方目录 [DSH Get](https://www.dshget.com/)，其快照公开在 `bobby-sheng/dshget-data`。
- 市场安装**只允许 registry 里列出的来源**，其他一律拒绝 → 所以必须上这个列表。

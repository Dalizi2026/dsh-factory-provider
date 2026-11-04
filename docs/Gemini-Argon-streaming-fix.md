# Gemini 4 Argon 长工具参数修复

日期：2026-11-04。插件版本 1.4.2，基于 huangzhenhao90 的 [PR #4](https://github.com/Dalizi2026/dsh-factory-provider/pull/4)、提交 `7a4785b57dee9aa463845b4c5d7630a1cd2cff47`；保留贡献说明，未合并或操作远程 PR。

## 之前是否修过

未修。此前已有流式传输、超时、取消及错误诊断，但没有 `streamFunctionCallArguments` 开关，也没有 `partialArgs` / `willContinue` 重组逻辑。只等待完整参数时，上游可能长时间没有数据，表现为等待响应头失败或宿主空闲超时。这个修复不能证明所有网络 fetch failed 都由同一原因导致。

## 修改与依据

按 [Google 官方参数流式传输协议](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/function-calling#streaming_function_call_arguments)，仅 Argon 请求声明工具时默认开启参数分段传输，保留显式 false、mode NONE、思考与输出限制。每次工具调用的字符串、对象、数组片段收齐后，才向 DSH 交付一个完整调用，保留调用 ID 和签名；中断、异常路径或不完整参数使本次流失败，不交付半截调用。

参数持续到达时，将不产生可见文字的空文本进度传到宿主事件计时器。未延长超时值或创建独立心跳；若上游真正停止返回数据，仍应按原有规则超时并取消。

## 独立验证

修复前，在当前代码上运行两个集成案例失败：一条完整工具调用被分段解析为三次调用，且进度未传递到宿主。修复后同样案例通过。

移植作者的 11 项测试，并新增三项：官方文档中只有 jsonPath 的字符串结束片段；真实宿主对真正静默流仍报 TIMEOUT，且不输出工具调用；约 170 KB UTF-8 参数经过完整网关与原生传输后只输出一次、参数与签名完整。

DSH rc.5 和 rc.3 全量回归各 330 项通过，0 失败、0 跳过，包含完整临时 Web profile 的启动、保存、启停和重启。使用本地模拟响应及离线测试凭据，没有真实模型调用。保留其他渠道及现有设置，随后按用户授权完成本机安装与桌面重启验证，更新发布说明。

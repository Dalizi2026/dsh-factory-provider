// dsh-factory-provider — Web settings card (browser half).
//
// Registers a "Factory (Droid)" entry into the settings left-nav via the
// `settings.section` list slot and renders five panels: connection status,
// subscription quota, token statistics, routes & models, editable config, and the request
// journal. All data flows through the plugin's own loopback bridge routes
// (/api/dsh-factory-provider/*), which the host half registers.

window.__ModuleLoader__.load({
  id: "dsh-factory-provider",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require("react");

    const NS = "settings.dsh-factory-provider";
    const BRIDGE = "/api/dsh-factory-provider";
    const POLL_MS = 60_000;

    // --- i18n -------------------------------------------------------------------
    const zh = {
      nav: "Factory (Droid)",
      title: "Factory (Droid) 订阅接入",
      connApiKey: "API key",
      connNone: "未配置 API key",
      connNoneHint: "在下方粘贴一个 Factory API key 即可，无需 droid CLI。",
      connDisabled: "已停用",
      connAnnounced: "已触发模型目录重建",
      connAnnounceFailed: "目录未重建（需重启）",
      connTitle: "连接状态",
      connTest: "测试连接",
      connTesting: "测试中…",
      connRefresh: "刷新",
      quotaTitle: "订阅额度",
      tokenStatsTitle: "Token 统计",
      tokenStatsToday: "今天",
      tokenStats24h: "24 小时内",
      tokenStats7d: "7 天",
      tokenStats30d: "30 天",
      tokenStatsAll: "总计",
      tokenStatsRange: "统计时间",
      tokenStatsModel: "模型",
      tokenStatsInput: "输入 token",
      tokenStatsOutput: "输出 token",
      tokenStatsRead: "缓存读取",
      tokenStatsWrite: "缓存写入",
      tokenStatsTotal: "总计 token",
      tokenStatsEmpty: "该时间范围内暂无 token 记录",
      tokenStatsHint: "输入不含缓存；总计为输入、输出、缓存读取和缓存写入之和。未报告的字段显示 —，只累计已知数值。",
      tokenStatsCoverage: "仅统计经过本插件的请求；启用前补入的现存日志可能不完整。",
      tokenStatsPartial: "部分请求的字段未被上游报告，显示的是已知数值合计。",
      tokenStatsUnavailable: "Token 统计暂时无法读取",
      quotaStandard: "标准池（所有模型先扣，Core 模型也走这里）",
      quotaCore: "Core 池（标准耗尽后的免费溢出）",
      quota5h: "5 小时",
      quotaWeekly: "周",
      quotaMonthly: "月",
      quotaReset: "重置",
      quotaOverage: "超额策略",
      quotaExtra: "Extra Usage",
      quotaExtraOn: "已开启",
      quotaExtraOff: "未开启",
      modelsTitle: "模型",
      advancedTitle: "高级（配置与日志）",
      routesGeneric: "Droid Core（低倍率）",
      routesAnthropic: "Claude",
      routesOpenAI: "GPT",
      routesModels: "{n} 个模型",
      routesEfforts: "思考档位",
      routesCost: "倍率",
      routesFreeHint: "标准池先扣（Core 模型按低倍率也扣这里）→ 耗尽后免费落 Core 池 → 再往后 Extra Usage。",
      configTitle: "配置",
      sectionConnection: "连接",
      sectionCache: "缓存",
      contextCardTitle: "上下文与压缩",
      sectionRequests: "请求保护",
      sectionOther: "其它",
      configCliVersion: "factory-cli 版本号（UA）",
      configApiBase: "推理主机地址",
      configKeyEnv: "API Key 环境变量名",
      configCacheMode: "Anthropic 缓存",
      configCacheTTL: "缓存 TTL",
      configRequestRecovery: "请求过大时自动恢复（413）",
      configAdaptiveImages: "按图片数量和文字大小自动压缩图片",
      imagesActive: "多图压缩已接入",
      imagesWaiting: "多图压缩等待模型服务就绪",
      imagesUnsupported: "当前宿主未接入动态多图压缩，仍使用原生图片保护",
      imagesDisabled: "动态多图压缩已关闭",
      configRequestMaxBytes: "整个请求的本地保护上限（字节）",
      configRequestSizeHint: "保守保护值；超限时先移出旧图，再压缩历史。设 0 关闭。",
      configContextAlignment: "按模型设置上下文与压缩阈值",
      configAlignmentHint: "逐模型阈值可在下方「模型」卡中编辑和保存。",
      configOpusThreshold: "Opus 5.5 压缩阈值（token）",
      configSonnetThreshold: "Sonnet 5.5 压缩阈值（token）",
      configGlmFlashThreshold: "GLM-5.3-Flash 压缩阈值（token）",
      configContextOptimization: "Claude 摘要优化：减少重复压缩和缓存重写",
      configContextHint: "仅用于 Claude 摘要，避免立即重压刚生成的摘要。",
      configSummaryMaxTokens: "压缩摘要输出上限（token）",
      configSummaryModel: "压缩用的模型",
      configSummaryModelDefault: "沿用 DSH 原设置（默认跟随主模型）",
      configSummaryModelHint: "含图需已验证模型；GLM 不可用时沿用 DSH 摘要设置，可能增加额度消耗。",
      configSummaryModelUnavailable: "当前选择不可用，请启用对应路由和模型或重新选择",
      configHeadroomTokens: "摘要及兼容回退安全余量（token）",
      contextActive: "上下文优化已接入",
      contextWaiting: "上下文设置等待 Factory 会话",
      contextUnsupported: "当前 DSH 压缩服务不兼容，正在使用原有策略",
      contextDisabled: "上下文优化已关闭",
      configToolClear: "服务器端清理老工具输出（省输入 token，但模型会忘记早期工具结果）",
      configToolClearHint:
        "按批清理，两批之间固定范围以复用缓存；建议先保存重要结论。清理时仍可能重写缓存，不减少上传体积。",
      configToolClearKeep: "至少保留最近几个工具结果",
      configToolClearTrigger: "低于此输入量不清理",
      configToolClearBatchTokens: "分批清理量（token；0 使用原策略）",
      configQuotaFloat: "显示额度悬浮窗（可拖动、双击折叠）",
      floatTitle: "Factory 额度",
      floatFiveHour: "5 小时",
      floatWeekly: "本周",
      floatMonthly: "本月",
      floatRefresh: "立即刷新",
      floatUpdated: "更新于",
      floatCollapse: "折叠",
      floatClose: "关闭（本次会话内隐藏，重新开关设置可恢复）",
      floatExpand: "双击展开",
      floatLoading: "加载中…",
      configCacheHint:
        "auto 客户端有标记就不插手；rewrite 由插件接管位置；passthrough 完全不改（诊断用）。",
      configProactive: "定时刷新周期（分钟，0 = 关闭）",
      configAllowlist: "模型显示范围（在上方「路由与模型」勾选，可就地保存）",
      modelSelectAll: "全选",
      modelClearAll: "清空",
      modelSelectedCount: "已勾选 {n} 个模型",
      modelThresholdTitle: "压缩阈值",
      modelThresholdPick: "选择模型",
      modelThresholdLabel: "开始压缩的 token 数",
      modelThresholdDefault: "推荐 {n}",
      modelThresholdLimit: "可保存上限 {n}",
      modelThresholdReset: "恢复默认",
      modelThresholdHint: "保存后生效；小窗口和较高思考档位会自动收紧。",
      modelThresholdSmall: "Factory 此渠道窗口较小，请以本页上限为准。",
      modelThresholdEffort: "此模型会按思考档位进一步收紧阈值。",
      modelThresholdDisabled: "开启「按模型设置上下文与压缩阈值」后生效。",
      modelThresholdBudget: "查看上下文预算",
      modelThresholdWindow: "Factory 窗口",
      modelThresholdInput: "输入预算",
      modelThresholdOutput: "输出上限",
      modelThresholdNative: "原厂标称窗口",
      modelThresholdInvalid: "请输入范围内的整数 token 数。",
      modelThresholdDroid: "Droid 默认",
      modelThresholdAdapted: "参考原厂规则",
      modelThresholdDSH: "DSH 通用规则",
      modelThresholdSelected: "保留现有设置",
      configSaveFailed: "保存失败，请检查数值后重试。",
      modelEmptyHint: "未勾选任何模型 = 显示全部；勾选后只保留勾选的模型。",
      configReloadHint: "「定时刷新周期」改动在下次重启后生效，其余即时生效。",
      configSave: "保存",
      configSaving: "保存中…",
      configDiscard: "放弃",
      configSaved: "✓ 已保存",
      journalTitle: "诊断日志",
      journalEmpty: "暂无记录",
      journalHint: "每次转发的请求形态与上游状态；完整日志在插件目录 journal.jsonl。",
      statusOk: "正常",
      statusFail: "失败",
      loading: "加载中…",
      loadFailed: "加载失败",
      modelCol: "模型",
      acctTitle: "API key",
      acctHint: "只用 API key：粘贴即用，可存多个切换。删除正在使用的 key 会停用凭据。",
      acctKeyShort: "key 只存本机（0600），不进设置文件与日志。",
      acctLabelPlaceholder: "备注名（可选）",
      acctKeyPlaceholder: "粘贴 Factory API key（fk-…）",
      acctSaveKey: "保存并使用",
      acctKeyHint: "key 只存在本机（权限 0600），不会写进设置文件，也不会出现在日志里。",
      acctModeOff: "已停用——不使用任何凭据，额度查询与模型调用都会失败",
      acctDisable: "停用",
      acctEnable: "启用",
      acctLegacyHint: "这是旧版本用 droid CLI 登录态建的快照，本版本不再读取，可以直接删除。",
      acctEmpty: "还没有保存任何 API key。在下面粘贴一个即可开始使用。",
      acctSelect: "选择",
      acctSelected: "已选择",
      acctQuotaBtn: "额度",
      acctDelete: "删除",
      acctConfirmDelete: "删除这个 API key？删除正在使用的 key 会停用凭据，额度查询和模型调用都会失败，直到你选择其它 key。",
      acctQuotaShort: "5h {a}% · 周 {b}% · 月 {c}%",
      acctFail: "操作失败",
    };
    const en = {
      nav: "Factory (Droid)",
      title: "Factory (Droid) subscription",
      connApiKey: "API key",
      connNone: "No API key configured",
      connNoneHint: "Paste a Factory API key below — no droid CLI needed.",
      connDisabled: "off",
      connAnnounced: "model catalog refreshed",
      connAnnounceFailed: "catalog needs a restart",
      connTitle: "Connection",
      connTest: "Test connection",
      connTesting: "Testing…",
      connRefresh: "Refresh",
      quotaTitle: "Subscription quota",
      tokenStatsTitle: "Token statistics",
      tokenStatsToday: "Today",
      tokenStats24h: "Last 24 hours",
      tokenStats7d: "Last 7 days",
      tokenStats30d: "Last 30 days",
      tokenStatsAll: "All time",
      tokenStatsRange: "Time range",
      tokenStatsModel: "Model",
      tokenStatsInput: "Input tokens",
      tokenStatsOutput: "Output tokens",
      tokenStatsRead: "Cache read",
      tokenStatsWrite: "Cache write",
      tokenStatsTotal: "Total tokens",
      tokenStatsEmpty: "No token records in this time range",
      tokenStatsHint: "Input excludes cache. Total sums input, output, cache read and cache write. Unreported fields show —; only reported values are added.",
      tokenStatsCoverage: "Only requests through this plugin are counted. Imported older diagnostics may be incomplete.",
      tokenStatsPartial: "Some requests have unreported fields; the values shown sum the reported counters.",
      tokenStatsUnavailable: "Token statistics are temporarily unavailable",
      quotaStandard: "Standard pool (everything bills here first)",
      quotaCore: "Core pool (free overflow after standard runs out)",
      quota5h: "5-hour",
      quotaWeekly: "Weekly",
      quotaMonthly: "Monthly",
      quotaReset: "resets",
      quotaOverage: "Overage",
      quotaExtra: "Extra Usage",
      quotaExtraOn: "enabled",
      quotaExtraOff: "off",
      modelsTitle: "Models",
      advancedTitle: "Advanced (config & journal)",
      routesGeneric: "Droid Core (low multiplier)",
      routesAnthropic: "Claude",
      routesOpenAI: "GPT",
      routesModels: "{n} models",
      routesEfforts: "Efforts",
      routesCost: "Cost",
      routesFreeHint: "Standard pool first (Core models too) → free Core pool → Extra Usage.",
      configTitle: "Configuration",
      sectionConnection: "Connection",
      sectionCache: "Cache",
      contextCardTitle: "Context & compaction",
      sectionRequests: "Request protection",
      sectionOther: "Other",
      configCliVersion: "factory-cli version (UA)",
      configApiBase: "Inference host URL",
      configKeyEnv: "API key env var",
      configCacheMode: "Anthropic cache",
      configCacheTTL: "Cache TTL",
      configRequestRecovery: "Recover oversized requests (413)",
      configAdaptiveImages: "Compress images to fit image count and text size",
      imagesActive: "Adaptive image compression connected",
      imagesWaiting: "Adaptive images waiting for model service",
      imagesUnsupported: "Adaptive images unavailable on this host; native image protection remains active",
      imagesDisabled: "Adaptive image compression disabled",
      configRequestMaxBytes: "Local whole-request budget (bytes)",
      configRequestSizeHint: "Conservative budget; on overflow, old images are offloaded first. Set 0 to disable.",
      configContextAlignment: "Use model context budgets and compaction thresholds",
      configAlignmentHint: "Edit and save per-model thresholds in the Models card below.",
      configOpusThreshold: "Opus 5.5 compaction threshold (tokens)",
      configSonnetThreshold: "Sonnet 5.5 compaction threshold (tokens)",
      configGlmFlashThreshold: "GLM-5.3-Flash compaction threshold (tokens)",
      configContextOptimization: "Claude summary optimization",
      configContextHint: "Claude summaries only; avoids recompacting a fresh summary.",
      configSummaryMaxTokens: "Summary output limit (tokens)",
      configSummaryModel: "Compaction model",
      configSummaryModelDefault: "Use DSH settings (main model by default)",
      configSummaryModelHint: "Images need a verified model. If GLM is unavailable, DSH summary settings apply and may cost more.",
      configSummaryModelUnavailable: "Selected model unavailable; enable its route/model or choose again",
      configHeadroomTokens: "Summary / compatibility safety margin (tokens)",
      contextActive: "Context optimization active",
      contextWaiting: "Context settings waiting for a Factory session",
      contextUnsupported: "This DSH compaction service is unsupported; the native policy is in use",
      contextDisabled: "Context optimization disabled",
      configToolClear: "Clear old tool results server-side (saves input tokens; the model forgets early tool output)",
      configToolClearHint:
        "Clear in batches and pin the boundary between batches to reuse cache. Save important conclusions first. Clearing can still rewrite cache and does not reduce upload size.",
      configToolClearKeep: "Keep at least this many recent tool results",
      configToolClearTrigger: "Do not clear below this input size",
      configToolClearBatchTokens: "Clearing batch (tokens; 0 uses original policy)",
      configQuotaFloat: "Show a draggable quota window (double-click to collapse)",
      floatTitle: "Factory quota",
      floatFiveHour: "5 hours",
      floatWeekly: "This week",
      floatMonthly: "This month",
      floatRefresh: "Refresh now",
      floatUpdated: "updated",
      floatCollapse: "Collapse",
      floatClose: "Close (hidden for this session; toggle the setting to restore)",
      floatExpand: "Double-click to expand",
      floatLoading: "Loading…",
      configCacheHint:
        "auto leaves a client's own markers alone; rewrite takes over placement; passthrough changes nothing.",
      configProactive: "Refresh interval (minutes, 0 = off)",
      configAllowlist: "Model visibility (tick models in Routes & models above)",
      modelSelectAll: "Select all",
      modelClearAll: "Clear",
      modelSelectedCount: "{n} models selected",
      modelThresholdTitle: "Compaction threshold",
      modelThresholdPick: "Choose a model",
      modelThresholdLabel: "Compact at this token count",
      modelThresholdDefault: "Recommended {n}",
      modelThresholdLimit: "Save up to {n}",
      modelThresholdReset: "Restore default",
      modelThresholdHint: "Applies after saving. Smaller windows and higher effort can lower the effective threshold.",
      modelThresholdSmall: "This Factory channel has a smaller window. Use the limit shown here.",
      modelThresholdEffort: "The effective threshold also depends on reasoning effort.",
      modelThresholdDisabled: "Enable per-model context budgets to apply these settings.",
      modelThresholdBudget: "View context budgets",
      modelThresholdWindow: "Factory window",
      modelThresholdInput: "Input budget",
      modelThresholdOutput: "Output limit",
      modelThresholdNative: "Native advertised window",
      modelThresholdInvalid: "Enter a whole token count within the allowed range.",
      modelThresholdDroid: "Droid default",
      modelThresholdAdapted: "Adapted vendor rule",
      modelThresholdDSH: "DSH general rule",
      modelThresholdSelected: "Existing setting",
      configSaveFailed: "Could not save. Check the values and try again.",
      modelEmptyHint: "No selection shows every model; tick some to keep only those.",
      configReloadHint: "The refresh interval applies after the next restart; everything else applies immediately.",
      configSave: "Save",
      configSaving: "Saving…",
      configDiscard: "Discard",
      configSaved: "✓ Saved",
      journalTitle: "Diagnostics",
      journalEmpty: "No entries yet",
      journalHint: "One line per forwarded call: shape and upstream status; full log in the plugin's journal.jsonl.",
      statusOk: "ok",
      statusFail: "failed",
      loading: "Loading…",
      loadFailed: "Load failed",
      modelCol: "Model",
      acctTitle: "API keys",
      acctHint: "API keys only: paste one and it works; save several to switch. Deleting the key in use stops credential serving.",
      acctKeyShort: "Stored on this machine only (0600); never in the settings file or the journal.",
      acctLabelPlaceholder: "Label (optional)",
      acctKeyPlaceholder: "Paste a Factory API key (fk-…)",
      acctSaveKey: "Save and use",
      acctKeyHint: "A key is stored on this machine only (mode 0600), never in the settings file and never in the journal.",
      acctModeOff: "off — no credential is used, so quota reads and model calls fail",
      acctDisable: "Turn off",
      acctEnable: "Turn on",
      acctLegacyHint: "A droid CLI login snapshot from an older build. This version does not read it; delete it.",
      acctEmpty: "No API key saved yet. Paste one below to get started.",
      acctSelect: "Select",
      acctSelected: "Selected",
      acctQuotaBtn: "Quota",
      acctDelete: "Delete",
      acctConfirmDelete: "Delete this API key? Deleting the key in use stops credential serving, so quota reads and model calls fail until you pick another key.",
      acctQuotaShort: "5h {a}% · weekly {b}% · monthly {c}%",
      acctFail: "Action failed",
    };

    // --- styles (host CSS variables, light/dark inherited) ----------------------
    const css = [
      ".fp-section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}",
      ".fp-heading{margin:0;font-size:18px;font-weight:600}",
      ".fp-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}",
      ".fp-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;list-style:none;overflow:hidden;margin:0;padding:14px}",
      ".fp-cardTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;margin:0 0 10px}",
      ".fp-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".fp-grid{display:flex;gap:10px;flex-wrap:wrap}",
      // A checkbox dropped straight into a grid would sit beside the previous
      // field; these always start a new row.
      ".fp-grid>.fp-check{flex:1 1 100%}",
      ".fp-modelEditor{margin:4px 0 18px;padding:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base,transparent)}",
      ".fp-modelEditorHead{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}",
      ".fp-modelBadge{font-size:11px;color:var(--dsw-alias-label-secondary);padding:4px 8px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}",
      ".fp-modelEditorGrid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:18px}",
      ".fp-modelEditor .fp-field{min-width:0;gap:8px}.fp-modelEditor .fp-input{box-sizing:border-box;height:38px}",
      ".fp-modelMeta{display:flex;gap:8px 16px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:8px}",
      ".fp-modelWarning{font-size:12px;line-height:1.6;margin:14px 0 0;padding:10px 12px;border-radius:8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-accent,rgba(245,158,11,.08))}",
      ".fp-budgetDetails{margin-top:14px;font-size:12px;color:var(--dsw-alias-label-secondary)}.fp-budgetDetails summary{cursor:pointer}",
      ".fp-budgetGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:12px 0 0}.fp-budgetGrid dt{font-size:11px;color:var(--dsw-alias-label-tertiary)}.fp-budgetGrid dd{margin:4px 0 0;font-variant-numeric:tabular-nums}",
      ".fp-modelEditor .fp-row{flex-wrap:wrap}.fp-modelError{font-size:12px;margin:8px 0 0;color:var(--dsw-alias-label-error,#c2413b)}",
      "@media(max-width:640px){.fp-modelEditorGrid{grid-template-columns:1fr}.fp-modelEditor{padding:14px}.fp-budgetGrid{grid-template-columns:repeat(2,minmax(0,1fr))}.fp-summary{flex-wrap:wrap}.fp-summaryActions{flex-wrap:wrap}}",
      ".fp-field{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 200px}",
      ".fp-label{color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".fp-value{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}",
      ".fp-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}",
      ".fp-ok{color:#7ddb9c;font-size:12px}",
      ".fp-err{color:var(--dsw-alias-state-error-primary);font-size:12px}",
      ".fp-badge{border-radius:999px;padding:1px 8px;font-size:11px;white-space:nowrap;flex:none;background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary)}",
      ".fp-badgeOk{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary)}",
      ".fp-badgeErr{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}",
      ".fp-bar{width:100%;height:6px;flex:0 0 auto;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}",
      ".fp-barFill{height:100%;border-radius:3px;background:var(--dsw-alias-button-info-fill);transition:width .2s}",
      ".fp-btn{font:inherit;cursor:pointer;border-radius:6px;padding:5px 12px;font-size:13px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary)}",
      ".fp-btnPrimary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}",
      ".fp-btn:disabled{opacity:.5;cursor:default}",
      ".fp-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 8px;font:inherit;font-size:13px;width:100%}",
      ".fp-check{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--dsw-alias-label-primary)}",
      ".fp-table{width:100%;border-collapse:collapse;font-size:12px}",
      ".fp-tokenTable{width:100%;table-layout:auto}",
      ".fp-tokenTable .fp-th:not(:first-child),.fp-tokenTable .fp-td:not(:first-child){text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}",
      ".fp-tokenTable .fp-th,.fp-tokenTable .fp-td{padding:4px 6px}",
      ".fp-tokenTable .fp-td:first-child,.fp-tokenTable .fp-th:first-child{padding-left:0;max-width:150px;overflow-wrap:anywhere}",
      ".fp-tokenTable .fp-td:last-child,.fp-tokenTable .fp-th:last-child{padding-right:0}",
      ".fp-tokenToolbar{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}",
      ".fp-tokenToolbar select{width:auto;min-width:145px}",
      ".fp-th{color:var(--dsw-alias-label-tertiary);text-align:left;font-weight:500;padding:4px 8px 4px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".fp-td{color:var(--dsw-alias-label-primary);padding:4px 8px 4px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".fp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}",
      ".fp-keys{display:flex;flex-direction:column;gap:6px;margin-top:10px}",
      ".fp-key{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px 10px}",
      ".fp-keyActive{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-interactive-bg-hover-accent)}",
      ".fp-details{padding:0}",
      ".fp-summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;padding:12px 14px}",
      ".fp-summary::-webkit-details-marker{display:none}",
      ".fp-summary::before{content:\"▸\";color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none;transition:transform .15s}",
      ".fp-details[open] .fp-summary::before{transform:rotate(90deg)}",
      ".fp-detailsBody{padding:0 14px 14px}",
      // Cards nested inside a collapsible drop their own chrome: the summary
      // already draws the border and the title.
      ".fp-detailsBody .fp-card{border:0;background:transparent;padding:0;border-radius:0}",
      ".fp-detailsBody .fp-cardTitle{margin-top:12px}",
      ".fp-detailsBody .fp-cardTitle:first-child{margin-top:0}",
      ".fp-summaryActions{margin-left:auto;display:flex;gap:8px;align-items:center}",
      // quota float
      ".fp-sectionHead{flex:1 1 100%;margin-top:6px;padding-top:8px;font-size:11px;font-weight:600;",
      "letter-spacing:0.3px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.07))}",
      ".fp-sectionHead:first-child{margin-top:0;padding-top:0;border-top:none}",
      ".fp-savings{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.08))}",
      // Quota float — gradients, a pulsing status dot and a ring, matching the
      // opencode-go-usage card.
      ".fp-float{position:fixed;z-index:9999;min-width:200px;max-width:340px;overflow:hidden;pointer-events:auto;",
      "background:var(--dsw-alias-bg-overlay,rgba(255,255,255,0.96));",
      "border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.06));border-radius:14px;",
      "box-shadow:0 12px 32px rgba(0,0,0,0.10),0 2px 12px rgba(0,0,0,0.06);",
      "backdrop-filter:blur(12px) saturate(1.2);font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary);",
      "transition:box-shadow 0.2s,transform 0.2s}",
      ".fp-float:hover{box-shadow:0 16px 36px rgba(0,0,0,0.13),0 4px 16px rgba(0,0,0,0.07)}",
      ".fp-float:active{box-shadow:0 20px 40px rgba(0,0,0,0.15)}",
      ".fp-floatHeader{cursor:move;user-select:none;display:flex;align-items:center;justify-content:space-between;",
      "padding:8px 10px;border-bottom:1px solid rgba(0,0,0,0.06);font-size:12px;font-weight:600;letter-spacing:0.2px;",
      "color:#1f2937;background:linear-gradient(180deg,rgba(255,255,255,0.9),rgba(249,250,251,0.9))}",
      ".fp-floatTitle{display:flex;align-items:center;gap:6px}",
      ".fp-floatDot{width:7px;height:7px;border-radius:50%;flex:none;",
      "box-shadow:0 0 0 2px rgba(59,130,246,0.12);transition:background 0.3s,box-shadow 0.3s}",
      ".fp-floatDot[data-status=warn]{box-shadow:0 0 0 2px rgba(245,158,11,0.18)}",
      ".fp-floatDot[data-status=danger]{box-shadow:0 0 0 2px rgba(239,68,68,0.18);animation:fp-pulse 1.5s infinite}",
      ".fp-floatActions{display:flex;gap:2px;align-items:center}",
      ".fp-floatBtn{border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);",
      "border-radius:6px;padding:4px 6px;font-size:11px;line-height:1;transition:transform 0.15s,background 0.15s}",
      ".fp-floatBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.06));transform:translateY(-0.5px)}",
      ".fp-floatBtn:active{transform:translateY(0.5px);background:rgba(0,0,0,0.04)}",
      ".fp-floatBtn:disabled{opacity:0.5;cursor:default;transform:none}",
      ".fp-floatBody{padding:9px 12px 10px;display:flex;flex-direction:column;gap:8px}",
      ".fp-floatRow{display:flex;flex-direction:column;gap:1px}",
      ".fp-floatRowHead{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:10.5px;letter-spacing:0.1px}",
      ".fp-floatRowLabel{color:var(--dsw-alias-label-secondary)}",
      ".fp-floatRowValue{display:flex;align-items:baseline;gap:6px}",
      ".fp-floatReset{font-size:9.5px;color:var(--dsw-alias-label-tertiary,#9ca3af);font-variant-numeric:tabular-nums}",
      ".fp-floatPct{font-variant-numeric:tabular-nums;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".fp-floatTrack{height:6px;background:rgba(0,0,0,0.06);border-radius:999px;overflow:hidden;margin:3px 0 0}",
      ".fp-floatFill{height:100%;border-radius:999px;",
      "transition:width 0.5s cubic-bezier(0.4,0,0.2,1),background 0.3s,box-shadow 0.3s}",
      ".fp-fill-ok{background:linear-gradient(90deg,#60a5fa,#3b82f6);box-shadow:0 1px 4px rgba(59,130,246,0.25)}",
      ".fp-fill-warn{background:linear-gradient(90deg,#fbbf24,#f59e0b);box-shadow:0 1px 4px rgba(245,158,11,0.25)}",
      ".fp-fill-danger{background:linear-gradient(90deg,#f87171,#ef4444);box-shadow:0 1px 4px rgba(239,68,68,0.25)}",
      ".fp-floatMeta{font-size:10px;color:var(--dsw-alias-label-tertiary,#888);display:flex;justify-content:space-between;gap:8px}",
      ".fp-floatUpdated{font-size:10px;color:var(--dsw-alias-label-tertiary,#888);text-align:right;margin-top:2px}",
      ".fp-floatRing{width:72px;height:72px;position:relative;display:inline-flex;align-items:center;justify-content:center;",
      "cursor:move;background:transparent;border:none}",
      ".fp-floatRingSvg{transform:rotate(-90deg)}",
      ".fp-floatRingBg{fill:none;stroke:var(--dsw-alias-border-l2,#e5e7eb);stroke-width:6}",
      ".fp-floatRingFg{fill:none;stroke-width:6;stroke-linecap:round;transition:stroke-dashoffset 0.4s ease,stroke 0.3s}",
      ".fp-floatRingText{position:absolute;display:flex;flex-direction:column;align-items:center;line-height:1}",
      ".fp-floatRingPct{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums}",
      ".fp-floatRingLabel{font-size:9px;color:var(--dsw-alias-label-tertiary,#888)}",
      "@keyframes fp-pulse{0%{box-shadow:0 0 0 2px rgba(239,68,68,0.18)}",
      "50%{box-shadow:0 0 0 4px rgba(239,68,68,0.08)}100%{box-shadow:0 0 0 2px rgba(239,68,68,0.18)}}",
    ].join("");
    const tagId = "dsh-factory-provider/card.css";
    if (typeof document !== "undefined" && !document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`)) {
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-factory-provider";
      style.dataset.pluginCss = tagId;
      style.textContent = css;
      document.head.appendChild(style);
    }

    // --- bridge -----------------------------------------------------------------
    async function bridge(path, options) {
      const res = await fetch(`${BRIDGE}${path}`, options);
      try {
        return await res.json();
      } catch {
        return { ok: false, code: `http-${res.status}`, message: `bridge ${path} returned ${res.status}` };
      }
    }

    function fmtTime(ms) {
      if (typeof ms !== "number" || ms <= 0) return "—";
      return new Date(ms).toLocaleString();
    }
    function fmtRemain(ms) {
      if (typeof ms !== "number" || ms <= 0) return "";
      const minutes = Math.round(ms / 60000);
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.round(minutes / 60);
      if (hours < 48) return `${hours}h`;
      return `${Math.round(hours / 24)}d`;
    }
    function fmtPercent(value) {
      return `${Math.round(Number(value ?? 0))}%`;
    }

    /** A card whose body collapses. The summary keeps the title, a one-line
     *  hint and any actions visible, so the save button stays reachable while
     *  the long tables are folded away. */
    const CARD_OPEN_KEY = "dsh-factory-provider.cardOpen";

    /** Whether a card was left open, as the user last set it. */
    function storedCardOpen(id, fallback) {
      if (id === undefined) return fallback;
      const saved = readStored(CARD_OPEN_KEY, {})[id];
      return typeof saved === "boolean" ? saved : fallback;
    }

    function CollapsibleCard({ id, title, hint, actions, defaultOpen = false, onToggle, children }) {
      const [open, setOpen] = react.useState(() => storedCardOpen(id, defaultOpen));
      const change = (next) => {
        setOpen(next);
        if (id !== undefined) writeStored(CARD_OPEN_KEY, { ...readStored(CARD_OPEN_KEY, {}), [id]: next });
        if (onToggle !== undefined) onToggle(next);
      };
      return react.createElement("details", {
        className: "fp-card fp-details",
        open,
        onToggle: (event) => change(event.currentTarget.open),
      },
        react.createElement("summary", { className: "fp-summary" },
          react.createElement("span", { className: "fp-cardTitle", style: { margin: 0 } }, title),
          hint ? react.createElement("span", { className: "fp-hint" }, hint) : null,
          actions ? react.createElement("span", { className: "fp-summaryActions" }, actions) : null),
        react.createElement("div", { className: "fp-detailsBody" }, children));
    }

    /** Model display name without the route suffix — the section heading above
     *  the table already names the route, so "GLM-5.3 Flash (Droid Core)" is just
     *  "GLM-5.3 Flash" here. */
    function shortModelName(model) {
      const name = String(model?.name ?? model?.id ?? "");
      return name.replace(/\s*\((?:Droid Core|Factory)\)\s*$/, "");
    }

    /** A full-width divider that names the group of settings below it. */
    function SectionHeading({ label }) {
      return react.createElement("div", { className: "fp-sectionHead" },
        react.createElement("span", null, label));
    }

    /** A labelled <select> for the enum config fields. */
    function SelectField({ t, label, value, options, onChange }) {
      return react.createElement("div", { className: "fp-field" },
        react.createElement("span", { className: "fp-label" }, label),
        react.createElement("select", {
          className: "fp-input",
          value,
          onChange: (event) => onChange(event.target.value),
        },
          ...options.map((option) =>
            react.createElement("option", { key: option, value: option }, option))));
    }

    // --- panels ------------------------------------------------------------------

    function ConnectionCard({ t, status, onTest, testing, testResult }) {
      if (status === undefined) return react.createElement("p", { className: "fp-hint" }, t("loading"));
      const credential = status.credential ?? {};
      const source = credential.source ?? "unknown";
      const badge =
        source === "api-key"
          ? { cls: "fp-badge fp-badgeOk", text: t("connApiKey") }
          : source === "disabled"
            ? { cls: "fp-badge fp-badgeErr", text: t("connDisabled") }
            : { cls: "fp-badge fp-badgeErr", text: t("connNone") };
      const reconcile = status.plugin?.reconcile ?? "pending";
      const healthy = reconcile === "applied" || reconcile === "clean";
      // One line of facts, one line of actions. Everything the card used to
      // spell out (expiry, provider-write detail) is either impossible for a
      // key or belongs in a tooltip.
      return react.createElement(CollapsibleCard, {
        id: "connection",
        title: t("connTitle"),
        hint: badge.text,
        defaultOpen: true,
        actions: react.createElement("button", { className: "fp-btn", disabled: testing, onClick: onTest },
          testing ? t("connTesting") : t("connTest")),
      },
        react.createElement("div", { className: "fp-row", style: { justifyContent: "space-between" } },
          react.createElement("div", { className: "fp-row" },
            react.createElement("span", { className: "fp-hint fp-mono" }, status.upstream ?? "—"),
            credential.orgId
              ? react.createElement("span", { className: "fp-hint fp-mono" }, credential.orgId)
              : null,
            react.createElement("span", {
              className: healthy ? "fp-ok" : "fp-err",
              title: status.plugin?.announced === "ok"
                ? t("connAnnounced")
                : status.plugin?.announced === "failed"
                  ? t("connAnnounceFailed")
                  : undefined,
            }, reconcile + (status.plugin?.error ? ` — ${status.plugin.error}` : "")))),
        status.plugin?.contextOptimization?.state
          ? react.createElement("p", {
              className: status.plugin.contextOptimization.state === "unsupported" ? "fp-err" : "fp-hint",
              style: { marginTop: 8 },
            }, t(({ active: "contextActive", waiting: "contextWaiting", unsupported: "contextUnsupported", disabled: "contextDisabled" })[status.plugin.contextOptimization.state] ?? "contextWaiting"))
          : null,
        status.plugin?.adaptiveImages?.state
          ? react.createElement("p", { className: status.plugin.adaptiveImages.state === "unsupported" ? "fp-err" : "fp-hint", style: { marginTop: 8 } },
            t(({ active: "imagesActive", waiting: "imagesWaiting", unsupported: "imagesUnsupported", disabled: "imagesDisabled" })[status.plugin.adaptiveImages.state] ?? "imagesWaiting"))
          : null,
        source !== "api-key"
          ? react.createElement("p", { className: "fp-hint", style: { marginTop: 8 } }, t("connNoneHint"))
          : null,
        testResult
          ? react.createElement("p", { className: testResult.ok ? "fp-ok" : "fp-err", style: { marginTop: 8 } },
              `${testResult.ok ? t("statusOk") : t("statusFail")} · ${testResult.status} · ${testResult.route}/${testResult.model}${testResult.body ? ` · ${testResult.body.slice(0, 120)}` : ""}`)
          : null);
    }

    function QuotaWindow({ t, label, window }) {
      if (window === undefined) return null;
      const percent = Math.max(0, Math.min(100, Number(window.usedPercent ?? 0)));
      const remain = typeof window.secondsRemaining === "number" && window.secondsRemaining > 0
        ? `${t("quotaReset")} ${fmtRemain(window.secondsRemaining * 1000)}`
        : window.windowEnd
          ? `${t("quotaReset")} ${fmtTime(Date.parse(window.windowEnd))}`
          : "—";
      return react.createElement("div", { key: label, className: "fp-field", style: { flex: "1 1 160px" } },
        react.createElement("span", { className: "fp-label" }, `${label} · ${fmtPercent(percent)}`),
        react.createElement("div", { className: "fp-bar" },
          react.createElement("div", { className: "fp-barFill", style: { width: `${percent}%` } })),
        react.createElement("span", { className: "fp-hint" }, remain));
    }

    function QuotaCard({ t, quota, onRefresh, config, patchConfig }) {
      return react.createElement(CollapsibleCard, {
        id: "quota",
        title: t("quotaTitle"),
        defaultOpen: true,
        actions: react.createElement("button", { className: "fp-btn", onClick: onRefresh }, t("connRefresh")),
      },
        quota === undefined
          ? react.createElement("p", { className: "fp-hint" }, t("loading"))
          : quota.ok === false
            ? react.createElement("p", { className: "fp-err" }, `${t("loadFailed")}: ${quota.message ?? quota.code}`)
            : [
                react.createElement("span", { key: "std", className: "fp-label" }, t("quotaStandard")),
                react.createElement("div", { key: "stdRow", className: "fp-grid" },
                  react.createElement(QuotaWindow, { t, label: t("quota5h"), window: quota.value.standard.fiveHour }),
                  react.createElement(QuotaWindow, { t, label: t("quotaWeekly"), window: quota.value.standard.weekly }),
                  react.createElement(QuotaWindow, { t, label: t("quotaMonthly"), window: quota.value.standard.monthly })),
                react.createElement("span", { key: "core", className: "fp-label", style: { marginTop: 6 } }, t("quotaCore")),
                react.createElement("div", { key: "coreRow", className: "fp-grid" },
                  react.createElement(QuotaWindow, { t, label: t("quota5h"), window: quota.value.core.fiveHour }),
                  react.createElement(QuotaWindow, { t, label: t("quotaWeekly"), window: quota.value.core.weekly }),
                  react.createElement(QuotaWindow, { t, label: t("quotaMonthly"), window: quota.value.core.monthly })),
                react.createElement("p", { key: "overage", className: "fp-hint", style: { marginTop: 6 } },
                  `${t("quotaOverage")}: ${quota.value.overagePreference ?? "—"} · ${t("quotaExtra")}: ${quota.value.extraUsageAllowed ? t("quotaExtraOn") : t("quotaExtraOff")} ($${(quota.value.extraUsageBalanceCents / 100).toFixed(2)})`),
              ],
        // The float is a display preference for this quota, so it stays here.
        react.createElement("div", { className: "fp-savings" },
          react.createElement("label", { className: "fp-check" },
            react.createElement("input", {
              type: "checkbox",
              checked: config?.quotaFloat === true,
              onChange: (event) => patchConfig("quotaFloat", event.target.checked),
            }),
            t("configQuotaFloat"))));
    }

    function TokenStatsCard({ t, routes }) {
      const [open, setOpen] = react.useState(false);
      const [range, setRange] = react.useState("today");
      const [result, setResult] = react.useState(undefined);
      const [refresh, setRefresh] = react.useState(0);
      react.useEffect(() => {
        if (!open) return;
        let disposed = false, generation = 0;
        setResult(undefined);
        const load = async () => {
          const current = ++generation;
          try {
            const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const reply = await bridge(`/token-stats?range=${encodeURIComponent(range)}&timeZone=${encodeURIComponent(timeZone)}`);
            if (!disposed && current === generation) setResult(reply);
          } catch {
            if (!disposed && current === generation) setResult({ ok: false });
          }
        };
        void load();
        const timer = window.setInterval(load, POLL_MS);
        return () => { disposed = true; window.clearInterval(timer); };
      }, [open, range, refresh]);
      const names = new Map(Object.values(routes ?? {}).flatMap(route => (route?.models ?? []).map(model => [model.id, shortModelName(model)])));
      const rows = result?.value?.rows ?? [];
      // Six columns have to fit the settings panel, and a token count like
      // 1,296,384 is nine characters on its own. Show a compact form and keep the
      // exact number in the cell's tooltip.
      const compact = (value) => {
        if (typeof value !== "number" || !Number.isFinite(value)) return "—";
        if (value < 10000) return value.toLocaleString();
        for (const [size, suffix] of [[1000000000, "B"], [1000000, "M"], [1000, "K"]]) {
          if (value >= size) {
            const scaled = value / size;
            // Round through a number so 99999 does not print as "100.0K".
            const shown = scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(scaled >= 10 ? 1 : 2));
            return `${shown}${suffix}`;
          }
        }
        return value.toLocaleString();
      };
      const exact = value => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : undefined;
      const columns = [["input", "tokenStatsInput"], ["output", "tokenStatsOutput"], ["read", "tokenStatsRead"], ["write", "tokenStatsWrite"], ["total", "tokenStatsTotal"]];
      return react.createElement(CollapsibleCard, {
        id: "token-stats",
        title: t("tokenStatsTitle"),
        onToggle: setOpen,
      },
          react.createElement("div", { className: "fp-tokenToolbar" },
            react.createElement("label", { className: "fp-label" }, t("tokenStatsRange"),
              react.createElement("select", { className: "fp-input", "aria-label": t("tokenStatsRange"), value: range,
                onChange: event => setRange(event.target.value) },
                ...[["today", "tokenStatsToday"], ["24h", "tokenStats24h"], ["7d", "tokenStats7d"], ["30d", "tokenStats30d"], ["all", "tokenStatsAll"]].map(([value, label]) =>
                  react.createElement("option", { key: value, value }, t(label))))),
            react.createElement("button", { className: "fp-btn", onClick: () => setRefresh(value => value + 1) }, t("connRefresh"))),
          result === undefined ? react.createElement("p", { className: "fp-hint" }, t("loading")) :
            result.ok === false ? react.createElement("p", { className: "fp-err" }, t("tokenStatsUnavailable")) :
              rows.length === 0 ? react.createElement("p", { className: "fp-hint" }, t("tokenStatsEmpty")) :
                react.createElement("div", { style: { overflowX: "auto" } },
                  react.createElement("table", { className: "fp-table fp-tokenTable" },
                    react.createElement("thead", null, react.createElement("tr", null,
                      react.createElement("th", { className: "fp-th", scope: "col" }, t("tokenStatsModel")),
                      ...columns.map(([field, label]) => react.createElement("th", { key: field, className: "fp-th", scope: "col" }, t(label))))),
                    react.createElement("tbody", null, ...rows.map(row => react.createElement("tr", { key: row.model, title: row.partial ? t("tokenStatsPartial") : undefined },
                      react.createElement("td", { className: "fp-td", title: row.model }, names.get(row.model) ?? row.model),
                      ...columns.map(([field]) => react.createElement("td", { key: field, className: "fp-td", title: exact(row[field]) }, compact(row[field])))))))),
          react.createElement("p", { className: "fp-hint", style: { marginTop: 10 } }, t("tokenStatsHint")),
          react.createElement("p", { className: "fp-hint", style: { marginTop: 6 } }, t("tokenStatsCoverage")));
    }

    function AccountsCard({
      t,
      accounts,
      activeId,
      busy,
      error,
      quotaByAccount,
      onAction,
      onQuota,
      addLabel,
      setAddLabel,
      mode,
      addKey,
      setAddKey,
      onSaveKey,
    }) {
      // One chip per key. The chip button carries the state itself ("选择" vs
      // "已选择"), which is why there is no status column and no separate
      // "clear selection": with one button per key, deselecting has no meaning
      // of its own — a key is either the one in use or it is not.
      const chips = (accounts ?? []).map((a) => {
        const isActive = activeId === a.id && mode !== "off";
        const usable = a.state === "ready";
        const quota = quotaByAccount?.[a.id];
        return react.createElement("div", { key: a.id, className: "fp-key" + (isActive ? " fp-keyActive" : "") },
          react.createElement("div", { className: "fp-row", style: { justifyContent: "space-between" } },
            react.createElement("div", { className: "fp-row" },
              react.createElement("span", { className: "fp-value" }, a.label ?? a.id),
              a.keyHint ? react.createElement("span", { className: "fp-hint fp-mono" }, `…${a.keyHint}`) : null),
            react.createElement("div", { className: "fp-row" },
              usable
                ? react.createElement("button", {
                    className: "fp-btn" + (isActive ? " fp-btnPrimary" : ""),
                    disabled: busy || isActive,
                    onClick: () => onAction("switch", a.id),
                  }, isActive ? t("acctSelected") : t("acctSelect"))
                : null,
              usable
                ? react.createElement("button", { className: "fp-btn", disabled: busy, onClick: () => onQuota(a.id) }, t("acctQuotaBtn"))
                : null,
              react.createElement("button", {
                className: "fp-btn",
                disabled: busy,
                onClick: () => { if (window.confirm(t("acctConfirmDelete"))) onAction("delete", a.id); },
              }, t("acctDelete")))),
          a.kind === "legacy"
            ? react.createElement("p", { className: "fp-hint", style: { marginTop: 4 } }, t("acctLegacyHint"))
            : null,
          quota !== undefined
            ? react.createElement("p", { className: quota.ok ? "fp-hint" : "fp-err", style: { marginTop: 4 } },
                quota.ok
                  ? t("acctQuotaShort", {
                      a: Math.round(quota.value?.standard?.fiveHour?.usedPercent ?? 0),
                      b: Math.round(quota.value?.standard?.weekly?.usedPercent ?? 0),
                      c: Math.round(quota.value?.standard?.monthly?.usedPercent ?? 0),
                    })
                  : `${t("acctFail")}: ${quota.message ?? quota.code}`)
            : null);
      });
      return react.createElement(CollapsibleCard, {
        id: "accounts",
        title: t("acctTitle"),
        defaultOpen: true,
        // One switch for "serve credentials at all". There is deliberately no
        // separate "clear selection": with no environment variable set the two
        // would do exactly the same thing, which is what made the old pair of
        // buttons confusing.
        actions: react.createElement("button", {
          className: "fp-btn",
          disabled: busy,
          onClick: () => onAction(mode === "off" ? "clear" : "disable"),
        }, mode === "off" ? t("acctEnable") : t("acctDisable")),
      },
        react.createElement("p", { className: "fp-hint", style: { margin: 0 } }, t("acctHint")),
        mode === "off"
          ? react.createElement("p", { className: "fp-err", style: { marginTop: 6 } }, t("acctModeOff"))
          : null,
        error ? react.createElement("p", { className: "fp-err", style: { margin: 0 } }, `${t("acctFail")}: ${error}`) : null,
        react.createElement("div", { className: "fp-keys" },
          accounts === undefined
            ? react.createElement("p", { className: "fp-hint" }, t("loading"))
            : chips.length === 0
              ? react.createElement("p", { className: "fp-hint" }, t("acctEmpty"))
              : chips),
        react.createElement("div", { className: "fp-row", style: { marginTop: 10 } },
          react.createElement("input", {
            className: "fp-input",
            style: { flex: "1 1 200px" },
            placeholder: t("acctLabelPlaceholder"),
            value: addLabel,
            onChange: (e) => setAddLabel(e.target.value),
          }),
          react.createElement("input", {
            className: "fp-input",
            style: { flex: "2 1 280px" },
            type: "password",
            autoComplete: "off",
            placeholder: t("acctKeyPlaceholder"),
            value: addKey,
            onChange: (e) => setAddKey(e.target.value),
          }),
          react.createElement("button", { className: "fp-btn", disabled: busy || addKey.trim().length === 0, onClick: onSaveKey }, t("acctSaveKey"))),
        react.createElement("p", { className: "fp-hint", style: { marginTop: 6 }, title: t("acctKeyHint") }, t("acctKeyShort")));
    }

    function configOperations(config = {}) {
      const numeric = new Set(["factoryRequestMaxBytes", "proactiveRefreshMinutes", "anthropicSummaryMaxTokens", "anthropicCompactionHeadroomTokens", "opus55CompactionTokens", "sonnet55CompactionTokens", "glmFlashCompactionTokens"]);
      const fields = ["factoryAdaptiveImages", "factoryRequestRecovery", "factoryRequestMaxBytes", "routes", "cliVersion", "apiBaseURL", "keyEnv", "proactiveRefreshMinutes", "anthropicCacheMode", "anthropicCacheTTL", "factoryContextAlignment", "opus55CompactionTokens", "sonnet55CompactionTokens", "glmFlashCompactionTokens", "anthropicContextOptimization", "anthropicSummaryMaxTokens", "anthropicSummaryModel", "anthropicCompactionHeadroomTokens", "anthropicToolClear", "anthropicToolClearKeep", "anthropicToolClearTrigger", "anthropicToolClearBatchTokens", "quotaFloat", "modelAllowlist"];
      const ops = fields.filter(field => config[field] !== undefined).map(field => ({
        op: "set", path: [field], value: numeric.has(field) ? Number(config[field]) : config[field],
      }));
      const values = Object.fromEntries(Object.entries(config.modelCompactionTokens ?? {}).map(([id, raw]) => {
        const n = typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
        if (!Number.isInteger(n) || n < 16384) throw new Error("Invalid compaction threshold");
        return [id, n];
      }));
      ops.push({ op: "set", path: ["modelCompactionTokens"], value: values });
      return ops;
    }

    function ModelCompactionEditor({ t, config, routes, patchConfig, dirty, saving, saved, onSave, onDiscard }) {
      const [selected, setSelected] = react.useState("");
      const groups = Object.entries(routes ?? {});
      const models = groups.flatMap(([, route]) => route.models ?? []).filter(m => m.compaction);
      const model = models.find(m => m.id === selected) ?? models[0];
      if (!model || config === undefined) return null;
      const policy = model.compaction;
      const overrides = config.modelCompactionTokens ?? {};
      const raw = overrides[model.id] ?? config[policy.legacyField] ?? policy.defaultThreshold;
      const n = String(raw).trim() ? Number(raw) : NaN;
      const valid = Number.isInteger(n) && n >= 16384 && n <= policy.maxThreshold;
      const fmt = value => Number(value).toLocaleString();
      const reset = () => {
        const next = { ...overrides }; delete next[model.id];
        patchConfig("modelCompactionTokens", next);
        if (policy.legacyField) patchConfig(policy.legacyField, policy.defaultThreshold);
      };
      const badge = policy.source === "selected" ? "modelThresholdSelected" : policy.source === "droid" ? "modelThresholdDroid"
        : policy.source === "dsh-default-adapted" ? "modelThresholdDSH" : "modelThresholdAdapted";
      return react.createElement("section", { className: "fp-modelEditor" },
        react.createElement("div", { className: "fp-modelEditorHead" },
          react.createElement("h3", { className: "fp-cardTitle", style: { margin: 0 } }, t("modelThresholdTitle")),
          react.createElement("span", { className: "fp-modelBadge" }, t(badge))),
        react.createElement("div", { className: "fp-modelEditorGrid" },
          react.createElement("label", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("modelThresholdPick")),
            react.createElement("select", { className: "fp-input", value: model.id, disabled: saving, onChange: e => setSelected(e.target.value) },
              ...groups.map(([route, spec]) => react.createElement("optgroup", { key: route,
                label: t(route === "generic" ? "routesGeneric" : route === "openai" ? "routesOpenAI" : "routesAnthropic") },
                ...(spec.models ?? []).filter(m => m.compaction).map(m =>
                  react.createElement("option", { key: m.id, value: m.id }, shortModelName(m)))))),
            react.createElement("span", { className: "fp-modelMeta" }, t("modelThresholdDefault", { n: fmt(policy.defaultThreshold) }))),
          react.createElement("label", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("modelThresholdLabel")),
            react.createElement("input", { className: "fp-input", type: "number", inputMode: "numeric", min: 16384, max: policy.maxThreshold, step: 1,
              value: String(raw), "aria-invalid": !valid, disabled: saving,
              onChange: e => patchConfig("modelCompactionTokens", { ...overrides, [model.id]: e.target.value }) }),
            react.createElement("span", { className: "fp-modelMeta" }, t("modelThresholdLimit", { n: fmt(policy.maxThreshold) })))),
        !valid ? react.createElement("p", { className: "fp-modelError", role: "alert" }, t("modelThresholdInvalid")) : null,
        policy.smallerChannel ? react.createElement("p", { className: "fp-modelWarning" }, t("modelThresholdSmall")) : null,
        policy.effortDependent ? react.createElement("p", { className: "fp-hint" }, t("modelThresholdEffort")) : null,
        config.factoryContextAlignment === false ? react.createElement("p", { className: "fp-hint" }, t("modelThresholdDisabled")) : null,
        react.createElement("details", { className: "fp-budgetDetails" },
          react.createElement("summary", null, t("modelThresholdBudget")),
          react.createElement("dl", { className: "fp-budgetGrid" },
            ...[["modelThresholdWindow", policy.contextWindow], ["modelThresholdInput", policy.maxInputTokens], ["modelThresholdOutput", policy.maxOutputTokens],
              ...(policy.smallerChannel ? [["modelThresholdNative", policy.nativeContextWindow]] : [])].map(([label, value]) =>
                react.createElement("div", { key: label }, react.createElement("dt", null, t(label)), react.createElement("dd", null, fmt(value)))))),
        react.createElement("div", { className: "fp-row", style: { marginTop: 14, justifyContent: "space-between" } },
          react.createElement("button", { className: "fp-btn", disabled: saving, onClick: reset }, t("modelThresholdReset")),
          react.createElement(SaveBar, { t, dirty, saving, invalid: !valid, saved, onSave, onDiscard })),
        react.createElement("p", { className: "fp-hint", style: { marginBottom: 0 } }, t("modelThresholdHint")));
    }

    function RouteTable({ t, routeKey, route, enabled, onToggle, selected, onSelect, onSelectRoute }) {
      if (route === undefined) return null;
      const chosen = new Set(selected ?? []);
      const ids = route.models.map((m) => m.id);
      const allOn = ids.length > 0 && ids.every((id) => chosen.has(id));
      const rows = route.models.map((m) =>
        react.createElement("tr", { key: m.id },
          react.createElement("td", { className: "fp-td" },
            react.createElement("input", {
              type: "checkbox",
              checked: chosen.has(m.id),
              onChange: (e) => onSelect(m.id, e.target.checked),
            })),
          react.createElement("td", { className: "fp-td", title: m.id }, shortModelName(m)),
          react.createElement("td", { className: "fp-td" }, m.cost ?? "—"),
          react.createElement("td", { className: "fp-td fp-mono" }, (m.efforts ?? []).join("/"))));
      return react.createElement("section", { key: routeKey, className: "fp-card" },
        react.createElement("div", { className: "fp-row", style: { justifyContent: "space-between" } },
          react.createElement("h3", { className: "fp-cardTitle" },
            `${routeKey === "generic" ? t("routesGeneric") : routeKey === "openai" ? t("routesOpenAI") : t("routesAnthropic")} · ${t("routesModels", { n: route.models.length })}`),
          react.createElement("div", { className: "fp-row" },
            react.createElement("label", { className: "fp-check" },
              react.createElement("input", { type: "checkbox", checked: enabled, onChange: (e) => onToggle(routeKey, e.target.checked) }),
              route.providerKey),
            react.createElement("button", { className: "fp-btn", onClick: () => onSelectRoute(routeKey, !allOn) },
              allOn ? t("modelClearAll") : t("modelSelectAll")))),
        react.createElement("table", { className: "fp-table" },
          react.createElement("thead", null,
            react.createElement("tr", null,
              react.createElement("th", { className: "fp-th" }, ""),
              react.createElement("th", { className: "fp-th" }, t("modelCol")),
              react.createElement("th", { className: "fp-th" }, t("routesCost")),
              react.createElement("th", { className: "fp-th" }, t("routesEfforts")))),
          react.createElement("tbody", null, rows)));
    }

    /** Save / discard / saved, shared by every card that edits the config. */
    function SaveBar({ t, dirty, saving, invalid = false, saved, onSave, onDiscard }) {
      return react.createElement("div", { className: "fp-row", style: { marginTop: 8, justifyContent: "flex-end" } },
        dirty ? react.createElement("button", { className: "fp-btn", onClick: onDiscard }, t("configDiscard")) : null,
        react.createElement("button", {
          className: "fp-btn" + (dirty ? " fp-btnPrimary" : ""),
          disabled: !dirty || saving || invalid,
          onClick: onSave,
        }, saving ? t("configSaving") : t("configSave")),
        saved ? react.createElement("span", { className: "fp-ok" }, t("configSaved")) : null);
    }

    /** Everything that decides what a turn costs in context tokens. Kept out of
     *  the collapsed Advanced card, because these are the settings people reach
     *  for when quota is burning. */
    function ContextCard({ t, config, routes, patchConfig, dirty, onSave, saving, saved, onDiscard }) {
      if (config === undefined) return react.createElement("p", { className: "fp-hint" }, t("loading"));
      const set = (field) => (e) => patchConfig(field, e.target.value);
      const routesEnabled = Array.isArray(config.routes) ? config.routes : ["generic", "anthropic"];
      const summaryModels = Object.entries(routes ?? {}).flatMap(([route, spec]) =>
        routesEnabled.includes(route) ? (spec.models ?? [])
          .filter(model => !config.modelAllowlist?.length || config.modelAllowlist.includes(model.id))
          .map(model => ({ value: `${spec.providerKey}/${model.id}`, label: `${model.name ?? model.id}${model.cost ? ` · ${model.cost}` : ""}` })) : []);
      const summaryChoice = config.anthropicSummaryModel ?? "";
      return react.createElement(CollapsibleCard, {
        id: "context",
        title: t("contextCardTitle"),
        defaultOpen: true,
      },
        react.createElement("div", { className: "fp-grid" },
          react.createElement("label", { className: "fp-check" },
            react.createElement("input", { type: "checkbox", checked: config.anthropicToolClear === true,
              onChange: (e) => patchConfig("anthropicToolClear", e.target.checked) }),
            t("configToolClear")),
          react.createElement("p", { className: "fp-hint", style: { margin: 0, flex: "1 1 100%" } }, t("configToolClearHint")),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configToolClearKeep")),
            react.createElement("input", { className: "fp-input", type: "number", min: 0, max: 50,
              value: String(config.anthropicToolClearKeep ?? 3),
              onChange: (e) => patchConfig("anthropicToolClearKeep", Number(e.target.value)) })),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configToolClearTrigger")),
            react.createElement("input", { className: "fp-input", type: "number", min: 0, max: 1000000,
              value: String(config.anthropicToolClearTrigger ?? 20000),
              onChange: (e) => patchConfig("anthropicToolClearTrigger", Number(e.target.value)) })),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configToolClearBatchTokens")),
            react.createElement("input", { className: "fp-input", type: "number", min: 0, max: 1000000,
              value: String(config.anthropicToolClearBatchTokens ?? 20000),
              onChange: (e) => patchConfig("anthropicToolClearBatchTokens", Number(e.target.value)) })),
          react.createElement("label", { className: "fp-check" },
            react.createElement("input", { type: "checkbox", checked: config.factoryContextAlignment !== false,
              onChange: (e) => patchConfig("factoryContextAlignment", e.target.checked) }),
            t("configContextAlignment")),
          react.createElement("p", { className: "fp-hint", style: { margin: 0, flex: "1 1 100%" } }, t("configAlignmentHint")),
          react.createElement("label", { className: "fp-check" },
            react.createElement("input", { type: "checkbox", checked: config.anthropicContextOptimization !== false,
              onChange: (e) => patchConfig("anthropicContextOptimization", e.target.checked) }),
            t("configContextOptimization")),
          react.createElement("p", { className: "fp-hint", style: { margin: 0, flex: "1 1 100%" } }, t("configContextHint")),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configSummaryModel")),
            react.createElement("select", { className: "fp-input", value: summaryChoice, onChange: set("anthropicSummaryModel") },
              react.createElement("option", { value: "" }, t("configSummaryModelDefault")),
              summaryChoice && !summaryModels.some(model => model.value === summaryChoice)
                ? react.createElement("option", { value: summaryChoice, disabled: true }, t("configSummaryModelUnavailable")) : null,
              ...summaryModels.map(model => react.createElement("option", { key: model.value, value: model.value }, model.label)))),
          react.createElement("p", { className: "fp-hint", style: { margin: 0, flex: "1 1 100%" } }, t("configSummaryModelHint")),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configSummaryMaxTokens")),
            react.createElement("input", { className: "fp-input", type: "number", min: 512, max: 16384,
              value: String(config.anthropicSummaryMaxTokens ?? 4096), onChange: set("anthropicSummaryMaxTokens") })),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configHeadroomTokens")),
            react.createElement("input", { className: "fp-input", type: "number", min: 0, max: 65536,
              value: String(config.anthropicCompactionHeadroomTokens ?? 16384), onChange: set("anthropicCompactionHeadroomTokens") })),
          react.createElement(SaveBar, { t, dirty, saving, saved, onSave, onDiscard })));
    }

    function ConfigCard({ t, config, routes, dirty, setDirty, onSave, saving, saved, patchConfig, onDiscard }) {
      if (config === undefined) return react.createElement("p", { className: "fp-hint" }, t("loading"));
      const set = (field) => (e) => patchConfig(field, e.target.value);
      const routesEnabled = Array.isArray(config.routes) ? config.routes : ["generic", "anthropic"];
      const toggleRoute = (route, on) => {
        const next = on ? [...new Set([...routesEnabled, route])] : routesEnabled.filter((r) => r !== route);
        patchConfig("routes", next);
      };
      // "Model visibility" is the modelAllowlist: empty means every model, so
      // the picker stays complete until the user actually ticks something.
      const selectEveryModel = (on) => {
        patchConfig(
          "modelAllowlist",
          on ? Object.values(routes ?? {}).flatMap((r) => (r.models ?? []).map((m) => m.id)) : [],
        );
      };
      return react.createElement("section", { className: "fp-card" },
        react.createElement("h3", { className: "fp-cardTitle" }, t("configTitle")),
        react.createElement("div", { className: "fp-row", style: { marginBottom: 8 } },
          react.createElement("label", { className: "fp-check" },
            react.createElement("input", { type: "checkbox", checked: routesEnabled.includes("generic"), onChange: (e) => toggleRoute("generic", e.target.checked) }),
            t("routesGeneric")),
          react.createElement("label", { className: "fp-check" },
            react.createElement("input", { type: "checkbox", checked: routesEnabled.includes("anthropic"), onChange: (e) => toggleRoute("anthropic", e.target.checked) }),
            t("routesAnthropic")),
          react.createElement("label", { className: "fp-check" },
            react.createElement("input", { type: "checkbox", checked: routesEnabled.includes("openai"), onChange: (e) => toggleRoute("openai", e.target.checked) }),
            t("routesOpenAI"))),
        react.createElement("div", { className: "fp-grid" },
          react.createElement(SectionHeading, { t, label: t("sectionConnection") }),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configCliVersion")),
            react.createElement("input", { className: "fp-input", value: config.cliVersion ?? "", onChange: set("cliVersion") })),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configApiBase")),
            react.createElement("input", { className: "fp-input", value: config.apiBaseURL ?? "", onChange: set("apiBaseURL") })),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configKeyEnv")),
            react.createElement("input", { className: "fp-input", value: config.keyEnv ?? "", onChange: set("keyEnv") })),
          react.createElement(SectionHeading, { t, label: t("sectionCache") }),
          react.createElement(SelectField, {
            t,
            label: t("configCacheMode"),
            value: config.anthropicCacheMode ?? "auto",
            options: ["auto", "passthrough", "rewrite"],
            onChange: set("anthropicCacheMode"),
          }),
          react.createElement(SelectField, {
            t,
            label: t("configCacheTTL"),
            value: config.anthropicCacheTTL ?? "5m",
            options: ["5m", "1h"],
            onChange: set("anthropicCacheTTL"),
          }),
          react.createElement("p", { className: "fp-hint", style: { margin: 0, flex: "1 1 100%" } }, t("configCacheHint")),
          react.createElement(SectionHeading, { t, label: t("sectionRequests") }),
          react.createElement("label", { className: "fp-check" },
            react.createElement("input", { type: "checkbox", checked: config.factoryRequestRecovery !== false,
              onChange: (e) => patchConfig("factoryRequestRecovery", e.target.checked) }),
            t("configRequestRecovery")),
          react.createElement("label", { className: "fp-check" },
            react.createElement("input", { type: "checkbox", checked: config.factoryAdaptiveImages !== false,
              onChange: (e) => patchConfig("factoryAdaptiveImages", e.target.checked) }),
            t("configAdaptiveImages")),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configRequestMaxBytes")),
            react.createElement("input", { className: "fp-input", type: "number", min: 0, max: 33554432,
              value: String(config.factoryRequestMaxBytes ?? 4194304), onChange: set("factoryRequestMaxBytes") })),
          react.createElement("p", { className: "fp-hint", style: { margin: 0, flex: "1 1 100%" } }, t("configRequestSizeHint")),
          // The refresh-window field timed droid token refreshes. It is gone
          // from the schema, so the control and its save field are gone too.
          react.createElement(SectionHeading, { t, label: t("sectionOther") }),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configProactive")),
            react.createElement("input", { className: "fp-input", value: String(config.proactiveRefreshMinutes ?? 5), onChange: set("proactiveRefreshMinutes") })),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configAllowlist")),
            react.createElement("div", { className: "fp-row" },
              react.createElement("span", { className: "fp-hint" },
                (config.modelAllowlist ?? []).length === 0
                  ? t("modelEmptyHint")
                  : t("modelSelectedCount", { n: (config.modelAllowlist ?? []).length })),
              react.createElement("button", { className: "fp-btn", onClick: () => selectEveryModel(true) }, t("modelSelectAll")),
              react.createElement("button", { className: "fp-btn", onClick: () => selectEveryModel(false) }, t("modelClearAll"))))),
        react.createElement("p", { className: "fp-hint", style: { marginTop: 8 } }, t("configReloadHint")),
        react.createElement(SaveBar, { t, dirty, saving, saved, onSave, onDiscard }));
    }

    function JournalCard({ t, entries }) {
      const rows = (entries ?? []).slice(-10).reverse().map((e, i) =>
        react.createElement("tr", { key: i },
          react.createElement("td", { className: "fp-td fp-mono" }, e.t ? e.t.slice(11, 19) : "—"),
          react.createElement("td", { className: "fp-td" }, e.route ?? "—"),
          react.createElement("td", { className: "fp-td fp-mono" }, e.shape?.model ?? "—"),
          react.createElement("td", { className: "fp-td" }, e.event ?? "—"),
          react.createElement("td", { className: e.upstreamStatus >= 200 && e.upstreamStatus < 300 ? "fp-td fp-ok" : "fp-td fp-err" }, e.upstreamStatus ?? "—"),
          react.createElement("td", { className: "fp-td" }, e.ms !== undefined ? `${e.ms}ms` : "—")));
      return react.createElement("section", { className: "fp-card" },
        react.createElement("h3", { className: "fp-cardTitle" }, t("journalTitle")),
        rows.length === 0
          ? react.createElement("p", { className: "fp-hint" }, t("journalEmpty"))
          : react.createElement("table", { className: "fp-table" },
              react.createElement("thead", null,
                react.createElement("tr", null,
                  react.createElement("th", { className: "fp-th" }, "time"),
                  react.createElement("th", { className: "fp-th" }, "route"),
                  react.createElement("th", { className: "fp-th" }, t("modelCol")),
                  react.createElement("th", { className: "fp-th" }, "event"),
                  react.createElement("th", { className: "fp-th" }, "status"),
                  react.createElement("th", { className: "fp-th" }, "ms"))),
              react.createElement("tbody", null, rows)),
        react.createElement("p", { className: "fp-hint", style: { marginTop: 6 } }, t("journalHint")));
    }

    // --- the settings section -----------------------------------------------------

    function FactoryProviderCard(props) {
      const { t } = props;
      const [status, setStatus] = react.useState(undefined);
      const [quota, setQuota] = react.useState(undefined);
      const [config, setConfig] = react.useState(undefined);
      const [revision, setRevision] = react.useState(undefined);
      const [routes, setRoutes] = react.useState(undefined);
      const [journal, setJournal] = react.useState([]);
      const [dirty, setDirty] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [saved, setSaved] = react.useState(false);
      const [saveError, setSaveError] = react.useState(undefined);
      const [testing, setTesting] = react.useState(false);
      const [testResult, setTestResult] = react.useState(undefined);
      const [accounts, setAccounts] = react.useState(undefined);
      const [activeId, setActiveId] = react.useState(undefined);
      const [busyAccount, setBusyAccount] = react.useState(false);
      const [accountsError, setAccountsError] = react.useState(undefined);
      // "account" (a saved key is selected), "none" or "off" (explicitly).
      const [accountMode, setAccountMode] = react.useState("default");
      const [quotaByAccount, setQuotaByAccount] = react.useState({});
      const [addLabel, setAddLabel] = react.useState("");
      // A pasted Factory API key. Kept in component state only: the host writes
      // it to the account vault, never back into the settings document.
      const [addKey, setAddKey] = react.useState("");

      const load = react.useCallback(async () => {
        const [statusRes, configRes, journalRes] = await Promise.all([
          bridge("/status"),
          bridge("/config"),
          bridge("/journal"),
        ]);
        if (statusRes.ok) setStatus(statusRes);
        if (configRes.ok) {
          setConfig(configRes.value.config ?? {});
          setRevision(configRes.value.revision);
          setRoutes(configRes.value.routes);
        }
        if (journalRes.ok) setJournal(journalRes.value);
      }, []);

      const loadAccounts = react.useCallback(async () => {
        const res = await bridge("/accounts");
        if (res.ok) {
          setAccounts(res.value?.accounts ?? []);
          setActiveId(res.value?.activeId ?? null);
          setAccountMode(res.value?.mode ?? "none");
        }
      }, []);

      const refreshQuota = react.useCallback(async () => {
        const res = await bridge("/quota");
        setQuota(res);
      }, []);

      const doAccountAction = react.useCallback(async (action, id, label, extra) => {
        setBusyAccount(true);
        setAccountsError(undefined);
        try {
          const res = await bridge("/accounts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, id, label, ...(extra ?? {}) }),
          });
          if (res.ok === false) setAccountsError(res.message ?? res.code ?? "error");
          else {
            // A switch changes the gateway credential and possibly the
            // inference host — refresh every card that shows them.
            await Promise.all([loadAccounts(), load(), refreshQuota()]);
          }
        } finally {
          setBusyAccount(false);
        }
        return res;
      }, [loadAccounts, load, refreshQuota]);

      const doAccountQuota = react.useCallback(async (id) => {
        const res = await bridge(`/accounts/quota?id=${encodeURIComponent(id)}`);
        setQuotaByAccount((prev) => ({ ...prev, [id]: res }));
      }, []);

      // Pasting a key is meant to be usable immediately, so the plugin selects
      // the new entry and the gateway switches to it in one step.
      const doSaveKey = react.useCallback(async () => {
        const res = await doAccountAction("save-key", undefined, addLabel, { key: addKey });
        if (res?.ok) {
          setAddKey("");
          setAddLabel("");
        }
      }, [doAccountAction, addKey, addLabel]);

      // The poll must not re-subscribe when dirty flips: re-running this effect
      // calls load() at once, which would overwrite the edit that just set dirty.
      const dirtyRef = react.useRef(dirty);
      react.useEffect(() => {
        dirtyRef.current = dirty;
      }, [dirty]);

      react.useEffect(() => {
        load();
        loadAccounts();
        refreshQuota();
        const timer = window.setInterval(() => {
          // Never clobber an in-progress edit with a poll reload.
          if (!dirtyRef.current) load();
          loadAccounts();
          refreshQuota();
        }, POLL_MS);
        return () => window.clearInterval(timer);
      }, [load, loadAccounts, refreshQuota]);

      const doTest = react.useCallback(async () => {
        setTesting(true);
        setTestResult(undefined);
        try {
          const res = await bridge("/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ route: (config?.routes ?? []).includes("generic") ? "generic" : (config?.routes ?? []).includes("openai") ? "openai" : "anthropic" }),
          });
          setTestResult(res);
        } finally {
          setTesting(false);
        }
      }, [config]);

      const doSave = react.useCallback(async () => {
        setSaving(true);
        setSaved(false);
        setSaveError(undefined);
        try {
          const ops = configOperations(config);
          const res = await bridge("/config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ops, expectedRevision: revision }),
          });
          if (res.ok) {
            setRevision(res.value?.revision ?? revision);
            setDirty(false);
            setSaved(true);
            load();
          } else setSaveError(res.message ?? t("configSaveFailed"));
        } catch {
          setSaveError(t("configSaveFailed"));
        } finally {
          setSaving(false);
        }
      }, [config, revision, load, t]);

      // Model visibility selection, shared by the route tables and the config
      // card: every edit REPLACES the config object instead of mutating it.
      // Mutating in place never re-rendered — setDirty(true) is a no-op once
      // dirty IS true — so React kept restoring the controlled checkbox and the
      // boxes could not be ticked.
      const patchConfig = react.useCallback((field, value) => {
        setConfig((prev) => ({ ...(prev ?? {}), [field]: value }));
        setDirty(true);
        setSaved(false);
      }, []);
      const allow = Array.isArray(config?.modelAllowlist) ? config.modelAllowlist : [];
      const toggleModel = (id, on) => {
        patchConfig("modelAllowlist", on ? [...new Set([...allow, id])] : allow.filter((x) => x !== id));
      };
      const toggleRouteModels = (routeKey, on) => {
        const ids = (routes?.[routeKey]?.models ?? []).map((m) => m.id);
        patchConfig(
          "modelAllowlist",
          on ? [...new Set([...allow, ...ids])] : allow.filter((id) => !ids.includes(id)),
        );
      };
      const toggleRoute = (routeKey, on) => {
        const current = config?.routes ?? [];
        patchConfig("routes", on ? [...new Set([...current, routeKey])] : current.filter((r) => r !== routeKey));
      };
      const discardEdits = () => {
        setSaved(false);
        setSaveError(undefined);
        void load();
        setDirty(false);
      };

      return react.createElement("div", { className: "fp-section" },
        react.createElement("h2", { className: "fp-heading" }, t("title")),
        react.createElement(ConnectionCard, { t, status, onTest: doTest, testing, testResult }),
        react.createElement(AccountsCard, {
          t,
          accounts,
          activeId,
          busy: busyAccount,
          error: accountsError,
          quotaByAccount,
          onAction: doAccountAction,
          onQuota: doAccountQuota,
          addLabel,
          setAddLabel,
          addKey,
          setAddKey,
          onSaveKey: doSaveKey,
          mode: accountMode,
        }),
        react.createElement(QuotaCard, { t, quota, onRefresh: refreshQuota, config, patchConfig }),
        react.createElement(TokenStatsCard, { t, routes }),
        saveError ? react.createElement("p", { className: "fp-modelError", role: "alert" }, saveError) : null,
        react.createElement(ContextCard, { t, config, routes, patchConfig, dirty, onSave: doSave, saving, saved, onDiscard: discardEdits }),
        // The model tables are the longest thing here and are only touched
        // occasionally, so they fold away — but the save bar stays in the
        // summary, because "ticked models, could not find Save" was a real
        // complaint.
        react.createElement(CollapsibleCard, {
          key: "models",
          id: "models",
          title: t("modelsTitle"),
          hint: allow.length === 0 ? t("modelEmptyHint") : t("modelSelectedCount", { n: allow.length }),
          actions: [
            saved ? react.createElement("span", { key: "saved", className: "fp-ok" }, t("configSaved")) : null,
            dirty ? react.createElement("button", { key: "discard", className: "fp-btn", onClick: discardEdits }, t("configDiscard")) : null,
            react.createElement("button", {
              key: "save",
              className: "fp-btn" + (dirty ? " fp-btnPrimary" : ""),
              disabled: !dirty || saving,
              onClick: doSave,
            }, saving ? t("configSaving") : t("configSave")),
          ],
        },
          react.createElement(ModelCompactionEditor, { t, config, routes, patchConfig, dirty, onSave: doSave, saving, saved, onDiscard: discardEdits }),
          react.createElement(RouteTable, { key: "routes-generic", t, routeKey: "generic", route: routes?.generic, enabled: (config?.routes ?? []).includes("generic"), onToggle: toggleRoute, selected: allow, onSelect: toggleModel, onSelectRoute: toggleRouteModels }),
          react.createElement(RouteTable, { key: "routes-anthropic", t, routeKey: "anthropic", route: routes?.anthropic, enabled: (config?.routes ?? []).includes("anthropic"), onToggle: toggleRoute, selected: allow, onSelect: toggleModel, onSelectRoute: toggleRouteModels }),
          react.createElement(RouteTable, { key: "routes-openai", t, routeKey: "openai", route: routes?.openai, enabled: (config?.routes ?? []).includes("openai"), onToggle: toggleRoute, selected: allow, onSelect: toggleModel, onSelectRoute: toggleRouteModels }),
          react.createElement("p", { key: "freehint", className: "fp-hint" }, t("routesFreeHint"))),
        // Advanced surfaces: useful when something is wrong, noise otherwise.
        react.createElement(CollapsibleCard, { key: "advanced", id: "advanced", title: t("advancedTitle") },
          react.createElement(ConfigCard, { t, config, routes, dirty, setDirty, onSave: doSave, saving, saved, patchConfig, onDiscard: discardEdits }),
          react.createElement("div", { style: { marginTop: 12 } },
            react.createElement(JournalCard, { t, entries: journal }))));

    }

    // --- quota float ---------------------------------------------------------------

    const FLOAT_POS_KEY = "factory-provider:float-pos";
    const FLOAT_COLLAPSED_KEY = "factory-provider:float-collapsed";

    /** Percentage to a colour, using the same thresholds as the reference card. */
    function quotaTone(percent) {
      if (typeof percent !== "number") return "#9ca3af";
      if (percent >= 80) return "#ef4444";
      if (percent >= 60) return "#f59e0b";
      return "#3b82f6";
    }

    function quotaStatus(percent) {
      if (typeof percent !== "number") return "ok";
      if (percent >= 80) return "danger";
      if (percent >= 60) return "warn";
      return "ok";
    }

    function quotaFillClass(percent) {
      return `fp-fill-${quotaStatus(percent)}`;
    }

    /** "3 小时 12 分" style countdown from the window's secondsRemaining. */
    function formatCountdown(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return "";
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
      if (hours > 0) return `${hours} 小时 ${minutes} 分`;
      if (minutes > 0) return `${minutes} 分`;
      return "不到 1 分";
    }

    function readStored(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    }

    function writeStored(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* private mode */
      }
    }

    function FloatRow({ label, percent, secondsRemaining }) {
      const countdown = formatCountdown(secondsRemaining);
      return react.createElement("div", { className: "fp-floatRow" },
        react.createElement("div", { className: "fp-floatRowHead" },
          react.createElement("span", { className: "fp-floatRowLabel" }, label),
          react.createElement("span", { className: "fp-floatRowValue" },
            countdown === "" ? null : react.createElement("span", { className: "fp-floatReset" }, `${countdown} 后重置`),
            react.createElement("span", { className: "fp-floatPct" }, typeof percent === "number" ? `${percent}%` : "—"))),
        react.createElement("div", { className: "fp-floatTrack" },
          react.createElement("div", {
            className: `fp-floatFill ${quotaFillClass(percent)}`,
            style: { width: `${Math.min(100, Math.max(0, percent ?? 0))}%` },
          })));
    }

    /** The collapsed form: an SVG progress ring with a gradient stroke. */
    function FloatRing({ percent, label, onMouseDown, onExpand, title }) {
      const pct = typeof percent === "number" ? Math.min(100, Math.max(0, percent)) : 0;
      const r = 28;
      const circumference = 2 * Math.PI * r;
      const status = quotaStatus(percent);
      return react.createElement("div", {
        className: "fp-floatRing",
        onMouseDown,
        onDoubleClick: onExpand,
        title,
      },
        react.createElement("svg", { width: 72, height: 72, viewBox: "0 0 72 72", className: "fp-floatRingSvg" },
          react.createElement("defs", null,
            react.createElement("linearGradient", { id: "fp-ring-ok", x1: "0%", y1: "0%", x2: "100%", y2: "0%" },
              react.createElement("stop", { offset: "0%", stopColor: "#60a5fa" }),
              react.createElement("stop", { offset: "100%", stopColor: "#3b82f6" })),
            react.createElement("linearGradient", { id: "fp-ring-warn", x1: "0%", y1: "0%", x2: "100%", y2: "0%" },
              react.createElement("stop", { offset: "0%", stopColor: "#fbbf24" }),
              react.createElement("stop", { offset: "100%", stopColor: "#f59e0b" })),
            react.createElement("linearGradient", { id: "fp-ring-danger", x1: "0%", y1: "0%", x2: "100%", y2: "0%" },
              react.createElement("stop", { offset: "0%", stopColor: "#f87171" }),
              react.createElement("stop", { offset: "100%", stopColor: "#ef4444" }))),
          react.createElement("circle", { className: "fp-floatRingBg", cx: 36, cy: 36, r }),
          react.createElement("circle", {
            className: "fp-floatRingFg",
            cx: 36,
            cy: 36,
            r,
            stroke: `url(#fp-ring-${status})`,
            strokeDasharray: circumference,
            strokeDashoffset: circumference - (pct / 100) * circumference,
          })),
        react.createElement("div", { className: "fp-floatRingText" },
          react.createElement("div", { className: "fp-floatRingPct", style: { color: quotaTone(percent) } },
            typeof percent === "number" ? `${Math.round(percent)}%` : "…"),
          react.createElement("div", { className: "fp-floatRingLabel" }, label)));
    }

    function QuotaFloat({ t }) {
      const [enabled, setEnabled] = react.useState(false);
      const [quota, setQuota] = react.useState(undefined);
      const [error, setError] = react.useState(undefined);
      const [refreshing, setRefreshing] = react.useState(false);
      // Closed with the X for this session. Turning the setting off and on again
      // brings it back, which is why the transition is tracked rather than the
      // flag being permanent.
      const [dismissed, setDismissed] = react.useState(false);
      const wasEnabled = react.useRef(false);
      const [collapsed, setCollapsed] = react.useState(() => readStored(FLOAT_COLLAPSED_KEY, false));
      const [pos, setPos] = react.useState(() => readStored(FLOAT_POS_KEY, { x: Math.max(12, window.innerWidth - 230), y: 96 }));
      const [drag, setDrag] = react.useState(undefined);

      // The setting lives in the plugin config, so re-read it on the same poll as
      // the quota: toggling it takes effect without reloading the page.
      react.useEffect(() => {
        let alive = true;
        const tick = async () => {
          const [configRes, quotaRes] = await Promise.all([bridge("/config"), bridge("/quota")]);
          if (!alive) return;
          const on = configRes?.value?.config?.quotaFloat === true;
          if (on && !wasEnabled.current) setDismissed(false);
          wasEnabled.current = on;
          setEnabled(on);
          if (quotaRes?.ok) {
            setQuota(quotaRes.value);
            setError(undefined);
          } else if (quotaRes !== undefined) {
            setError(quotaRes.message ?? quotaRes.code ?? "quota unavailable");
          }
        };
        void tick();
        const id = setInterval(tick, POLL_MS);
        return () => {
          alive = false;
          clearInterval(id);
        };
      }, []);

      react.useEffect(() => {
        if (drag === undefined) return undefined;
        const move = (event) => setPos({
          x: Math.max(0, Math.min(window.innerWidth - 120, event.clientX - drag.dx)),
          y: Math.max(0, Math.min(window.innerHeight - 40, event.clientY - drag.dy)),
        });
        const up = () => setDrag(undefined);
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        return () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
      }, [drag]);

      react.useEffect(() => writeStored(FLOAT_POS_KEY, pos), [pos]);
      react.useEffect(() => writeStored(FLOAT_COLLAPSED_KEY, collapsed), [collapsed]);

      if (!enabled || dismissed) return null;

      const standard = quota?.standard ?? {};
      const rows = [
        { key: "fiveHour", label: t("floatFiveHour") },
        { key: "weekly", label: t("floatWeekly") },
        { key: "monthly", label: t("floatMonthly") },
      ];
      const worstRow = rows.filter(row => Number.isFinite(standard[row.key]?.usedPercent))
        .reduce((highest, row) => !highest || standard[row.key].usedPercent > standard[highest.key].usedPercent ? row : highest, undefined);
      const worst = worstRow ? standard[worstRow.key].usedPercent : undefined;
      const startDrag = (event) => setDrag({ dx: event.clientX - pos.x, dy: event.clientY - pos.y });
      const style = { left: pos.x, top: pos.y };

      if (collapsed) {
        return react.createElement("div", { style: { ...style, position: "fixed", zIndex: 9999 } },
          react.createElement(FloatRing, {
            percent: quota === undefined ? undefined : worst,
            label: worstRow?.label ?? t("floatTitle"),
            onMouseDown: startDrag,
            onExpand: () => setCollapsed(false),
            title: t("floatExpand"),
          }));
      }

      return react.createElement("div", { className: "fp-float", style },
        react.createElement("div", { className: "fp-floatHeader", onMouseDown: startDrag },
          react.createElement("span", { className: "fp-floatTitle" },
            react.createElement("span", {
              className: "fp-floatDot",
              "data-status": quotaStatus(quota === undefined ? undefined : worst),
              style: { background: quota === undefined ? "#94a3b8" : quotaTone(worst) },
            }),
            t("floatTitle")),
          react.createElement("span", { className: "fp-floatActions" },
            react.createElement("button", {
              className: "fp-floatBtn",
              title: t("floatRefresh"),
              disabled: refreshing,
              onMouseDown: (event) => event.stopPropagation(),
              onClick: async (event) => {
                event.stopPropagation();
                if (refreshing) return;
                setRefreshing(true);
                const res = await bridge("/quota");
                if (res?.ok) setQuota(res.value);
                setRefreshing(false);
              },
            }, refreshing ? "…" : "↻"),
            react.createElement("button", {
              className: "fp-floatBtn",
              title: t("floatCollapse"),
              onMouseDown: (event) => event.stopPropagation(),
              onClick: () => setCollapsed(true),
            }, "−"),
            react.createElement("button", {
              className: "fp-floatBtn",
              title: t("floatClose"),
              onMouseDown: (event) => event.stopPropagation(),
              onClick: () => setDismissed(true),
            }, "×"))),
        react.createElement("div", { className: "fp-floatBody" },
          ...rows.map((row) => react.createElement(FloatRow, {
            key: row.key,
            label: row.label,
            percent: standard[row.key]?.usedPercent,
            secondsRemaining: standard[row.key]?.secondsRemaining,
          })),
          error === undefined
            ? react.createElement("div", { className: "fp-floatUpdated" },
                quota?.fetchedAt === undefined
                  ? t("floatLoading")
                  : `${t("floatUpdated")} ${new Date(quota.fetchedAt).toLocaleTimeString()}`)
            : react.createElement("div", { className: "fp-floatUpdated", style: { color: "var(--dsw-alias-label-error,#d33)" } },
                String(error).slice(0, 48))));
    }

    // --- registration -------------------------------------------------------------

    const inject = ["slots", "locale"];
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-factory-provider: dictionaries");
      const t = ctx.locale.bind(NS);
      // A wrapper rather than inject(): the overlay slot is a different slot
      // from settings.section, and passing t explicitly removes any doubt about
      // whether it forwards the injected props.
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "factory-provider-quota", order: 10 },
          () => react.createElement(QuotaFloat, { t }),
        ));
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "factory-provider",
            order: 85,
            label: () => t("nav"),
            inject: () => ({ t }),
          },
          FactoryProviderCard,
        ));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});

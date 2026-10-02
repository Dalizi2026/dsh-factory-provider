// dsh-factory-provider — Web settings card (browser half).
//
// Registers a "Factory (Droid)" entry into the settings left-nav via the
// `settings.section` list slot and renders five panels: connection status,
// subscription quota, routes & models, editable config, and the request
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
      intro: "把 Factory Droid 的 Pro/Plus/Max 订阅额度接入 DeepSeek Harness：凭据、额度、路由与诊断。",
      connTitle: "连接状态",
      connLoggedIn: "droid CLI 已登录",
      connApiKey: "API Key（按量计费）",
      connNone: "未检测到登录态",
      connNoneHint: "在终端跑一次 droid 完成浏览器登录（Pro 订阅账号），或设置 FACTORY_API_KEY。",
      connDisabled: "已停用",
      connKeySources: "密钥来源尝试",
      connKeySource: "信封密钥来源",
      "connKeyRemedy_windows-keyring":
        "读不到登录态：Windows 凭据管理器里的 “Factory CLI” 密钥无法读取。可（1）设置 FACTORY_AUTH_KEY 为 base64 密钥，（2）或在启动 DSH 前用 FACTORY_DISABLE_KEYRING=1 重新登录一次 droid，让它改用 auth.v2.key 文件。",
      "connKeyRemedy_linux-secret-service":
        "读不到登录态：Secret Service（secret-tool）不可用或钥匙环未解锁。安装 libsecret 并解锁钥匙环，或设置 FACTORY_AUTH_KEY，或用 FACTORY_DISABLE_KEYRING=1 重新登录 droid。",
      "connKeyRemedy_macos-keychain":
        "读不到登录态：登录钥匙串中的 “Factory CLI” 密钥无法读取。请在钥匙串访问里允许 DSH 读取，或设置 FACTORY_AUTH_KEY。",
      "connKeyRemedy_generic": "读不到登录态：设置 FACTORY_AUTH_KEY（base64 密钥），或在已登录的机器上运行一次 droid。",
      connToken: "Access token",
      connOrg: "组织",
      connUpstream: "推理主机",
      connGateway: "网关",
      connReconcile: "Provider 写入",
      connAnnounced: "已触发模型目录重建",
      connAnnounceFailed: "目录未重建（需重启）",
      connTest: "测试连接",
      connTesting: "测试中…",
      connRefresh: "刷新",
      quotaTitle: "订阅额度",
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
      routesTitle: "路由与模型",
      routesGeneric: "Droid Core（免费池）",
      routesAnthropic: "Claude（标准额度）",
      routesOpenAI: "GPT（标准额度）",
      routesModels: "{n} 个模型",
      routesEfforts: "思考档位",
      routesCost: "倍率",
      routesFreeHint: "Factory 的消耗顺序：标准池先扣（GLM 等 Core 模型按低倍率也扣这里）→ 标准耗尽后免费落 Core 池 → 再往后 Extra Usage 预付。倍率越低扣得越慢：GLM-5.3-Flash 0.06x vs Opus 5.5 1.6x。",
      configTitle: "配置",
      configRoutes: "启用路由",
      configCliVersion: "factory-cli 版本号（UA）",
      configApiBase: "推理主机地址",
      configKeyEnv: "API Key 环境变量名",
      configRefreshWindow: "提前刷新（分钟）",
      configProactive: "定时刷新周期（分钟，0 = 关闭）",
      configAllowlist: "模型显示范围（在上方「路由与模型」勾选，可就地保存）",
      modelSelectAll: "全选",
      modelClearAll: "清空",
      modelSelectedCount: "已勾选 {n} 个模型",
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
      actionsCol: "操作",
      acctTitle: "账号切换",
      acctHint:
        "保存多个 Factory 登录态，一键切换 DSH 网关使用的账号。只影响本插件，终端 droid CLI 的登录不受影响；设置了 API Key 时 Key 优先。删除正在使用的账号会直接停用凭据（额度查询与模型调用都会失败），不会自动回落到别的登录——要恢复就点「切回默认登录」或选择其它账号。",
      acctCol: "账号",
      acctMode: "当前凭据",
      acctModeDefault: "droid CLI 默认登录",
      acctModeAccount: "账号 {id}",
      acctModeOff: "已停用——不使用任何登录，额度查询与模型调用都会失败",
      acctDisable: "停用",
      acctEnableDefault: "切回默认登录",
      acctOrg: "组织",
      acctState: "状态",
      acctActive: "使用中",
      acctReady: "就绪",
      acctPending: "待登录",
      acctUnreadable: "不可读",
      acctDefault: "默认（跟随 droid CLI）",
      acctUse: "使用",
      acctUseDefault: "恢复默认",
      acctQuotaBtn: "额度",
      acctDelete: "删除",
      acctConfirmDelete: "删除这个账号？删除后本插件会停用凭据，额度查询和模型调用都会失败，直到你选择其它账号或切回默认登录。",
      acctSaveCurrent: "保存当前登录态",
      acctSaving: "处理中…",
      acctAdd: "添加账号",
      acctAddLabel: "备注名（可选）",
      acctCreateDir: "创建登录目录",
      acctAddCommand:
        "在终端运行下面的命令完成官方浏览器登录，完成后账号会自动出现在列表里（Ctrl+C 退出即可）：",
      acctQuotaShort: "5h {a}% · 周 {b}% · 月 {c}%",
      acctFail: "操作失败",
    };
    const en = {
      nav: "Factory (Droid)",
      title: "Factory (Droid) subscription",
      intro: "Bring your Factory Droid subscription quota into DeepSeek Harness: credential, quota, routes, diagnostics.",
      connTitle: "Connection",
      connLoggedIn: "droid CLI signed in",
      connApiKey: "API key (metered)",
      connNone: "No credential detected",
      connNoneHint: "Run the droid CLI once to sign in with your subscription, or set FACTORY_API_KEY.",
      connDisabled: "off",
      connKeySources: "Key sources tried",
      connKeySource: "Envelope key source",
      "connKeyRemedy_windows-keyring":
        "Login state unreadable: the \"Factory CLI\" key in Windows Credential Manager could not be read. Set FACTORY_AUTH_KEY to the base64 key, or sign in again with FACTORY_DISABLE_KEYRING=1 so droid falls back to the auth.v2.key file.",
      "connKeyRemedy_linux-secret-service":
        "Login state unreadable: Secret Service (secret-tool) is missing or locked. Install libsecret and unlock the keyring, set FACTORY_AUTH_KEY, or sign in again with FACTORY_DISABLE_KEYRING=1.",
      "connKeyRemedy_macos-keychain":
        "Login state unreadable: the \"Factory CLI\" key in the login keychain could not be read. Allow DSH access in Keychain Access, or set FACTORY_AUTH_KEY.",
      "connKeyRemedy_generic":
        "Login state unreadable: set FACTORY_AUTH_KEY to the base64 key, or run droid once on a machine that is signed in.",
      connToken: "Access token",
      connOrg: "Organization",
      connUpstream: "Inference host",
      connGateway: "Gateway",
      connReconcile: "Provider write",
      connAnnounced: "model catalog refreshed",
      connAnnounceFailed: "catalog needs a restart",
      connTest: "Test connection",
      connTesting: "Testing…",
      connRefresh: "Refresh",
      quotaTitle: "Subscription quota",
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
      routesTitle: "Routes & models",
      routesGeneric: "Droid Core (free pool)",
      routesAnthropic: "Claude (standard quota)",
      routesOpenAI: "GPT (standard quota)",
      routesModels: "{n} models",
      routesEfforts: "Efforts",
      routesCost: "Cost",
      routesFreeHint: "Factory consumption order: standard pool first (Core models too, at low multipliers) → free Core pool after standard runs out → Extra Usage prepaid. Lower multiplier = slower burn: GLM-5.3-Flash 0.06x vs Opus 5.5 1.6x.",
      configTitle: "Configuration",
      configRoutes: "Enabled routes",
      configCliVersion: "factory-cli version (UA)",
      configApiBase: "Inference host URL",
      configKeyEnv: "API key env var",
      configRefreshWindow: "Refresh early by (minutes)",
      configProactive: "Refresh interval (minutes, 0 = off)",
      configAllowlist: "Model visibility (tick models in Routes & models above)",
      modelSelectAll: "Select all",
      modelClearAll: "Clear",
      modelSelectedCount: "{n} models selected",
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
      actionsCol: "Actions",
      acctTitle: "Accounts",
      acctHint:
        "Save several Factory logins and switch the account the DSH gateway uses with one click. Affects this plugin only — the droid CLI's own login stays untouched. A configured API key takes precedence. Deleting the account in use stops credential serving outright (quota reads and model calls fail) instead of falling back to another login — pick another account or switch back to the default login to resume.",
      acctCol: "Account",
      acctMode: "Credential",
      acctModeDefault: "droid CLI default login",
      acctModeAccount: "account {id}",
      acctModeOff: "off — no login is used, so quota reads and model calls fail",
      acctDisable: "Turn off",
      acctEnableDefault: "Use default login",
      acctOrg: "Org",
      acctState: "State",
      acctActive: "active",
      acctReady: "ready",
      acctPending: "awaiting login",
      acctUnreadable: "unreadable",
      acctDefault: "default (follows droid CLI)",
      acctUse: "Use",
      acctUseDefault: "Restore default",
      acctQuotaBtn: "Quota",
      acctDelete: "Delete",
      acctConfirmDelete: "Delete this account? The plugin then serves no credential, so quota reads and model calls fail until you pick another account or switch back to the default login.",
      acctSaveCurrent: "Save current login",
      acctSaving: "Working…",
      acctAdd: "Add account",
      acctAddLabel: "Label (optional)",
      acctCreateDir: "Create login dir",
      acctAddCommand:
        "Run this in a terminal and finish the official browser login; the account appears here automatically (Ctrl+C to exit droid):",
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
      ".fp-th{color:var(--dsw-alias-label-tertiary);text-align:left;font-weight:500;padding:4px 8px 4px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".fp-td{color:var(--dsw-alias-label-primary);padding:4px 8px 4px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".fp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}",
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

    // --- panels ------------------------------------------------------------------

    function ConnectionCard({ t, status, onTest, testing, testResult }) {
      if (status === undefined) return react.createElement("p", { className: "fp-hint" }, t("loading"));
      const credential = status.credential ?? {};
      const source = credential.source ?? "unknown";
      const badge =
        source === "droid-cli"
          ? { cls: "fp-badge fp-badgeOk", text: t("connLoggedIn") }
          : source === "api-key"
            ? { cls: "fp-badge", text: t("connApiKey") }
            : source === "disabled"
              ? { cls: "fp-badge fp-badgeErr", text: t("connDisabled") }
              : { cls: "fp-badge fp-badgeErr", text: t("connNone") };
      const reconcile = status.plugin?.reconcile ?? "pending";
      const children = [
        react.createElement("div", { key: "badge", className: "fp-row" },
          react.createElement("span", { className: badge.cls }, badge.text),
          react.createElement("span", { className: "fp-hint" },
            `${t("connToken")}: ${fmtTime(credential.expiresAt)}${credential.expiresAt ? ` (${fmtRemain(credential.expiresAt - Date.now())})` : ""}`),
        ),
        react.createElement("div", { key: "meta", className: "fp-grid" },
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("connOrg")),
            react.createElement("span", { className: "fp-value fp-mono" }, credential.orgId ?? "—")),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("connUpstream")),
            react.createElement("span", { className: "fp-value fp-mono" }, status.upstream ?? "—")),
          credential.keySource
            ? react.createElement("div", { className: "fp-field" },
                react.createElement("span", { className: "fp-label" }, t("connKeySource")),
                react.createElement("span", { className: "fp-value fp-mono" }, credential.keySource))
            : null,
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("connReconcile")),
            react.createElement("span", { className: reconcile === "applied" || reconcile === "clean" ? "fp-ok" : "fp-err" },
              `${reconcile}${status.plugin?.error ? ` — ${status.plugin.error}` : ""}${
                status.plugin?.announced === "ok"
                  ? ` · ${t("connAnnounced")}`
                  : status.plugin?.announced === "failed"
                    ? ` · ${t("connAnnounceFailed")}`
                    : ""
              }`)),
        ),
      ];
      if (source !== "droid-cli" && source !== "api-key") {
        children.push(react.createElement("p", { key: "hint", className: "fp-hint" }, t("connNoneHint")));
        // "not logged in" and "the machine's envelope key could not be read"
        // look the same from here; the second case needs its own remedy, and
        // which sources were tried is what makes it diagnosable remotely.
        if (Array.isArray(credential.keyAttempts) && credential.keyAttempts.length > 0) {
          children.push(react.createElement("p", { key: "keyHint", className: "fp-hint" },
            `${t("connKeySources")}: ${credential.keyAttempts.join(" · ")}`));
        }
        if (typeof credential.keyRemedy === "string") {
          children.push(react.createElement("p", { key: "keyRemedy", className: "fp-hint" },
            t(`connKeyRemedy_${credential.keyRemedy}`)));
        }
      }
      children.push(react.createElement("div", { key: "actions", className: "fp-row", style: { marginTop: 8 } },
        react.createElement("button", { className: "fp-btn", disabled: testing, onClick: onTest }, testing ? t("connTesting") : t("connTest")),
        testResult
          ? react.createElement("span", { className: testResult.ok ? "fp-ok" : "fp-err" },
              `${testResult.ok ? t("statusOk") : t("statusFail")} · ${testResult.status} · ${testResult.route}/${testResult.model}${testResult.body ? ` · ${testResult.body.slice(0, 120)}` : ""}`)
          : null));
      return react.createElement("section", { className: "fp-card" },
        react.createElement("h3", { className: "fp-cardTitle" }, t("connTitle")),
        ...children);
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

    function QuotaCard({ t, quota, onRefresh }) {
      return react.createElement("section", { className: "fp-card" },
        react.createElement("div", { key: "head", className: "fp-row", style: { justifyContent: "space-between" } },
          react.createElement("h3", { className: "fp-cardTitle" }, t("quotaTitle")),
          react.createElement("button", { className: "fp-btn", onClick: onRefresh }, t("connRefresh"))),
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
              ]);
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
      addInfo,
      onCreate,
      mode,
    }) {
      const badgeText = (state, isActive) =>
        isActive
          ? t("acctActive")
          : state === "ready"
            ? t("acctReady")
            : state === "pending"
              ? t("acctPending")
              : t("acctUnreadable");
      const rows = (accounts ?? []).map((a) => {
        const isActive = activeId === a.id;
        const quota = quotaByAccount?.[a.id];
        return react.createElement("tr", { key: a.id },
          react.createElement("td", { className: "fp-td" },
            react.createElement("span", null, a.label ?? a.id),
            a.email
              ? react.createElement("div", { className: "fp-hint fp-mono" }, a.email)
              : null,
            quota !== undefined
              ? react.createElement(
                  "div",
                  { className: quota.ok ? "fp-hint" : "fp-err" },
                  quota.ok
                    ? t("acctQuotaShort", {
                        a: Math.round(quota.value?.standard?.fiveHour?.usedPercent ?? 0),
                        b: Math.round(quota.value?.standard?.weekly?.usedPercent ?? 0),
                        c: Math.round(quota.value?.standard?.monthly?.usedPercent ?? 0),
                      })
                    : `${t("acctFail")}: ${quota.message ?? quota.code}`,
                )
              : null),
          react.createElement("td", { className: "fp-td fp-mono" }, a.orgId ? a.orgId.slice(0, 18) : "—"),
          react.createElement("td", { className: "fp-td" }, badgeText(a.state, isActive)),
          react.createElement("td", { className: "fp-td" },
            react.createElement("div", { className: "fp-row" },
              !isActive && a.state === "ready"
                ? react.createElement("button", { className: "fp-btn", disabled: busy, onClick: () => onAction("switch", a.id) }, t("acctUse"))
                : null,
              react.createElement("button", { className: "fp-btn", disabled: busy || a.state !== "ready", onClick: () => onQuota(a.id) }, t("acctQuotaBtn")),
              react.createElement("button", { className: "fp-btn", disabled: busy, onClick: () => { if (window.confirm(t("acctConfirmDelete"))) onAction("delete", a.id); } }, t("acctDelete")))));
      });
      return react.createElement("section", { className: "fp-card" },
        react.createElement("div", { className: "fp-row", style: { justifyContent: "space-between" } },
          react.createElement("h3", { className: "fp-cardTitle" }, t("acctTitle")),
          react.createElement("div", { className: "fp-row" },
            activeId !== null && activeId !== undefined
              ? react.createElement("button", { className: "fp-btn", disabled: busy, onClick: () => onAction("use-default") }, t("acctUseDefault"))
              : null,
            mode === "off"
              ? react.createElement("button", { className: "fp-btn", disabled: busy, onClick: () => onAction("use-default") }, t("acctEnableDefault"))
              : react.createElement("button", { className: "fp-btn", disabled: busy, onClick: () => onAction("disable") }, t("acctDisable")),
            react.createElement("button", { className: "fp-btn", disabled: busy, onClick: () => onAction("save-current") }, busy ? t("acctSaving") : t("acctSaveCurrent")))),
        react.createElement("p", { className: "fp-hint", style: { margin: 0 } }, t("acctHint")),
        react.createElement("p", { className: mode === "off" ? "fp-err" : "fp-hint", style: { margin: 0 } },
          `${t("acctMode")}: ${
            mode === "off"
              ? t("acctModeOff")
              : mode === "account"
                ? t("acctModeAccount", { id: activeId ?? "?" })
                : t("acctModeDefault")
          }`),
        error ? react.createElement("p", { className: "fp-err", style: { margin: 0 } }, `${t("acctFail")}: ${error}`) : null,
        accounts === undefined
          ? react.createElement("p", { className: "fp-hint" }, t("loading"))
          : rows.length === 0
            ? react.createElement("p", { className: "fp-hint" }, t("acctSaveCurrent") + " →")
            : react.createElement("table", { className: "fp-table" },
                react.createElement("thead", null,
                  react.createElement("tr", null,
                    react.createElement("th", { className: "fp-th" }, t("acctCol")),
                    react.createElement("th", { className: "fp-th" }, t("acctOrg")),
                    react.createElement("th", { className: "fp-th" }, t("acctState")),
                    react.createElement("th", { className: "fp-th" }, t("actionsCol")))),
                react.createElement("tbody", null, rows)),
        react.createElement("div", { className: "fp-row" },
          react.createElement("input", {
            className: "fp-input",
            style: { flex: "1 1 160px" },
            placeholder: t("acctAddLabel"),
            value: addLabel,
            onChange: (e) => setAddLabel(e.target.value),
          }),
          react.createElement("button", { className: "fp-btn", disabled: busy, onClick: onCreate }, t("acctAdd"))),
        addInfo
          ? react.createElement("div", { className: "fp-field" },
              react.createElement("span", { className: "fp-label" }, t("acctAddCommand")),
              react.createElement("code", { className: "fp-mono" }, addInfo.command),
              // cmd.exe cannot run the PowerShell line; Windows users who live
              // in cmd get their own variant.
              addInfo.windowsCommand && addInfo.windowsCommand !== addInfo.command
                ? react.createElement("code", { className: "fp-mono", style: { display: "block", marginTop: 4 } }, addInfo.windowsCommand)
                : null)
          : null);
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
          react.createElement("td", { className: "fp-td fp-mono" }, m.id),
          react.createElement("td", { className: "fp-td" }, m.name ?? ""),
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
              react.createElement("th", { className: "fp-th" }, ""),
              react.createElement("th", { className: "fp-th" }, t("routesCost")),
              react.createElement("th", { className: "fp-th" }, t("routesEfforts")))),
          react.createElement("tbody", null, rows)));
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
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configCliVersion")),
            react.createElement("input", { className: "fp-input", value: config.cliVersion ?? "", onChange: set("cliVersion") })),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configApiBase")),
            react.createElement("input", { className: "fp-input", value: config.apiBaseURL ?? "", onChange: set("apiBaseURL") })),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configKeyEnv")),
            react.createElement("input", { className: "fp-input", value: config.keyEnv ?? "", onChange: set("keyEnv") })),
          react.createElement("div", { className: "fp-field" },
            react.createElement("span", { className: "fp-label" }, t("configRefreshWindow")),
            react.createElement("input", { className: "fp-input", value: String(config.refreshWindowMinutes ?? 15), onChange: set("refreshWindowMinutes") })),
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
        react.createElement("div", { className: "fp-row", style: { marginTop: 8, justifyContent: "flex-end" } },
          dirty ? react.createElement("button", { className: "fp-btn", onClick: onDiscard }, t("configDiscard")) : null,
          react.createElement("button", {
            className: "fp-btn" + (dirty ? " fp-btnPrimary" : ""),
            disabled: !dirty || saving,
            onClick: onSave,
          }, saving ? t("configSaving") : t("configSave")),
          saved ? react.createElement("span", { className: "fp-ok" }, t("configSaved")) : null));
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
      const [testing, setTesting] = react.useState(false);
      const [testResult, setTestResult] = react.useState(undefined);
      const [accounts, setAccounts] = react.useState(undefined);
      const [activeId, setActiveId] = react.useState(undefined);
      const [busyAccount, setBusyAccount] = react.useState(false);
      const [accountsError, setAccountsError] = react.useState(undefined);
      // "default" (the droid CLI login), "account" (a snapshot) or "off".
      const [accountMode, setAccountMode] = react.useState("default");
      const [quotaByAccount, setQuotaByAccount] = react.useState({});
      const [addLabel, setAddLabel] = react.useState("");
      const [addInfo, setAddInfo] = react.useState(undefined);

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
          setAccountMode(res.value?.mode ?? "default");
        }
      }, []);

      const refreshQuota = react.useCallback(async () => {
        const res = await bridge("/quota");
        setQuota(res);
      }, []);

      const doAccountAction = react.useCallback(async (action, id, label) => {
        setBusyAccount(true);
        setAccountsError(undefined);
        try {
          const res = await bridge("/accounts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, id, label }),
          });
          if (res.ok === false) setAccountsError(res.message ?? res.code ?? "error");
          else if (action === "create") setAddInfo(res.value ?? undefined);
          else {
            setAddInfo(undefined);
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

      const doCreateAccount = react.useCallback(async () => {
        const res = await doAccountAction("create", undefined, addLabel);
        if (res?.ok) setAddLabel("");
      }, [doAccountAction, addLabel]);

      react.useEffect(() => {
        load();
        loadAccounts();
        refreshQuota();
        const timer = window.setInterval(() => {
          // Never clobber an in-progress edit with a poll reload.
          if (!dirty) load();
          loadAccounts();
          refreshQuota();
        }, POLL_MS);
        return () => window.clearInterval(timer);
      }, [load, loadAccounts, refreshQuota, dirty]);

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
        try {
          const ops = [];
          // The two interval inputs hand back strings; the settings schema wants
          // numbers, and a rejected write now surfaces (it used to fail anyway,
          // for a different reason).
          const numeric = new Set(["refreshWindowMinutes", "proactiveRefreshMinutes"]);
          for (const field of ["routes", "cliVersion", "apiBaseURL", "keyEnv", "refreshWindowMinutes", "proactiveRefreshMinutes", "modelAllowlist"]) {
            const raw = config?.[field];
            ops.push({ op: "set", path: [field], value: numeric.has(field) ? Number(raw) : raw });
          }
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
          }
        } finally {
          setSaving(false);
        }
      }, [config, revision, load]);

      // Model visibility selection, shared by the route tables and the config
      // card: every edit REPLACES the config object instead of mutating it.
      // Mutating in place never re-rendered — setDirty(true) is a no-op once
      // dirty IS true — so React kept restoring the controlled checkbox and the
      // boxes could not be ticked.
      const patchConfig = react.useCallback((field, value) => {
        setConfig((prev) => ({ ...(prev ?? {}), [field]: value }));
        setDirty(true);
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
        void load();
        setDirty(false);
      };

      return react.createElement("div", { className: "fp-section" },
        react.createElement("h2", { className: "fp-heading" }, t("title")),
        react.createElement("p", { className: "fp-intro" }, t("intro")),
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
          addInfo,
          onCreate: doCreateAccount,
          mode: accountMode,
        }),
        react.createElement(QuotaCard, { t, quota, onRefresh: refreshQuota }),
        // Save sits with the model list, not only at the bottom of the config
        // card: the tables are long, and ticking here then scrolling far down to
        // save is where "I don't see a save button" came from.
        react.createElement("div", { key: "model-actions", className: "fp-card" },
          react.createElement("div", { className: "fp-row", style: { justifyContent: "space-between" } },
            react.createElement("span", { className: "fp-hint" },
              allow.length === 0 ? t("modelEmptyHint") : t("modelSelectedCount", { n: allow.length })),
            react.createElement("div", { className: "fp-row" },
              saved ? react.createElement("span", { className: "fp-ok" }, t("configSaved")) : null,
              dirty ? react.createElement("button", { className: "fp-btn", onClick: discardEdits }, t("configDiscard")) : null,
              react.createElement("button", {
                className: "fp-btn" + (dirty ? " fp-btnPrimary" : ""),
                disabled: !dirty || saving,
                onClick: doSave,
              }, saving ? t("configSaving") : t("configSave"))))),
        react.createElement(RouteTable, { key: "routes-generic", t, routeKey: "generic", route: routes?.generic, enabled: (config?.routes ?? []).includes("generic"), onToggle: toggleRoute, selected: allow, onSelect: toggleModel, onSelectRoute: toggleRouteModels }),
        react.createElement(RouteTable, { key: "routes-anthropic", t, routeKey: "anthropic", route: routes?.anthropic, enabled: (config?.routes ?? []).includes("anthropic"), onToggle: toggleRoute, selected: allow, onSelect: toggleModel, onSelectRoute: toggleRouteModels }),
        react.createElement(RouteTable, { key: "routes-openai", t, routeKey: "openai", route: routes?.openai, enabled: (config?.routes ?? []).includes("openai"), onToggle: toggleRoute, selected: allow, onSelect: toggleModel, onSelectRoute: toggleRouteModels }),
        react.createElement("p", { key: "freehint", className: "fp-hint" }, t("routesFreeHint")),
        react.createElement(ConfigCard, { t, config, routes, dirty, setDirty, onSave: doSave, saving, saved, patchConfig, onDiscard: discardEdits }),
        react.createElement(JournalCard, { t, entries: journal }));
    }

    // --- registration -------------------------------------------------------------

    const inject = ["slots", "locale"];
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-factory-provider: dictionaries");
      const t = ctx.locale.bind(NS);
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

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
      connApiKey: "API key",
      connNone: "未配置 API key",
      connNoneHint: "在下方「账号与 API key」里粘贴一个 Factory API key 即可，不需要安装 droid CLI。",
      connDisabled: "已停用",
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
      modelsTitle: "模型（勾选后保存）",
      advancedTitle: "高级（配置与日志）",
      routesGeneric: "Droid Core（低倍率）",
      routesAnthropic: "Claude",
      routesOpenAI: "GPT",
      routesModels: "{n} 个模型",
      routesEfforts: "思考档位",
      routesCost: "倍率",
      routesFreeHint: "Factory 的消耗顺序：标准池先扣（GLM 等 Core 模型按低倍率也扣这里）→ 标准耗尽后免费落 Core 池 → 再往后 Extra Usage 预付。倍率越低扣得越慢：GLM-5.3-Flash 0.06x vs Opus 5.5 1.6x。",
      configTitle: "配置",
      configCliVersion: "factory-cli 版本号（UA）",
      configApiBase: "推理主机地址",
      configKeyEnv: "API Key 环境变量名",
      configCacheMode: "Anthropic 缓存",
      configCacheTTL: "缓存 TTL",
      configCacheHint:
        "auto = 客户端已自带缓存标记时不插手；rewrite = 由插件统一接管位置；passthrough = 完全不改（诊断/回滚用）。1h 是实验选项，若上游不支持会报错，改回 5m 即可。",
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
      connNoneHint: "Paste a Factory API key under Account keys below — no droid CLI install needed.",
      connDisabled: "off",
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
      modelsTitle: "Models (tick, then save)",
      advancedTitle: "Advanced (config & journal)",
      routesGeneric: "Droid Core (low multiplier)",
      routesAnthropic: "Claude",
      routesOpenAI: "GPT",
      routesModels: "{n} models",
      routesEfforts: "Efforts",
      routesCost: "Cost",
      routesFreeHint: "Factory consumption order: standard pool first (Core models too, at low multipliers) → free Core pool after standard runs out → Extra Usage prepaid. Lower multiplier = slower burn: GLM-5.3-Flash 0.06x vs Opus 5.5 1.6x.",
      configTitle: "Configuration",
      configCliVersion: "factory-cli version (UA)",
      configApiBase: "Inference host URL",
      configKeyEnv: "API key env var",
      configCacheMode: "Anthropic cache",
      configCacheTTL: "Cache TTL",
      configCacheHint:
        "auto = leave a client that manages its own caching alone; rewrite = the plugin takes over placement; passthrough = change nothing (diagnosis/rollback). 1h is experimental: if the upstream rejects it, switch back to 5m.",
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
    function CollapsibleCard({ title, hint, actions, defaultOpen = false, children }) {
      const [open, setOpen] = react.useState(defaultOpen);
      return react.createElement("details", {
        className: "fp-card fp-details",
        open,
        onToggle: (event) => setOpen(event.currentTarget.open),
      },
        react.createElement("summary", { className: "fp-summary" },
          react.createElement("span", { className: "fp-cardTitle", style: { margin: 0 } }, title),
          hint ? react.createElement("span", { className: "fp-hint" }, hint) : null,
          actions ? react.createElement("span", { className: "fp-summaryActions" }, actions) : null),
        react.createElement("div", { className: "fp-detailsBody" }, children));
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
      return react.createElement("section", { className: "fp-card" },
        react.createElement("div", { className: "fp-row", style: { justifyContent: "space-between" } },
          react.createElement("div", { className: "fp-row" },
            react.createElement("span", { className: badge.cls }, badge.text),
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
            }, reconcile + (status.plugin?.error ? ` — ${status.plugin.error}` : ""))),
          react.createElement("div", { className: "fp-row" },
            react.createElement("button", { className: "fp-btn", disabled: testing, onClick: onTest },
              testing ? t("connTesting") : t("connTest")))),
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
      return react.createElement("section", { className: "fp-card" },
        react.createElement("div", { className: "fp-row", style: { justifyContent: "space-between" } },
          react.createElement("h3", { className: "fp-cardTitle" }, t("acctTitle")),
          // One switch for "serve credentials at all". There is deliberately no
          // separate "clear selection": with no environment variable set the two
          // would do exactly the same thing, which is what made the old pair of
          // buttons confusing.
          react.createElement("button", {
            className: "fp-btn",
            disabled: busy,
            onClick: () => onAction(mode === "off" ? "clear" : "disable"),
          }, mode === "off" ? t("acctEnable") : t("acctDisable"))),
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
          // The refresh-window field timed droid token refreshes. It is gone
          // from the schema, so the control and its save field are gone too.
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
          const numeric = new Set(["proactiveRefreshMinutes"]);
          for (const field of ["routes", "cliVersion", "apiBaseURL", "keyEnv", "proactiveRefreshMinutes", "anthropicCacheMode", "anthropicCacheTTL", "modelAllowlist"]) {
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
        react.createElement(QuotaCard, { t, quota, onRefresh: refreshQuota }),
        // The model tables are the longest thing here and are only touched
        // occasionally, so they fold away — but the save bar stays in the
        // summary, because "ticked models, could not find Save" was a real
        // complaint.
        react.createElement(CollapsibleCard, {
          key: "models",
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
          react.createElement(RouteTable, { key: "routes-generic", t, routeKey: "generic", route: routes?.generic, enabled: (config?.routes ?? []).includes("generic"), onToggle: toggleRoute, selected: allow, onSelect: toggleModel, onSelectRoute: toggleRouteModels }),
          react.createElement(RouteTable, { key: "routes-anthropic", t, routeKey: "anthropic", route: routes?.anthropic, enabled: (config?.routes ?? []).includes("anthropic"), onToggle: toggleRoute, selected: allow, onSelect: toggleModel, onSelectRoute: toggleRouteModels }),
          react.createElement(RouteTable, { key: "routes-openai", t, routeKey: "openai", route: routes?.openai, enabled: (config?.routes ?? []).includes("openai"), onToggle: toggleRoute, selected: allow, onSelect: toggleModel, onSelectRoute: toggleRouteModels }),
          react.createElement("p", { key: "freehint", className: "fp-hint" }, t("routesFreeHint"))),
        // Advanced surfaces: useful when something is wrong, noise otherwise.
        react.createElement(CollapsibleCard, { key: "advanced", title: t("advancedTitle") },
          react.createElement(ConfigCard, { t, config, routes, dirty, setDirty, onSave: doSave, saving, saved, patchConfig, onDiscard: discardEdits }),
          react.createElement("div", { style: { marginTop: 12 } },
            react.createElement(JournalCard, { t, entries: journal }))));

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

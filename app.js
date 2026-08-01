/* ============================================================
   Stockpile — Inventory Tracker
   - Mobile-first, tab-based UI
   - Transactions are the source of truth; product stock/cost
     are derived from them (makes edit/delete + monthly reports clean)
   - Persists a data.json file via the GitHub REST API
   - Credentials live only in this browser's LocalStorage
   ============================================================ */

(() => {
  "use strict";

  const CFG_KEY = "inv_github_config";
  const DATA_PATH = "data.json";

  /* ---------- Application state ---------- */
  const state = {
    config: null, // { token, owner, repo, branch }
    // products: metadata only { name, unit, threshold }
    // transactions: [{ id, type:'purchase'|'usage', product, name, qty, unit, cost, at }]
    // months: { 'YYYY-MM': { closed:true, reimbursed, closedAt } }
    data: { products: {}, transactions: [], months: {} },
    sha: null,
    busy: false,
    month: currentMonthKey(), // 'YYYY-MM' selected in Reports
    invQuery: "",
    editingId: null,
    threshKey: null,
  };

  /* ---------- Element helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const el = {};
  const IDS = [
    "config-modal", "cfg-token", "cfg-owner", "cfg-repo", "cfg-branch",
    "cfg-save", "cfg-cancel", "cfg-error",
    "txn-modal", "txn-title", "txn-sub", "txn-qty", "txn-cost", "txn-cost-wrap",
    "txn-date", "txn-error", "txn-save", "txn-delete", "txn-cancel",
    "thresh-modal", "thresh-sub", "thresh-input", "thresh-save", "thresh-cancel",
    "close-modal", "close-title", "close-summary", "close-confirm", "close-cancel",
    "app", "open-config",
    "hero-used", "hero-used-label", "hero-used-sub", "hero-spent",
    "hero-remaining", "hero-lowcount",
    "usage-form", "u-product", "u-qty", "u-unit-hint", "quick-chips",
    "purchase-form", "p-name", "p-qty", "p-unit", "p-cost", "product-list",
    "recent-purchases",
    "month-bar", "month-prev", "month-next", "month-name", "month-tag",
    "ledger-card", "ledger-title", "ledger-status", "ledger-rows",
    "close-month-btn", "reopen-month-btn",
    "m-used", "m-used-delta", "m-spent", "m-spent-delta",
    "chart-reimburse", "chart-compare", "history-title", "history-list", "export-btn",
    "inv-search", "inventory-list",
    "sync-status", "sync-text", "toast",
  ];
  IDS.forEach((id) => (el[camel(id)] = $(id)));
  function camel(s) {
    return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  /* ---------- Utilities ---------- */
  const money = (n) =>
    (Number(n) || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const num = (n) => {
    const v = Number(n);
    return Number.isFinite(v) ? v : 0;
  };

  const key = (name) => name.trim().toLowerCase();

  const uid = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function currentMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function monthKeyOf(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return currentMonthKey();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function monthName(mk) {
    const [y, m] = mk.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
  }

  function monthShort(mk) {
    const [y, m] = mk.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
      month: "short",
    });
  }

  function addMonths(mk, delta) {
    const [y, m] = mk.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  const fmtQty = (n) => parseFloat(Number(n).toFixed(3)).toString();

  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Unicode-safe base64
  const b64encode = (str) =>
    btoa(
      encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) =>
        String.fromCharCode("0x" + p1)
      )
    );
  const b64decode = (b64) =>
    decodeURIComponent(
      atob(b64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );

  let toastTimer = null;
  function toast(msg, type = "") {
    el.toast.textContent = msg;
    el.toast.className = "toast " + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 3000);
  }

  function setSync(text, kind) {
    if (!text) return el.syncStatus.classList.add("hidden");
    el.syncStatus.classList.remove("hidden", "ok", "err");
    if (kind === "ok") el.syncStatus.classList.add("ok");
    if (kind === "err") el.syncStatus.classList.add("err");
    el.syncText.textContent = text;
  }

  /* ---------- Config (LocalStorage) ---------- */
  const loadConfig = () => {
    try {
      return JSON.parse(localStorage.getItem(CFG_KEY));
    } catch {
      return null;
    }
  };
  const saveConfig = (cfg) => localStorage.setItem(CFG_KEY, JSON.stringify(cfg));

  /* ---------- GitHub REST API ---------- */
  const apiUrl = () => {
    const { owner, repo } = state.config;
    return `https://api.github.com/repos/${owner}/${repo}/contents/${DATA_PATH}`;
  };
  const apiHeaders = () => ({
    Authorization: `Bearer ${state.config.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });

  async function githubGet() {
    const branch = state.config.branch;
    const url = apiUrl() + (branch ? `?ref=${encodeURIComponent(branch)}` : "");
    const res = await fetch(url, { headers: apiHeaders() });
    if (res.status === 404) return { data: null, sha: null };
    if (!res.ok) throw new Error(await describeError(res));
    const json = await res.json();
    let parsed;
    try {
      parsed = JSON.parse(b64decode(json.content || ""));
    } catch {
      throw new Error("data.json in the repo is not valid JSON.");
    }
    return { data: parsed, sha: json.sha };
  }

  async function githubPut(data, message) {
    const body = {
      message: message || "Update inventory data",
      content: b64encode(JSON.stringify(data, null, 2)),
    };
    if (state.sha) body.sha = state.sha;
    if (state.config.branch) body.branch = state.config.branch;

    let res = await fetch(apiUrl(), {
      method: "PUT",
      headers: { ...apiHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.status === 409) {
      // sha conflict → refetch latest sha and retry once
      const latest = await githubGet();
      state.sha = latest.sha;
      body.sha = latest.sha;
      res = await fetch(apiUrl(), {
        method: "PUT",
        headers: { ...apiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) throw new Error(await describeError(res));
    const json = await res.json();
    state.sha = json.content.sha;
  }

  async function describeError(res) {
    let detail = "";
    try {
      detail = (await res.json()).message || "";
    } catch {}
    if (res.status === 401) return "Authentication failed. Check your PAT.";
    if (res.status === 403)
      return "Access forbidden. Ensure the PAT has repo write access.";
    if (res.status === 404)
      return "Repo not found. Check owner/name and PAT permissions.";
    return `GitHub error ${res.status}${detail ? ": " + detail : ""}`;
  }

  async function push(message) {
    if (!state.config) return;
    setSync("Saving…", "busy");
    try {
      await githubPut(state.data, message);
      setSync("Saved", "ok");
      setTimeout(() => setSync(null), 1400);
    } catch (err) {
      setSync("Save failed", "err");
      toast(err.message, "err");
      throw err;
    }
  }

  /* ---------- Derivation (transactions → product aggregates) ---------- */
  function derive() {
    const map = {};
    const ensure = (k, seed) =>
      (map[k] = map[k] || {
        key: k,
        name: seed.name || k,
        unit: seed.unit || "pcs",
        threshold: num(seed.threshold),
        purchasedQty: 0,
        usedQty: 0,
        totalCost: 0,
      });

    for (const [k, p] of Object.entries(state.data.products)) ensure(k, p);
    for (const t of state.data.transactions) {
      const p = ensure(t.product, { name: t.name, unit: t.unit });
      if (t.type === "purchase") {
        p.purchasedQty += num(t.qty);
        p.totalCost += num(t.cost);
      } else if (t.type === "usage") {
        p.usedQty += num(t.qty);
      }
    }
    for (const p of Object.values(map)) {
      p.avgCost = p.purchasedQty > 0 ? p.totalCost / p.purchasedQty : 0;
      p.remaining = p.purchasedQty - p.usedQty;
    }
    return map;
  }

  function totalsAllTime(derived) {
    let spent = 0,
      used = 0,
      remaining = 0,
      low = 0;
    for (const p of Object.values(derived)) {
      spent += p.totalCost;
      used += p.usedQty * p.avgCost;
      remaining += p.remaining * p.avgCost;
      if (p.threshold > 0 && p.remaining <= p.threshold && p.remaining > 0)
        low++;
    }
    return { spent, used, remaining, low };
  }

  // Monthly metrics use each product's all-time weighted avg cost.
  function monthlyTotals(mk, derived) {
    let spent = 0,
      used = 0;
    for (const t of state.data.transactions) {
      if (monthKeyOf(t.at) !== mk) continue;
      if (t.type === "purchase") spent += num(t.cost);
      else if (t.type === "usage") {
        const p = derived[t.product];
        used += num(t.qty) * (p ? p.avgCost : 0);
      }
    }
    return { spent, used };
  }

  function availableMonths() {
    const set = new Set([currentMonthKey(), state.month]);
    for (const t of state.data.transactions) set.add(monthKeyOf(t.at));
    for (const k of Object.keys(state.data.months || {})) set.add(k);
    return [...set].sort();
  }

  // Katha ledger: walk months chronologically, carrying unpaid "due" forward.
  // Closing a month auto-settles the whole running balance up to that month.
  function buildLedger(derived) {
    const months = availableMonths();
    const rows = {};
    let runningDue = 0;
    for (const mk of months) {
      const mt = monthlyTotals(mk, derived);
      const rec = (state.data.months || {})[mk];
      const closed = !!(rec && rec.closed);
      const carryIn = runningDue;
      const owed = mt.used + carryIn;
      const reimbursed = closed ? owed : 0; // auto full settle
      const due = owed - reimbursed;
      runningDue = due;
      rows[mk] = { used: mt.used, spent: mt.spent, carryIn, owed, reimbursed, due, closed };
    }
    return rows;
  }

  const ledgerFor = (mk, derived) => {
    const rows = buildLedger(derived || derive());
    return rows[mk] || { used: 0, spent: 0, carryIn: 0, owed: 0, reimbursed: 0, due: 0, closed: false };
  };

  const isMonthClosed = (mk) =>
    !!((state.data.months || {})[mk] && state.data.months[mk].closed);

  // A new entry lands in the currently selected month.
  function dateForSelectedMonth() {
    const mk = state.month;
    if (mk === currentMonthKey()) return new Date().toISOString();
    const [y, m] = mk.split("-").map(Number);
    return new Date(y, m - 1, 15, 12, 0, 0).toISOString();
  }

  function lastNMonths(n) {
    const out = [];
    let mk = currentMonthKey();
    for (let i = 0; i < n; i++) {
      out.unshift(mk);
      mk = addMonths(mk, -1);
    }
    return out;
  }

  /* ---------- Actions ---------- */
  function assertMonthOpen() {
    if (isMonthClosed(state.month))
      throw new Error(
        `${monthName(state.month)} is closed. Reopen it to add entries.`
      );
  }

  function addPurchase(name, qty, unit, cost) {
    assertMonthOpen();
    const k = key(name);
    const meta = state.data.products[k];
    if (meta) {
      if (meta.unit !== unit)
        toast(`"${meta.name}" already uses ${meta.unit}; keeping that unit.`);
      unit = meta.unit;
    } else {
      state.data.products[k] = { name: name.trim(), unit, threshold: 0 };
    }
    state.data.transactions.push({
      id: uid(),
      type: "purchase",
      product: k,
      name: name.trim(),
      qty,
      unit,
      cost,
      at: dateForSelectedMonth(),
    });
  }

  function recordUsage(k, qty, derived) {
    assertMonthOpen();
    const p = derived[k];
    if (!p) throw new Error("Product not found.");
    if (qty > p.remaining + 1e-9)
      throw new Error(`Only ${fmtQty(p.remaining)} ${p.unit} of "${p.name}" available.`);
    state.data.transactions.push({
      id: uid(),
      type: "usage",
      product: k,
      name: p.name,
      qty,
      unit: p.unit,
      at: dateForSelectedMonth(),
    });
  }

  const findTxn = (id) => state.data.transactions.find((t) => t.id === id);

  /* ---------- Persist wrapper with optimistic rollback ---------- */
  async function mutate(fn, message) {
    if (state.busy) return false;
    state.busy = true;
    const snapshot = clone(state.data);
    try {
      fn(); // may throw for validation
    } catch (err) {
      state.busy = false;
      toast(err.message, "err");
      return false;
    }
    render();
    try {
      await push(message);
      return true;
    } catch {
      state.data = snapshot;
      render();
      return false;
    } finally {
      state.busy = false;
    }
  }

  /* ---------- Rendering ---------- */
  function render() {
    const derived = derive();
    renderMonthBar();
    renderUsage(derived);
    renderPurchases(derived);
    renderReports(derived);
    renderInventory(derived);
  }

  function renderMonthBar() {
    el.monthName.textContent = monthName(state.month);
    const tags = [];
    if (state.month === currentMonthKey()) tags.push("this month");
    if (isMonthClosed(state.month)) tags.push("closed");
    el.monthTag.textContent = tags.join(" · ");
    el.monthNext.disabled = state.month >= currentMonthKey();
    el.monthNext.style.opacity = el.monthNext.disabled ? 0.35 : 1;
  }

  function renderUsage(derived) {
    const l = ledgerFor(state.month, derived);
    const totals = totalsAllTime(derived);
    if (l.closed) {
      el.heroUsedLabel.textContent = `Reimbursed · ${monthShort(state.month)}`;
      el.heroUsed.textContent = money(l.used); // just this month's used value
      el.heroUsedSub.textContent = "Month closed & fully settled";
    } else {
      el.heroUsedLabel.textContent = `To Reimburse · ${monthShort(state.month)}`;
      // Show only this month's used value — carry-in tracked separately in Reports
      el.heroUsed.textContent = money(l.used);
      const parts = [];
      if (l.carryIn > 0.005)
        parts.push(`+${money(l.carryIn)} pending from before`);
      parts.push(`Stock worth ${money(totals.remaining)}`);
      el.heroUsedSub.textContent = parts.join(" · ");
    }



    const products = Object.values(derived);

    // usage dropdown (only in-stock)
    const prev = el.uProduct.value;
    const opts = ['<option value="">Select a product…</option>'];
    for (const p of products) {
      if (p.remaining <= 0) continue;
      opts.push(
        `<option value="${p.key}">${escapeHtml(p.name)} (${fmtQty(
          p.remaining
        )} ${p.unit} left)</option>`
      );
    }
    el.uProduct.innerHTML = opts.join("");
    if ([...el.uProduct.options].some((o) => o.value === prev))
      el.uProduct.value = prev;
    updateUsageHint(derived);

    // quick-use chips (in-stock, top 8 by remaining)
    const inStock = products
      .filter((p) => p.remaining > 0)
      .sort((a, b) => b.remaining - a.remaining)
      .slice(0, 8);
    el.quickChips.innerHTML = inStock.length
      ? inStock
          .map(
            (p) =>
              `<button class="chip" data-quick="${p.key}">${escapeHtml(
                p.name
              )}<span class="chip-q">${fmtQty(p.remaining)} ${p.unit}</span></button>`
          )
          .join("")
      : '<span class="empty-inline">No stock available yet.</span>';
  }

  function updateUsageHint(derived) {
    const p = (derived || derive())[el.uProduct.value];
    el.uUnitHint.textContent = p ? `(in ${p.unit})` : "";
  }

  function renderPurchases(derived) {
    const t = totalsAllTime(derived);
    el.heroSpent.textContent = money(t.spent);

    // datalist
    el.productList.innerHTML = Object.values(derived)
      .map((p) => `<option value="${escapeHtml(p.name)}"></option>`)
      .join("");

    // recent purchases (latest 6)
    const purchases = state.data.transactions
      .filter((t) => t.type === "purchase")
      .slice(-6)
      .reverse();
    el.recentPurchases.innerHTML = purchases.length
      ? purchases.map((t) => txnRow(t)).join("")
      : '<li class="empty">No purchases yet.</li>';
  }

  function txnRow(t) {
    const isP = t.type === "purchase";
    const date = new Date(t.at).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const amt = isP
      ? `<span class="txn-amt plus">+${money(t.cost)}</span>`
      : `<span class="txn-amt minus">−${fmtQty(t.qty)} ${t.unit}</span>`;
    return `
      <li class="txn-item ${isP ? "is-purchase" : "is-usage"}" data-txn="${t.id}">
        <span class="txn-badge">${isP ? "▲" : "▼"}</span>
        <div class="txn-main">
          <div class="txn-name">${escapeHtml(t.name)}</div>
          <div class="txn-meta">${isP ? `Bought ${fmtQty(t.qty)} ${t.unit}` : "Used"} · ${date}</div>
        </div>
        ${amt}
      </li>`;
  }

  function renderReports(derived) {
    const cur = monthlyTotals(state.month, derived);
    const prevMk = addMonths(state.month, -1);
    const prev = monthlyTotals(prevMk, derived);

    const l = ledgerFor(state.month, derived);
    el.mUsed.textContent = money(l.owed);
    el.mSpent.textContent = money(cur.spent);
    setDelta(el.mUsedDelta, cur.used, prev.used);
    setDelta(el.mSpentDelta, cur.spent, prev.spent);

    renderLedgerCard(l);
    renderReimburseChart(derived);
    renderCompareChart(derived);
    renderHistory();
    el.historyTitle.textContent = `${monthShort(state.month)} Activity`;
  }

  function renderLedgerCard(l) {
    el.ledgerTitle.textContent = `${monthName(state.month)} · Katha`;
    el.ledgerStatus.textContent = l.closed ? "Closed" : "Open";
    el.ledgerStatus.className = "badge " + (l.closed ? "badge-closed" : "badge-open");

    const rows = [
      row("Used this month", money(l.used)),
    ];
    if (l.carryIn > 0.005) rows.push(row("Carried over (due)", money(l.carryIn)));
    rows.push(row("Total to reimburse", money(l.owed), "total"));
    if (l.closed) {
      rows.push(row("Reimbursed", money(l.reimbursed), "settled"));
      rows.push(row("Outstanding", money(l.due), l.due > 0.005 ? "due" : "settled"));
    }
    el.ledgerRows.innerHTML = rows.join("");

    const canClose = !l.closed && state.month <= currentMonthKey();
    el.closeMonthBtn.classList.toggle("hidden", !canClose);
    el.reopenMonthBtn.classList.toggle("hidden", !l.closed);
  }

  const row = (label, val, cls = "") =>
    `<div class="ledger-row ${cls}"><span class="lr-label">${label}</span><span class="lr-val">${val}</span></div>`;

  function setDelta(node, cur, prev) {
    if (prev <= 0 && cur <= 0) {
      node.textContent = "";
      node.className = "delta flat";
      return;
    }
    if (prev <= 0) {
      node.textContent = "▲ new";
      node.className = "delta up";
      return;
    }
    const pct = ((cur - prev) / prev) * 100;
    const rounded = Math.round(pct);
    if (rounded === 0) {
      node.textContent = "▬ 0% vs last mo";
      node.className = "delta flat";
    } else if (rounded > 0) {
      node.textContent = `▲ ${rounded}% vs last mo`;
      node.className = "delta up";
    } else {
      node.textContent = `▼ ${Math.abs(rounded)}% vs last mo`;
      node.className = "delta down";
    }
  }

  function renderReimburseChart(derived) {
    const months = lastNMonths(6);
    const vals = months.map((mk) => monthlyTotals(mk, derived).used);
    const max = Math.max(...vals, 1);
    const any = vals.some((v) => v > 0);
    if (!any) {
      el.chartReimburse.innerHTML = '<div class="chart-empty">No data yet.</div>';
      return;
    }
    el.chartReimburse.innerHTML = months
      .map((mk, i) => {
        const h = Math.max(3, (vals[i] / max) * 100);
        return `
          <div class="chart-col">
            <span class="bar-val">${vals[i] ? shortMoney(vals[i]) : ""}</span>
            <div class="bar-wrap">
              <div class="bar bar-reimburse" style="height:${h}%"></div>
            </div>
            <span class="bar-label">${monthShort(mk)}</span>
          </div>`;
      })
      .join("");
  }

  function renderCompareChart(derived) {
    const months = lastNMonths(6);
    const rows = months.map((mk) => monthlyTotals(mk, derived));
    const max = Math.max(...rows.flatMap((r) => [r.spent, r.used]), 1);
    const any = rows.some((r) => r.spent > 0 || r.used > 0);
    if (!any) {
      el.chartCompare.innerHTML = '<div class="chart-empty">No data yet.</div>';
      return;
    }
    el.chartCompare.innerHTML = months
      .map((mk, i) => {
        const hs = Math.max(3, (rows[i].spent / max) * 100);
        const hu = Math.max(3, (rows[i].used / max) * 100);
        return `
          <div class="chart-col">
            <div class="bar-wrap">
              <div class="bar bar-spent" style="height:${hs}%"></div>
              <div class="bar bar-reimburse" style="height:${hu}%"></div>
            </div>
            <span class="bar-label">${monthShort(mk)}</span>
          </div>`;
      })
      .join("");
  }

  function shortMoney(n) {
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return Math.round(n).toString();
  }

  function renderHistory() {
    const items = state.data.transactions
      .filter((t) => monthKeyOf(t.at) === state.month)
      .sort((a, b) => new Date(b.at) - new Date(a.at));
    el.historyList.innerHTML = items.length
      ? items.map((t) => txnRow(t)).join("")
      : '<li class="empty">No activity this month.</li>';
  }

  function renderInventory(derived) {
    const t = totalsAllTime(derived);
    el.heroRemaining.textContent = money(t.remaining);
    el.heroLowcount.textContent = t.low
      ? `${t.low} item${t.low > 1 ? "s" : ""} low on stock`
      : "All items well stocked";

    let products = Object.values(derived);
    const q = state.invQuery.trim().toLowerCase();
    if (q) products = products.filter((p) => p.name.toLowerCase().includes(q));
    products.sort((a, b) => a.name.localeCompare(b.name));

    if (!products.length) {
      el.inventoryList.innerHTML = q
        ? '<li class="empty">No products match your search.</li>'
        : '<li class="empty">No inventory yet. Add a purchase to begin.</li>';
      return;
    }

    el.inventoryList.innerHTML = products
      .map((p) => {
        const value = p.remaining * p.avgCost;
        const out = p.remaining <= 0;
        const isLow = p.threshold > 0 && p.remaining <= p.threshold && !out;
        const pct = p.purchasedQty > 0
          ? Math.max(0, Math.min(100, (p.remaining / p.purchasedQty) * 100))
          : 0;
        const badge = out
          ? '<span class="badge badge-out">Out of stock</span>'
          : isLow
          ? '<span class="badge badge-low">Low stock</span>'
          : '<span class="badge badge-ok">In stock</span>';
        return `
          <li class="inv-item ${isLow || out ? "low" : ""}">
            <div class="inv-top">
              <div>
                <div class="inv-name">${escapeHtml(p.name)}</div>
                <div class="inv-meta">${money(p.avgCost)} / ${p.unit} · used ${fmtQty(
          p.usedQty
        )} of ${fmtQty(p.purchasedQty)}</div>
              </div>
              <div class="inv-value">
                <span class="amt">${money(value)}</span>
                <span class="qty">${fmtQty(p.remaining)} ${p.unit} left</span>
              </div>
            </div>
            <div class="stock-bar"><div class="stock-fill" style="width:${pct}%"></div></div>
            <div class="inv-foot">
              ${badge}
              <button class="link-btn" data-thresh="${p.key}">
                ${p.threshold > 0 ? `Reorder ≤ ${fmtQty(p.threshold)}` : "Set reorder level"}
              </button>
            </div>
          </li>`;
      })
      .join("");
  }

  /* ---------- Tabs ---------- */
  function switchTab(name) {
    document
      .querySelectorAll(".tab-panel")
      .forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
    document
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    // Stock is cumulative across all time, so the month bar isn't relevant there.
    el.monthBar.classList.toggle("hidden", name === "inventory");
    el.app.querySelector(".tab-scroll").scrollTo({ top: 0 });
  }

  /* ---------- Load flow ---------- */
  async function loadFromGitHub() {
    setSync("Loading…", "busy");
    try {
      const { data, sha } = await githubGet();
      if (data) {
        state.data = normalizeData(data);
        state.sha = sha;
        setSync("Loaded", "ok");
        setTimeout(() => setSync(null), 1400);
        render();
      } else {
        state.data = { products: {}, transactions: [] };
        state.sha = null;
        render();
        await push("Initialize inventory data.json");
      }
      return true;
    } catch (err) {
      setSync("Load failed", "err");
      toast(err.message, "err");
      return false;
    }
  }

  // Handle both the new format and the older aggregate-based format.
  function normalizeData(data) {
    const out = { products: {}, transactions: [], months: {} };
    if (!data || typeof data !== "object") return out;

    if (data.months && typeof data.months === "object") {
      for (const [mk, rec] of Object.entries(data.months)) {
        if (!rec) continue;
        out.months[mk] = {
          closed: !!rec.closed,
          reimbursed: num(rec.reimbursed),
          closedAt: rec.closedAt || null,
        };
      }
    }

    const legacyAggregates = {};
    if (data.products && typeof data.products === "object") {
      for (const [k, p] of Object.entries(data.products)) {
        out.products[k] = {
          name: String(p.name || k),
          unit: String(p.unit || "pcs"),
          threshold: num(p.threshold),
        };
        // capture legacy aggregate quantities to reconstruct if needed
        legacyAggregates[k] = {
          purchasedQty: num(p.purchasedQty),
          usedQty: num(p.usedQty),
          totalCost: num(p.totalCost),
        };
      }
    }

    if (Array.isArray(data.transactions)) {
      for (const t of data.transactions) {
        const name = String(t.product || t.name || "");
        const k = t.productKey || key(name || "item");
        if (!out.products[k])
          out.products[k] = { name: name || k, unit: String(t.unit || "pcs"), threshold: 0 };
        out.transactions.push({
          id: t.id || uid(),
          type: t.type === "usage" ? "usage" : "purchase",
          product: k,
          name: out.products[k].name,
          qty: num(t.qty),
          unit: String(t.unit || out.products[k].unit),
          cost: num(t.cost),
          at: t.at || new Date().toISOString(),
        });
      }
    }

    // If a product has legacy aggregates but no matching transactions,
    // synthesize opening entries so stock/cost are preserved.
    for (const [k, agg] of Object.entries(legacyAggregates)) {
      const hasTxns = out.transactions.some((t) => t.product === k);
      if (hasTxns || (agg.purchasedQty === 0 && agg.usedQty === 0)) continue;
      const meta = out.products[k];
      if (agg.purchasedQty > 0) {
        out.transactions.push({
          id: uid(),
          type: "purchase",
          product: k,
          name: meta.name,
          qty: agg.purchasedQty,
          unit: meta.unit,
          cost: agg.totalCost,
          at: "2000-01-01T00:00:00.000Z",
        });
      }
      if (agg.usedQty > 0) {
        out.transactions.push({
          id: uid(),
          type: "usage",
          product: k,
          name: meta.name,
          qty: agg.usedQty,
          unit: meta.unit,
          at: "2000-01-02T00:00:00.000Z",
        });
      }
    }
    return out;
  }

  /* ---------- Config modal ---------- */
  function openConfig() {
    const c = state.config || {};
    el.cfgToken.value = c.token || "";
    el.cfgOwner.value = c.owner || "";
    el.cfgRepo.value = c.repo || "";
    el.cfgBranch.value = c.branch || "";
    el.cfgError.classList.add("hidden");
    el.cfgCancel.classList.toggle("hidden", !state.config);
    el.configModal.classList.remove("hidden");
  }
  const closeConfig = () => el.configModal.classList.add("hidden");

  async function handleConfigSave() {
    const cfg = {
      token: el.cfgToken.value.trim(),
      owner: el.cfgOwner.value.trim(),
      repo: el.cfgRepo.value.trim(),
      branch: el.cfgBranch.value.trim(),
    };
    if (!cfg.token || !cfg.owner || !cfg.repo)
      return showErr(el.cfgError, "Token, owner, and repo are all required.");

    el.cfgSave.disabled = true;
    el.cfgSave.textContent = "Connecting…";
    const prevCfg = state.config,
      prevSha = state.sha;
    state.config = cfg;
    state.sha = null;

    const ok = await loadFromGitHub();
    el.cfgSave.disabled = false;
    el.cfgSave.textContent = "Connect";

    if (ok) {
      saveConfig(cfg);
      closeConfig();
      el.app.classList.remove("hidden");
      toast("Connected to GitHub", "ok");
    } else {
      state.config = prevCfg;
      state.sha = prevSha;
      showErr(el.cfgError, "Could not connect. Check the details above.");
    }
  }

  const showErr = (node, msg) => {
    node.textContent = msg;
    node.classList.remove("hidden");
  };

  /* ---------- Edit-transaction modal ---------- */
  function openTxnModal(id) {
    const t = findTxn(id);
    if (!t) return;
    if (isMonthClosed(monthKeyOf(t.at)))
      return toast("That month is closed. Reopen it to edit entries.", "err");
    state.editingId = id;
    const isP = t.type === "purchase";
    el.txnTitle.textContent = isP ? "Edit Purchase" : "Edit Usage";
    el.txnSub.textContent = `${t.name} · ${t.unit}`;
    el.txnQty.value = t.qty;
    el.txnCost.value = isP ? t.cost : "";
    el.txnCostWrap.classList.toggle("hidden", !isP);
    el.txnDate.value = new Date(t.at).toISOString().slice(0, 10);
    el.txnError.classList.add("hidden");
    el.txnModal.classList.remove("hidden");
  }
  const closeTxnModal = () => {
    el.txnModal.classList.add("hidden");
    state.editingId = null;
  };

  async function handleTxnSave() {
    const t = findTxn(state.editingId);
    if (!t) return closeTxnModal();
    const qty = num(el.txnQty.value);
    if (qty <= 0) return showErr(el.txnError, "Quantity must be greater than 0.");
    const cost = t.type === "purchase" ? num(el.txnCost.value) : 0;
    const dateVal = el.txnDate.value;

    const ok = await mutate(() => {
      // validate: editing shouldn't push any product's stock negative
      const backup = { qty: t.qty, cost: t.cost, at: t.at };
      t.qty = qty;
      if (t.type === "purchase") t.cost = cost;
      if (dateVal) {
        const d = new Date(dateVal + "T12:00:00");
        if (!isNaN(d)) t.at = d.toISOString();
      }
      const d = derive();
      if (d[t.product] && d[t.product].remaining < -1e-9) {
        Object.assign(t, backup);
        throw new Error("That change would make stock negative.");
      }
    }, `Edit ${t.type}: ${t.name}`);

    if (ok) {
      closeTxnModal();
      toast("Entry updated", "ok");
    }
  }

  async function handleTxnDelete() {
    const t = findTxn(state.editingId);
    if (!t) return closeTxnModal();
    const ok = await mutate(() => {
      state.data.transactions = state.data.transactions.filter(
        (x) => x.id !== t.id
      );
      const d = derive();
      if (d[t.product] && d[t.product].remaining < -1e-9)
        throw new Error("Can't delete: usage would exceed stock.");
    }, `Delete ${t.type}: ${t.name}`);
    if (ok) {
      closeTxnModal();
      toast("Entry deleted", "ok");
    }
  }

  /* ---------- Threshold modal ---------- */
  function openThreshModal(k) {
    const meta = state.data.products[k];
    if (!meta) return;
    state.threshKey = k;
    el.threshSub.textContent = meta.name;
    el.threshInput.value = meta.threshold || "";
    el.threshModal.classList.remove("hidden");
  }
  const closeThreshModal = () => {
    el.threshModal.classList.add("hidden");
    state.threshKey = null;
  };
  async function handleThreshSave() {
    const k = state.threshKey;
    const meta = state.data.products[k];
    if (!meta) return closeThreshModal();
    const val = num(el.threshInput.value);
    const ok = await mutate(() => {
      meta.threshold = val;
    }, `Set reorder level: ${meta.name}`);
    if (ok) {
      closeThreshModal();
      toast("Reorder level saved", "ok");
    }
  }

  /* ---------- Close / reopen month (katha) ---------- */
  function openCloseModal() {
    const l = ledgerFor(state.month, derive());
    if (l.closed) return;
    el.closeTitle.textContent = `Close ${monthName(state.month)}`;
    const rows = [row("Used this month", money(l.used))];
    if (l.carryIn > 0.005) rows.push(row("Carried over (due)", money(l.carryIn)));
    rows.push(row("Settling now", money(l.owed), "total"));
    el.closeSummary.innerHTML = rows.join("");
    el.closeModal.classList.remove("hidden");
  }
  const closeCloseModal = () => el.closeModal.classList.add("hidden");

  async function confirmCloseMonth() {
    const mk = state.month;
    const l = ledgerFor(mk, derive());
    const ok = await mutate(() => {
      state.data.months = state.data.months || {};
      state.data.months[mk] = {
        closed: true,
        reimbursed: l.owed,
        closedAt: new Date().toISOString(),
      };
    }, `Close month ${mk}`);
    if (ok) {
      closeCloseModal();
      toast(`${monthName(mk)} closed & settled`, "ok");
    }
  }

  async function reopenMonth() {
    const mk = state.month;
    const ok = await mutate(() => {
      if (state.data.months) delete state.data.months[mk];
    }, `Reopen month ${mk}`);
    if (ok) toast(`${monthName(mk)} reopened`, "ok");
  }

  /* ---------- Form handlers ---------- */
  async function handlePurchase(e) {
    e.preventDefault();
    const name = el.pName.value.trim();
    const qty = num(el.pQty.value);
    const unit = el.pUnit.value;
    const cost = num(el.pCost.value);
    if (!name) return toast("Enter a product name.", "err");
    if (qty <= 0) return toast("Quantity must be greater than 0.", "err");
    if (cost < 0) return toast("Cost cannot be negative.", "err");

    const ok = await mutate(
      () => addPurchase(name, qty, unit, cost),
      `Add purchase: ${name}`
    );
    if (ok) {
      el.purchaseForm.reset();
      toast("Purchase added", "ok");
    }
  }

  async function handleUsage(e) {
    e.preventDefault();
    const k = el.uProduct.value;
    const qty = num(el.uQty.value);
    if (!k) return toast("Select a product.", "err");
    if (qty <= 0) return toast("Quantity must be greater than 0.", "err");
    const ok = await mutate(
      () => recordUsage(k, qty, derive()),
      `Record usage: ${state.data.products[k]?.name || k}`
    );
    if (ok) {
      el.usageForm.reset();
      updateUsageHint();
      toast("Usage recorded", "ok");
    }
  }

  async function quickUse(k) {
    const ok = await mutate(
      () => recordUsage(k, 1, derive()),
      `Quick use: ${state.data.products[k]?.name || k}`
    );
    if (ok) toast(`Used 1 ${state.data.products[k]?.unit || ""}`.trim(), "ok");
  }

  /* ---------- Export ---------- */
  function exportData() {
    const blob = new Blob([JSON.stringify(state.data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "inventory-data.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ---------- Event binding ---------- */
  function bindEvents() {
    // config
    el.cfgSave.addEventListener("click", handleConfigSave);
    el.cfgCancel.addEventListener("click", closeConfig);
    el.openConfig.addEventListener("click", openConfig);

    // forms
    el.purchaseForm.addEventListener("submit", handlePurchase);
    el.usageForm.addEventListener("submit", handleUsage);
    el.uProduct.addEventListener("change", () => updateUsageHint());

    // tabs
    document.querySelectorAll(".tab-btn").forEach((b) =>
      b.addEventListener("click", () => switchTab(b.dataset.tab))
    );

    // month switch (global — affects new entries + all views)
    el.monthPrev.addEventListener("click", () => {
      state.month = addMonths(state.month, -1);
      render();
    });
    el.monthNext.addEventListener("click", () => {
      if (state.month >= currentMonthKey()) return;
      state.month = addMonths(state.month, 1);
      render();
    });

    // close / reopen month (Reports tab)
    el.closeMonthBtn.addEventListener("click", openCloseModal);
    el.reopenMonthBtn.addEventListener("click", reopenMonth);
    el.closeConfirm.addEventListener("click", confirmCloseMonth);
    el.closeCancel.addEventListener("click", closeCloseModal);

    // search
    el.invSearch.addEventListener("input", () => {
      state.invQuery = el.invSearch.value;
      renderInventory(derive());
    });

    // export
    el.exportBtn.addEventListener("click", exportData);

    // transaction rows + quick chips + threshold (event delegation)
    document.addEventListener("click", (e) => {
      const txn = e.target.closest("[data-txn]");
      if (txn) return openTxnModal(txn.dataset.txn);
      const quick = e.target.closest("[data-quick]");
      if (quick) return quickUse(quick.dataset.quick);
      const thr = e.target.closest("[data-thresh]");
      if (thr) return openThreshModal(thr.dataset.thresh);
    });

    // txn modal
    el.txnSave.addEventListener("click", handleTxnSave);
    el.txnDelete.addEventListener("click", handleTxnDelete);
    el.txnCancel.addEventListener("click", closeTxnModal);

    // thresh modal
    el.threshSave.addEventListener("click", handleThreshSave);
    el.threshCancel.addEventListener("click", closeThreshModal);

    // close modals on backdrop click
    [el.txnModal, el.threshModal, el.closeModal].forEach((m) =>
      m.addEventListener("click", (e) => {
        if (e.target === m) m.classList.add("hidden");
      })
    );
  }

  async function init() {
    bindEvents();
    switchTab("usage"); // Usage is the default tab
    state.config = loadConfig();
    if (state.config) {
      el.app.classList.remove("hidden");
      await loadFromGitHub();
    } else {
      openConfig();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();

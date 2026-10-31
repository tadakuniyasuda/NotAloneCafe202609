// Not Alone Cafe — debug panel (shared by player, admin and display pages).
//
// Shows what THIS page believes (connection, versions, times, what is on screen)
// next to what the SERVER believes about this same connection, and flags any
// mismatch — which is exactly the "my screen is stuck on old info" symptom.
// Everything is also written to a timestamped log in a text box you can copy.
//
// The 🛠 button shows by default on all pages (bottom-left). Open any page once with
// ?debug=0 to hide it on that device, ?debug=1 to bring it back.

(function () {
  const NAC = window.NAC;
  if (!NAC) return;
  const stats = NAC.stats;

  let enabled = false;
  let built = false;
  let panel, ta, verdictEl, gridEl, clientsEl, autoChk, noteInput, btn;
  let lastDebug = null;
  let lastDebugAt = 0;
  let lastSummary = "";
  let isOpen = false;
  let mismatches = [];

  const css = `
  #nacDbgBtn{position:fixed;left:8px;bottom:8px;z-index:300;width:38px;height:38px;border-radius:50%;border:none;
    background:#2b2b2b;color:#fff;font-size:18px;opacity:.85;box-shadow:0 2px 8px rgba(0,0,0,.3)}
  #nacDbgBtn.faint{opacity:.18}
  #nacDbgBtn.warn{background:#c0392b;opacity:1}
  #nacDbg{position:fixed;left:0;right:0;bottom:0;max-height:86vh;overflow:auto;z-index:301;background:#1e1e1e;color:#e6e6e6;
    font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:10px 12px 14px;display:none;border-top:2px solid #5B9BC4}
  #nacDbg h3{margin:0;font-size:13px;display:flex;justify-content:space-between;align-items:center}
  #nacDbg .verdict{margin:8px 0;padding:8px 10px;border-radius:8px;font-size:13px;font-weight:700;background:#2a2a2a}
  #nacDbg .verdict.ok{background:#1f4d2b}
  #nacDbg .verdict.warn{background:#6b4a12}
  #nacDbg .verdict.bad{background:#6b1f1f}
  #nacDbg table{width:100%;border-collapse:collapse;margin:6px 0;background:transparent;border-radius:0;overflow:visible}
  #nacDbg td{padding:2px 6px;vertical-align:top;border-bottom:1px solid #333;word-break:break-all;font-size:12px;color:#e6e6e6;text-align:left}
  #nacDbg td:first-child{color:#9ab;white-space:nowrap;width:1%}
  #nacDbg select,#nacDbg input{font-size:12px}
  #nacDbg .row{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;align-items:center}
  #nacDbg button{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid #555;background:#333;color:#fff}
  #nacDbg button.pri{background:#5B9BC4;border-color:#5B9BC4}
  #nacDbg input[type=text]{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid #555;background:#111;color:#fff;flex:1;min-width:120px}
  #nacDbg textarea{width:100%;height:170px;background:#111;color:#cfe;border:1px solid #444;border-radius:8px;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;padding:6px;box-sizing:border-box}
  #nacDbg pre{margin:4px 0;white-space:pre-wrap;color:#cfe}
  #nacDbg .sub{color:#9ab;margin-top:8px}
  `;

  function ago(t) {
    if (!t) return "-";
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 120) return `${s}秒前`;
    return `${Math.floor(s / 60)}分${s % 60}秒前`;
  }
  function hms(t) { return t ? NAC.ts(new Date(t)).slice(0, 8) : "-"; }
  
  function build() {
    if (built) return;
    built = true;
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);

    btn = document.createElement("button");
    btn.id = "nacDbgBtn";
    btn.textContent = "🛠";
    btn.setAttribute("aria-label", "debug");
    if (stats.role === "display") btn.classList.add("faint");
    btn.addEventListener("click", toggle);
    document.body.appendChild(btn);

    panel = document.createElement("div");
    panel.id = "nacDbg";
    panel.innerHTML = `
      <h3><span>🛠 デバッグ (${stats.role})</span><button id="nacDbgClose">閉じる</button></h3>
      <div class="verdict" id="nacDbgVerdict">...</div>
      <table id="nacDbgGrid"></table>
      <div class="row">
        <button class="pri" id="nacDbgQuery">サーバーに照会</button>
        <button id="nacDbgReconn">強制再接続</button>
        <button id="nacDbgReload">再読み込み</button>
        <label><input type="checkbox" id="nacDbgAuto" checked> 15秒ごとに自動照会</label>
      </div>
      <div class="row">
        <input type="text" id="nacDbgNote" placeholder="メモ（例: 画面ロック10分 → 復帰）" />
        <button id="nacDbgAddNote">メモ追加</button>
      </div>
      <div class="row">
        <button class="pri" id="nacDbgCopy">ログ＋状態をコピー</button>
        <button id="nacDbgClear">ログ消去</button>
      </div>
      <textarea id="nacDbgLog" spellcheck="false"></textarea>
      <div id="nacDbgClients"></div>`;
    document.body.appendChild(panel);

    ta = panel.querySelector("#nacDbgLog");
    verdictEl = panel.querySelector("#nacDbgVerdict");
    gridEl = panel.querySelector("#nacDbgGrid");
    clientsEl = panel.querySelector("#nacDbgClients");
    autoChk = panel.querySelector("#nacDbgAuto");
    noteInput = panel.querySelector("#nacDbgNote");

    ta.value = NAC.logs.join("\n") + "\n";
    ta.scrollTop = ta.scrollHeight;

    panel.querySelector("#nacDbgClose").addEventListener("click", toggle);
    panel.querySelector("#nacDbgQuery").addEventListener("click", () => query(true));
    panel.querySelector("#nacDbgReconn").addEventListener("click", () => NAC.reconnect("手動(デバッグ)"));
    panel.querySelector("#nacDbgReload").addEventListener("click", () => location.reload());
    panel.querySelector("#nacDbgClear").addEventListener("click", () => { NAC.logs = []; try { sessionStorage.removeItem("nac_log"); } catch (e) {} ta.value = ""; });
    panel.querySelector("#nacDbgAddNote").addEventListener("click", addNote);
    noteInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addNote(); });
    panel.querySelector("#nacDbgCopy").addEventListener("click", copyAll);

    NAC.on("log", (line) => {
      ta.value += line + "\n";
      if (ta.value.length > 60000) ta.value = ta.value.slice(-50000);
      ta.scrollTop = ta.scrollHeight;
    });
    NAC.on("debugInfo", onDebugInfo);
    NAC.on("sendfail", () => flagBtn());

    setInterval(refresh, 1000);
    // Background check so problems are caught even while the panel is closed.
    setInterval(() => { if (autoChk.checked) query(false); }, 15000);
    refresh();
  }

  function addNote() {
    const v = noteInput.value.trim();
    if (!v) return;
    NAC.log(`📝 メモ: ${v}`);
    noteInput.value = "";
  }

  function toggle() {
    isOpen = !isOpen;
    panel.style.display = isOpen ? "block" : "none";
    if (isOpen) { refresh(); ta.scrollTop = ta.scrollHeight; query(false); }
  }

  function flagBtn() { if (btn) btn.classList.add("warn"); }

  function query(manual) {
    if (!NAC.send({ type: "debug" }) && manual) NAC.log("照会できません: 未接続");
  }

  function clientView() {
    try { return NAC.getClientView ? NAC.getClientView() : null; } catch (e) { return null; }
  }

  function onDebugInfo(d) {
    lastDebug = d;
    lastDebugAt = Date.now();
    const view = clientView();
    mismatches = [];
    if (d.stateVersion !== stats.lastV) mismatches.push(`状態バージョン: 自分=${stats.lastV} / サーバー=${d.stateVersion} (更新を取りこぼし)`);
    if (d.instance !== stats.instance) mismatches.push(`サーバー instance が違う (自分が知っている=${stats.instance} / 今=${d.instance})`);
    if (d.build !== stats.serverBuild && stats.serverBuild) mismatches.push(`ビルドが違う`);
    if (stats.role === "player") {
      if (!d.you.tokenKnown) mismatches.push("サーバーはこの端末を知りません (再起動/リセット後?)");
      else {
        if (d.you.connectedFlag === false) mismatches.push("サーバー上でこの端末が「切断」扱い");
        if (d.you.thisSocketIsRegistered === false) mismatches.push("この接続がサーバーに登録されていません");
        if (view && (view.group || null) !== (d.you.group || null)) mismatches.push(`チーム: 画面=${view.group || "なし"} / サーバー=${d.you.group || "なし"}`);
        if (view && (view.vibe || null) !== (d.you.vibe || null)) mismatches.push(`気分: 画面=${view.vibe || "なし"} / サーバー=${d.you.vibe || "なし"}`);
      }
    }
    if (view && view.question !== undefined && d.question !== undefined && view.question !== d.question) {
      mismatches.push(`テーマ: 画面="${view.question}" / サーバー="${d.question}"`);
    }
    const summary = `v=${stats.lastV}/${d.stateVersion} group=${view && view.group !== undefined ? view.group : "-"}/${d.you && d.you.group !== undefined ? d.you.group : "-"} ghosts=${d.ghosts} sockets=${d.openSockets} up=${d.uptimeSec}s`;
    if (mismatches.length) {
      flagBtn();
      NAC.log(`❌ 食い違い: ${mismatches.join(" | ")}  [${summary}]`);
    } else if (summary !== lastSummary || isOpen) {
      if (summary !== lastSummary) NAC.log(`✅ 照会OK  [${summary}]`);
    }
    lastSummary = summary;
    if (d.clients) renderClients(d.clients);
    refresh();
  }

  function renderClients(list) {
    const rows = list.map((c) =>
      `${(c.tag || "").padEnd(4)} team=${c.group || "-"} vibe=${(c.vibe || "-").padEnd(6)} flag=${c.connectedFlag ? "接続" : "切断"} ws=${c.wsOpen ? "OPEN" : "closed"} 無通信=${c.silentSec}s conn=${c.connId} tok=${c.token}`
    );
    clientsEl.innerHTML = `<div class="sub">サーバー側の参加者一覧 (${list.length}人)</div><pre>${rows.join("\n") || "(なし)"}</pre>`;
  }

  function verdict() {
    const now = Date.now();
    if (stats.state !== "open") return ["bad", `🔴 未接続 (${stats.state})`];
    if (now - stats.lastMsgAt > 20000) return ["warn", `🟠 サーバーから ${Math.round((now - stats.lastMsgAt) / 1000)} 秒間無通信`];
    if (mismatches.length && now - lastDebugAt < 40000) return ["bad", `🔴 サーバーと食い違い: ${mismatches[0]}`];
    return ["ok", "🟢 接続OK・最新"];
  }

  function rowsHtml() {
    const d = lastDebug;
    const view = clientView();
    const kv = [
      ["ロール", stats.role],
      ["ビルド", `ページ ${NAC.build} / サーバー ${stats.serverBuild || "-"}${stats.serverBuild && stats.serverBuild !== NAC.build ? "  ⚠違う" : ""}`],
      ["サーバー instance", `${stats.instance || "-"}${d ? `  (稼働 ${Math.floor(d.uptimeSec / 60)}分${d.uptimeSec % 60}秒)` : ""}`],
      ["接続状態", `${stats.state}`],
      ["接続ID", `クライアント ${stats.clientConnId || "-"} / サーバー ${stats.serverConnId || "-"}`],
      ["カード / トークン", `${stats.tag || "-"}  /  ${stats.token ? stats.token.slice(0, 8) + "…" : "-"}`],
      ["ページ読み込み", `${hms(stats.pageLoadedAt)} (${ago(stats.pageLoadedAt)})`],
      ["接続した時刻", `${hms(stats.openedAt)} (${ago(stats.openedAt)})`],
      ["最終受信", `${stats.lastMsgType || "-"}  ${ago(stats.lastMsgAt)}`],
      ["最終 tick / pong", `${ago(stats.lastTickAt)} / ${ago(stats.lastPongAt)}  RTT=${stats.rtt == null ? "-" : stats.rtt + "ms"}`],
      ["状態バージョン", `自分 ${stats.lastV} / 直近tick ${stats.tickV}${d ? ` / 照会時サーバー ${d.stateVersion}` : ""}`],
      ["再接続 / 確認 / watchdog", `${stats.reconnects} / ${stats.probes} / ${stats.watchdogTrips}   (タイマー停止検出 ${stats.wakeGaps}, sync ${stats.syncs})`],
      ["送信 / 受信", `${stats.sent} / ${stats.recv}`],
      ["表示 / ネット", `${stats.visibility} / ${stats.online ? "online" : "offline"}`],
      ["直近の切断", stats.closes.length ? stats.closes.slice(-3).map((c) => `${c.t.slice(0, 8)} code=${c.code}`).join(", ") : "なし"],
      ["画面の認識", view ? JSON.stringify(view) : "-"],
    ];
    if (d) {
      kv.push(["サーバーの認識", d.you ? JSON.stringify(d.you) : "-"]);
      kv.push(["サーバー全体", `接続中ソケット ${d.openSockets} / 登録参加者 ${d.registeredAttendees} / 接続扱い ${d.flaggedConnected} / 有効 ${d.activeAttendees} (離席${d.graceMin}分まで) / ghost ${d.ghosts}`]);
      kv.push(["最後の照会", ago(lastDebugAt)]);
    } else {
      kv.push(["サーバーの認識", "（「サーバーに照会」を押すと表示）"]);
    }
    return kv.map(([k, v]) => `<tr><td>${k}</td><td>${String(v).replace(/</g, "&lt;")}</td></tr>`).join("");
  }

  function refresh() {
    if (!built) return;
    const [cls, text] = verdict();
    if (btn) {
      if (cls === "bad" || cls === "warn") btn.classList.add("warn");
      else if (!mismatches.length) btn.classList.remove("warn");
    }
    if (!isOpen) return;
    verdictEl.className = "verdict " + cls;
    verdictEl.textContent = text;
    gridEl.innerHTML = rowsHtml();
  }

  function snapshotText() {
    const view = clientView();
    return [
      "=== Not Alone Cafe debug ===",
      `time: ${new Date().toString()}`,
      `url: ${location.href.replace(/key=[^&]*/, "key=***")}`,
      `ua: ${navigator.userAgent}`,
      `role: ${stats.role}  page build: ${NAC.build}  server build: ${stats.serverBuild}`,
      `instance: ${stats.instance}  card: ${stats.tag || "-"}  token: ${stats.token ? stats.token.slice(0, 8) : "-"}  connIds: ${stats.clientConnId}/${stats.serverConnId}`,
      `state: ${stats.state}  lastV: ${stats.lastV}  tickV: ${stats.tickV}  lastMsg: ${stats.lastMsgType} ${ago(stats.lastMsgAt)}`,
      `reconnects: ${stats.reconnects}  probes: ${stats.probes}  watchdog: ${stats.watchdogTrips}  wakeGaps: ${stats.wakeGaps}  syncs: ${stats.syncs}`,
      `client view: ${view ? JSON.stringify(view) : "-"}`,
      `server view: ${lastDebug ? JSON.stringify({ you: lastDebug.you, v: lastDebug.stateVersion, up: lastDebug.uptimeSec, ghosts: lastDebug.ghosts, sockets: lastDebug.openSockets }) : "(not queried)"}`,
      "--- log ---",
    ].join("\n");
  }

  function copyAll() {
    const text = snapshotText() + "\n" + ta.value;
    const done = () => NAC.log("ログをコピーしました");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const prev = ta.value;
    ta.value = text;
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { NAC.log("コピー失敗: 文字を手動で選んでコピーしてください"); }
    setTimeout(() => { ta.value = prev; }, 50);
  }

  // Called by each page right after NAC.start(...)
  // The button is shown by default on every page while the app is being proven out.
  // To hide it later on a given device open the page once with ?debug=0 (remembered);
  // ?debug=1 brings it back.
  NAC.initDebug = function (role) {
    try {
      const q = new URLSearchParams(location.search).get("debug");
      if (q === "0") localStorage.setItem("nac_debug_off", "1");
      if (q === "1") localStorage.removeItem("nac_debug_off");
      enabled = localStorage.getItem("nac_debug_off") !== "1";
    } catch (e) { enabled = true; }
    if (!enabled) return;
    const go = () => build();
    if (document.body) go(); else document.addEventListener("DOMContentLoaded", go);
  };
})();

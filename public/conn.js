// Not Alone Cafe — shared connection layer for the player, admin and display pages.
//
// Why this exists: a phone page can look connected while its WebSocket is dead
// (screen locked, Wi-Fi <-> mobile switch, server restarted). The old per-page
// code waited for the browser to say "closed", which can take a minute or more.
// This layer does not trust the browser:
//   * Watchdog: if nothing arrives from the server for 16 s, throw the socket
//     away and open a fresh one (no waiting for a close event).
//   * Wake detection: when the page becomes visible / comes back online / its
//     timers were frozen for >6 s, immediately check the connection and ask the
//     server for the full current state ("sync").
//   * State version: the server's 10-second tick carries a version number. If it
//     differs from the last state we received, we missed something -> sync.
//   * Old sockets are fully detached, so a late event from a dead socket can
//     never touch the page.
//   * If the server was deployed with new page code, open pages reload themselves.
//
// Everything is logged (NAC.log) for the debug panel.

(function () {
  const BUILD = "__BUILD__"; // filled in by server.js when it serves this file
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const LOG_KEY = "nac_log";
  const MAX_LOG = 250;

  const NAC = (window.NAC = {
    build: BUILD,
    stats: {
      role: "",
      pageLoadedAt: Date.now(),
      state: "init", // init | connecting | open | closed
      sockSeq: 0,
      clientConnId: "",
      serverConnId: "",
      token: "",
      tag: "",
      instance: "",
      serverBuild: "",
      openedAt: 0,
      lastMsgAt: 0,
      lastMsgType: "",
      lastTickAt: 0,
      lastPongAt: 0,
      rtt: null,
      lastV: null, // last state version we received
      tickV: null, // version the server announced in its last tick
      reconnects: 0,
      recv: 0,
      sent: 0,
      probes: 0,
      watchdogTrips: 0,
      wakeGaps: 0,
      syncs: 0,
      closes: [],
      visibility: document.visibilityState,
      online: navigator.onLine,
    },
    logs: [],
    listeners: {},
    getClientView: null, // pages set this: () => ({...what the page currently shows})
  });
  const stats = NAC.stats;

  // ---------- tiny event emitter ----------
  NAC.on = (name, fn) => { (NAC.listeners[name] = NAC.listeners[name] || []).push(fn); };
  function emit(name, arg) { (NAC.listeners[name] || []).forEach((fn) => { try { fn(arg); } catch (e) { /* keep going */ } }); }

  // ---------- logging (kept across reloads in sessionStorage) ----------
  function ts(d) {
    const p = (n, l = 2) => String(n).padStart(l, "0");
    d = d || new Date();
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }
  NAC.ts = ts;
  function saveLogs() {
    try { sessionStorage.setItem(LOG_KEY, JSON.stringify(NAC.logs.slice(-MAX_LOG))); } catch (e) { /* storage may be blocked */ }
  }
  NAC.log = function (text) {
    const line = `${ts()} ${text}`;
    NAC.logs.push(line);
    if (NAC.logs.length > MAX_LOG) NAC.logs.shift();
    saveLogs();
    emit("log", line);
  };
  try {
    const prev = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]");
    if (Array.isArray(prev) && prev.length) {
      NAC.logs = prev.concat(["---------- ページを読み込み直しました ----------"]);
    }
  } catch (e) { /* ignore */ }

  // ---------- internals ----------
  let cfg = null;
  let ws = null;
  let reconnectTimer = null;
  let overlayTimer = null;
  let attempt = 0;
  let connectingSince = 0;
  let lastWatch = Date.now();
  let lastSyncAt = 0;
  let halted = false; // true when another tab took over this player: stop, don't fight for it

  function overlayEl() { return document.getElementById("connOverlay"); }
  function scheduleOverlay() {
    if (overlayTimer) return;
    // Show the "reconnecting" cover only if we are still down after 2.5 s, so quick
    // silent reconnects don't flash a scary screen at people.
    overlayTimer = setTimeout(() => {
      const el = overlayEl();
      if (el && stats.state !== "open") el.style.display = "flex";
    }, 2500);
  }
  function hideOverlay() {
    if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
    const el = overlayEl();
    if (el) el.style.display = "none";
  }

  function abandon(sock, why) {
    // Detach everything first so nothing this dead socket does later can reach the page.
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    try { sock.close(); } catch (e) { /* ignore */ }
    NAC.log(`旧ソケットを破棄 (${why})`);
  }

  function sendJSON(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      stats.sent++;
      return true;
    }
    return false;
  }
  NAC.send = function (obj) {
    const ok = sendJSON(obj);
    if (!ok) {
      NAC.log(`送信できませんでした (未接続): ${obj.type}`);
      emit("sendfail", obj);
    }
    return ok;
  };

  function requestSync(why) {
    const now = Date.now();
    if (now - lastSyncAt < 1500) return; // don't flood
    lastSyncAt = now;
    stats.syncs++;
    NAC.log(`最新状態を要求 sync (${why})`);
    sendJSON({ type: "sync" });
  }

  function open(reason) {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { abandon(ws, "作り直し: " + reason); ws = null; }

    const seq = ++stats.sockSeq;
    stats.clientConnId = "c" + seq;
    stats.state = "connecting";
    connectingSince = Date.now();
    NAC.log(`接続開始 #${seq} (${reason})`);

    let sock;
    try {
      sock = new WebSocket(`${proto}//${location.host}${cfg.path}`);
    } catch (e) {
      NAC.log(`new WebSocket 失敗: ${e}`);
      stats.state = "closed";
      scheduleOverlay();
      scheduleReconnect("constructor failed");
      return;
    }
    ws = sock;

    sock.onopen = () => {
      if (sock !== ws) return;
      stats.state = "open";
      stats.openedAt = Date.now();
      stats.lastMsgAt = Date.now();
      attempt = 0;
      hideOverlay();
      NAC.log(`接続OK #${seq}`);
      if (cfg.onOpen) cfg.onOpen(sock);
      emit("open");
    };

    sock.onmessage = (ev) => {
      if (sock !== ws) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      const now = Date.now();
      stats.recv++;
      stats.lastMsgAt = now;
      stats.lastMsgType = msg.type;

      if (msg.instance && stats.instance && msg.instance !== stats.instance) {
        NAC.log(`⚠ サーバーが再起動しました (instance ${stats.instance} → ${msg.instance})`);
      }
      if (msg.instance) stats.instance = msg.instance;
      if (msg.build) {
        stats.serverBuild = msg.build;
        if (msg.build !== BUILD) reloadForNewBuild(msg.build);
      }

      if (msg.type === "pong") {
        stats.lastPongAt = now;
        if (msg.t) stats.rtt = now - msg.t;
        return;
      }
      if (msg.type === "tick") {
        stats.lastTickAt = now;
        stats.tickV = msg.v;
        if (stats.lastV !== null && msg.v !== stats.lastV) {
          NAC.log(`状態バージョン不一致 自分=${stats.lastV} サーバー=${msg.v} → 再同期`);
          requestSync("version mismatch");
        }
        return;
      }
      if (msg.type === "welcome") {
        if (msg.token) stats.token = msg.token;
        if (msg.tag) stats.tag = msg.tag;
        if (msg.connId) stats.serverConnId = msg.connId;
      }
      if ((msg.type === "welcome" || msg.type === "state" || msg.type === "adminState") && msg.v != null) {
        stats.lastV = msg.v;
      }
      if (msg.type === "debugInfo") emit("debugInfo", msg);

      if (cfg.onMessage) cfg.onMessage(msg);
    };

    sock.onclose = (ev) => {
      if (sock !== ws) return;
      stats.state = "closed";
      stats.closes.push({ t: ts(), code: ev.code, reason: ev.reason || "", clean: ev.wasClean });
      if (stats.closes.length > 6) stats.closes.shift();
      NAC.log(`切断 code=${ev.code} reason="${ev.reason || ""}" clean=${ev.wasClean}`);
      if (ev.code === 4000) {
        // Server closed us because the same player (same browser storage) opened this page in
        // another tab. Reconnecting would just kick that tab out again, forever.
        halted = true;
        NAC.log("⚠ 同じ参加者が別のタブ/画面で開かれたため、この画面は停止しました");
        const el = overlayEl();
        if (el) {
          const m = el.querySelector(".msg");
          if (m) m.innerHTML = "この参加者は別のタブ／画面で開かれています。<br>こちらで続けるには「今すぐ再読み込み」を押してください。";
          el.style.display = "flex";
        }
        emit("close");
        return;
      }
      scheduleOverlay();
      emit("close");
      scheduleReconnect(`closed ${ev.code}`);
    };

    sock.onerror = () => {
      if (sock !== ws) return;
      NAC.log("ソケットエラー");
    };
  }

  function scheduleReconnect(why) {
    if (reconnectTimer) return;
    attempt++;
    stats.reconnects++;
    const base = Math.min(500 * Math.pow(2, attempt - 1), 8000);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    NAC.log(`${delay}ms 後に再接続 (試行 ${attempt}, ${why})`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; open(why); }, delay);
  }

  // Ask "are you there?" and, if the server stays silent for 4 s, replace the socket.
  function probe(why) {
    if (halted) return;
    stats.probes++;
    if (ws && ws.readyState === WebSocket.CONNECTING) return; // already connecting; the watchdog covers a stuck attempt
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      NAC.log(`確認(${why}): 接続が開いていない → 再接続`);
      scheduleOverlay();
      if (!reconnectTimer) open(`probe ${why}`);
      return;
    }
    const t = Date.now();
    const sock = ws;
    sendJSON({ type: "ping", t });
    requestSync(`probe ${why}`);
    setTimeout(() => {
      if (sock === ws && stats.lastMsgAt < t) {
        stats.watchdogTrips++;
        NAC.log(`⚠ 確認(${why}) に4秒以内の応答なし → ソケットを作り直し`);
        scheduleOverlay();
        open(`probe timeout (${why})`);
      }
    }, 4000);
  }

  function reloadForNewBuild(serverBuild) {
    // The server now serves newer page code than this open page is running.
    try {
      const last = Number(sessionStorage.getItem("nac_reload_at") || 0);
      if (Date.now() - last < 30000) return; // never loop
      sessionStorage.setItem("nac_reload_at", String(Date.now()));
    } catch (e) { /* ignore */ }
    NAC.log(`新しいバージョンを検出 (このページ ${BUILD} / サーバー ${serverBuild}) → 再読み込み`);
    setTimeout(() => location.reload(), 600);
  }

  function watchdog() {
    if (halted) { lastWatch = Date.now(); return; }
    const now = Date.now();
    const gap = now - lastWatch;
    lastWatch = now;
    if (gap > 6000) {
      stats.wakeGaps++;
      NAC.log(`⏰ タイマーが約${Math.round(gap / 1000)}秒止まっていました (スリープ/バックグラウンド)`);
      probe("timer gap");
    }
    if (!ws) return;
    if (ws.readyState === WebSocket.CONNECTING && now - connectingSince > 8000) {
      stats.watchdogTrips++;
      NAC.log("接続が8秒以上完了しない → やり直し");
      open("connect timeout");
      return;
    }
    if (ws.readyState === WebSocket.OPEN && now - stats.lastMsgAt > 16000) {
      stats.watchdogTrips++;
      NAC.log(`⚠ サーバーから ${Math.round((now - stats.lastMsgAt) / 1000)} 秒間何も届かない → ソケットを作り直し`);
      scheduleOverlay();
      open("silent 16s");
      return;
    }
    if ((ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) && !reconnectTimer) {
      scheduleOverlay();
      open("socket not open");
    }
  }

  NAC.start = function (config) {
    cfg = config;
    stats.role = config.role;
    NAC.log(`起動 role=${config.role} build=${BUILD} UA=${navigator.userAgent.slice(0, 90)}`);
    open("start");
    setInterval(watchdog, 2000);
    setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) sendJSON({ type: "ping", t: Date.now() });
    }, 10000);
  };
  NAC.reconnect = function (why) { open(why || "manual"); };

  document.addEventListener("visibilitychange", () => {
    stats.visibility = document.visibilityState;
    NAC.log(`表示状態: ${document.visibilityState}`);
    if (document.visibilityState === "visible" && cfg) probe("visible");
  });
  window.addEventListener("pageshow", (e) => {
    NAC.log(`pageshow (bfcache=${e.persisted})`);
    if (cfg) probe("pageshow");
  });
  window.addEventListener("online", () => {
    stats.online = true;
    NAC.log("ネットワーク: online");
    if (cfg) probe("online");
  });
  window.addEventListener("offline", () => {
    stats.online = false;
    NAC.log("ネットワーク: offline");
  });
  window.addEventListener("focus", () => { if (cfg) probe("focus"); });
})();

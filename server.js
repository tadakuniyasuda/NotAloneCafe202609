// Not Alone Cafe — live event grouping server
//
// - Attendees pick a color/vibe (self-expression only, does not affect team).
// - Team assignment is always balance-driven.
// - Admin can run a schedule of auto-shuffles (new teams + new discussion
//   topic at set times), edit that schedule freely, trigger a shuffle
//   manually, and override any individual's team at any time.
// - Topics are organised in CATEGORIES. Admin can pick a topic by hand, ask for
//   a random topic from one category, or choose which category the auto-shuffle
//   draws from.
// - The shuffle algorithm tries to avoid re-pairing people who have already
//   shared a team earlier in the event.
// - A public /display.html page (no admin key) shows a read-only live status
//   screen (QR code + current topic + team sizes). It never shows names/tags.
// - Nothing is stored permanently. All state resets when the server restarts
//   (on Render's free tier that happens after ~15 min idle and on every deploy).
//
// RELIABILITY NOTES (added after real-world "stuck screen" reports)
// - stateVersion: a counter bumped on every broadcast. Every client can compare
//   the version it last saw with the one in the periodic "tick" and ask for a
//   resync if it missed something.
// - Server heartbeat: protocol ping + app-level tick every 10 s. Sockets that
//   don't answer are terminated, so "ghost" attendees don't linger.
// - A reconnect replaces the old socket; the OLD socket's late "close" event
//   can no longer mark the live connection as disconnected.
// - If a phone comes back with a token this server doesn't know (server was
//   restarted), the welcome message says identityLost:true so the page can
//   quietly re-join instead of showing a team that no longer exists.

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "notalone2026"; // change before deploying!
const PUBLIC_DIR = path.join(__dirname, "public");

// ---- Edit this when the next event changes. It is sent to every page, so the
// ---- player footer, the display screen and the "event over" message all
// ---- update from this one place. (The HTML files only hold a fallback copy
// ---- that shows for a moment before the first connection.)
const NEXT_EVENT = { date: "12月6日（日）", time: "14:00〜17:00", place: "九州男" };

const ALL_TEAMS = ["A", "B", "C", "D"];
const TEAM_LABELS = { A: "チームA", B: "チームB", C: "チームC", D: "チームD" };

// Generic, non-cutesy attendee tags: hiragana + 2-digit number, e.g. "さ08"
const TAG_KANA = ["あ","い","う","え","お","か","き","く","け","こ","さ","し","す","せ","そ","た","ち","つ","て","と"];

// Discussion topics, grouped by category. Server owns this list so scheduled
// auto-shuffles can pick topics themselves; the admin page receives the same
// list on connect (one source of truth). To change topics: edit here, redeploy.
const TOPIC_CATEGORIES = [
  {
    id: "light",
    name: "軽いテーマ",
    topics: [
      "好きな飲み物は？",
      "最近ハマっていることは？",
      "休日は何をして過ごしていますか？",
      "好きな音楽のジャンルは？",
      "好きな映画やドラマは？",
      "今まで行った中で好きな旅行先は？",
      "好きな食べ物、または苦手な食べ物は？",
      "最近見て良かったものは？（映画・本・SNSなど）",
      "もし何でも一つ叶うとしたら？",
      "ペットを飼うなら何を飼いたい？",
      "今年挑戦したいことは？",
    ],
  },
  {
    id: "lgbtq",
    name: "LGBTQ+ / コミュニティ",
    topics: [
      "好きなLGBTQ+の映画・ドラマ・本・漫画は？",
      "好きなアーティストや、勇気をもらったクリエイターは？",
      "「こんなコミュニティスペースがあったらいいな」と思うものは？",
      "初めて「自分は一人じゃない」と感じたのはどんなとき？",
      "「居心地がいい」と感じる場所や人の特徴は？",
      "今の自分に、昔の自分が聞いたら喜ぶことは？",
      "日本で今後こう変わってほしい、と思うことは？",
      "Not Alone Cafeに初めて来たきっかけは？",
    ],
  },
  {
    id: "hobby",
    name: "趣味・好きなこと",
    topics: [
      "最近夢中になっているゲーム・アニメ・漫画は？",
      "推しがいたら教えてください（人でもキャラでも何でも）",
      "無人島に一つだけ持っていくなら？",
      "子どもの頃ハマっていたものは？",
      "最近始めたこと、始めてみたいことは？",
      "人に教えられるくらい得意なことは？",
      "休日にふらっと行きたくなる場所は？",
      "自分へのご褒美は何？",
    ],
  },
  {
    id: "japan",
    name: "日本・日本文化",
    topics: [
      "日本で一番好きな場所、または行ってみたい場所は？",
      "東京で好きな場所は？",
      "好きな日本の食べ物ベスト3は？",
      "四季のなかで一番好きな季節と、その理由は？",
      "外国人の友達を一か所だけ案内するなら？",
      "好きなコンビニ商品は？",
      "日本のお祭りや行事で好きなものは？",
      "「日本っぽい」思い出は？",
    ],
  },
];

let numTeams = 4; // admin-adjustable, 1-4
let currentQuestion = "";
let currentCategory = ""; // category NAME of the current topic ("" for custom / none)
let autoCategory = "all"; // which category auto-shuffles / "shuffle now" draw from
let autoEnabled = true;
let eventWindow = { start: "14:00", end: "17:00" };
let eventOver = false; // admin-set "Event over" state — replaces the player's welcome message
const usedTopics = new Set(); // topics already shown this event (random picks avoid repeats)

// Schedule: list of { id, time: "HH:MM", fired: boolean }. Admin-editable.
let schedule = [
  { id: "s1", time: "15:00", fired: false },
  { id: "s2", time: "15:15", fired: false },
  { id: "s3", time: "15:30", fired: false },
  { id: "s4", time: "15:45", fired: false },
];

// ---- Server identity / versioning (shown on every page's debug panel) ----
const SERVER_STARTED = Date.now();
const INSTANCE_ID = crypto.randomBytes(3).toString("hex"); // changes on every restart
let stateVersion = 0; // bumped on every broadcastState()
let connSeq = 0;

// Build id = hash of the front-end files. It changes only when you deploy new
// page code; open pages compare it to their own copy and reload when it differs.
function computeBuildId() {
  const h = crypto.createHash("sha1");
  for (const f of ["index.html", "admin.html", "display.html", "conn.js", "debug.js"]) {
    try { h.update(fs.readFileSync(path.join(PUBLIC_DIR, f))); } catch { /* file missing: ignore */ }
  }
  return h.digest("hex").slice(0, 8);
}
const BUILD_ID = computeBuildId();

// token -> { tag, group, vibe, ws, isAdmin, isDisplay, connected }
const clients = new Map();

// Tracks how many times each pair of tokens has shared a team, so shuffles
// can avoid repeating pairings. Key: "tokenA|tokenB" (sorted).
const pairHistory = new Map();

const app = express();

// conn.js is served with the build id filled in, so page code and server always
// agree on what "current" means.
app.get("/conn.js", (req, res) => {
  let src = "";
  try { src = fs.readFileSync(path.join(PUBLIC_DIR, "conn.js"), "utf8"); } catch { return res.status(404).end(); }
  res.set("Content-Type", "application/javascript; charset=utf-8");
  res.set("Cache-Control", "no-cache, must-revalidate");
  res.send(src.replace(/__BUILD__/g, BUILD_ID));
});

// Lightweight status endpoint. Also handy for an external uptime pinger if you
// ever want to stop the free tier from sleeping.
app.get("/healthz", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    instance: INSTANCE_ID,
    build: BUILD_ID,
    uptimeSec: Math.round((Date.now() - SERVER_STARTED) / 1000),
    stateVersion,
  });
});

app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      // Pages and scripts must be re-validated every time so a phone never
      // keeps running old code after a deploy.
      if (/\.(html|js)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache, must-revalidate");
    },
  })
);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function activeTeams() {
  return ALL_TEAMS.slice(0, numTeams);
}

function makeTag() {
  const kana = TAG_KANA[Math.floor(Math.random() * TAG_KANA.length)];
  const num = String(Math.floor(Math.random() * 90) + 10);
  return `${kana}${num}`;
}

function makeToken() {
  return crypto.randomBytes(12).toString("hex");
}

function isAttendee(c) {
  return !c.isAdmin && !c.isDisplay;
}

function activeAttendees() {
  return [...clients.entries()].filter(([, c]) => c.connected && isAttendee(c));
}

function teamCounts() {
  const counts = {};
  for (const t of ALL_TEAMS) counts[t] = 0;
  for (const [, c] of activeAttendees()) {
    if (c.group) counts[c.group] = (counts[c.group] || 0) + 1;
  }
  return counts;
}

function capacityPerTeam() {
  const total = activeAttendees().filter(([, c]) => c.group).length;
  return Math.max(1, Math.ceil(total / Math.max(1, numTeams)));
}

function leastFullActiveTeam(counts) {
  const active = activeTeams();
  let best = active[0];
  for (const t of active) {
    if (counts[t] < counts[best]) best = t;
  }
  return best;
}

// Individual voluntary join/re-join: always goes to whichever active team
// currently has the fewest people. Does not consider pairing history — that's
// reserved for the scheduled/manual full shuffle, to keep this instant and simple.
function assignTeam() {
  const counts = teamCounts();
  return leastFullActiveTeam(counts);
}

function pairKey(tokenA, tokenB) {
  return [tokenA, tokenB].sort().join("|");
}

function recordPairings(teamsMap) {
  for (const members of Object.values(teamsMap)) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = pairKey(members[i], members[j]);
        pairHistory.set(key, (pairHistory.get(key) || 0) + 1);
      }
    }
  }
}

// ---- Topics ----

function categoryOfTopic(text) {
  for (const cat of TOPIC_CATEGORIES) if (cat.topics.includes(text)) return cat;
  return null;
}

// Pick a random topic from one category (or "all"). Prefers topics not yet used
// this event; once a category is exhausted it starts over.
function pickTopic(categoryId) {
  const cats =
    categoryId && categoryId !== "all"
      ? TOPIC_CATEGORIES.filter((c) => c.id === categoryId)
      : TOPIC_CATEGORIES;
  const pool = [];
  for (const cat of cats) for (const text of cat.topics) pool.push({ cat, text });
  if (pool.length === 0) return null;

  let fresh = pool.filter((p) => !usedTopics.has(p.text) && p.text !== currentQuestion);
  if (fresh.length === 0) {
    pool.forEach((p) => usedTopics.delete(p.text));
    fresh = pool.filter((p) => p.text !== currentQuestion);
    if (fresh.length === 0) fresh = pool;
  }
  return fresh[Math.floor(Math.random() * fresh.length)];
}

function applyPickedTopic(pick) {
  if (!pick) return;
  currentQuestion = pick.text;
  currentCategory = pick.cat.name;
  usedTopics.add(pick.text);
}

// One greedy attempt: take the people in the given order and put each into the
// active team (among those not yet at capacity) where they'd create the fewest
// repeat pairings with people already placed there. Returns the teams and the
// total "repeat cost" (how many already-met pairs ended up together again).
function greedyPlacement(order, active, capacity) {
  const teamsMap = {};
  active.forEach((t) => (teamsMap[t] = []));
  let cost = 0;
  for (const token of order) {
    const openTeams = active.filter((t) => teamsMap[t].length < capacity);
    const candidates = openTeams.length > 0 ? openTeams : active;

    let bestTeam = candidates[0];
    let bestConflicts = Infinity;
    for (const t of candidates) {
      let conflicts = 0;
      for (const member of teamsMap[t]) {
        conflicts += pairHistory.get(pairKey(token, member)) || 0;
      }
      // Prefer fewer conflicts; break ties toward smaller current size for balance
      if (
        conflicts < bestConflicts ||
        (conflicts === bestConflicts && teamsMap[t].length < teamsMap[bestTeam].length)
      ) {
        bestTeam = t;
        bestConflicts = conflicts;
      }
    }
    teamsMap[bestTeam].push(token);
    cost += bestConflicts;
  }
  return { teamsMap, cost };
}

// Full reshuffle of everyone currently connected & already joined. A single
// greedy pass is quick but can paint itself into a corner, so we run many passes
// from different random orders and keep the one with the fewest repeat pairings
// (stopping early if one has none). With ~20 people this takes a few milliseconds.
const SHUFFLE_ATTEMPTS = 150;
function shuffleAll() {
  const attendees = activeAttendees().filter(([, c]) => c.group);
  if (attendees.length === 0) return;

  const tokens = attendees.map(([token]) => token);
  const active = activeTeams();
  const capacity = Math.max(1, Math.ceil(tokens.length / active.length));

  let best = null;
  for (let attempt = 0; attempt < SHUFFLE_ATTEMPTS; attempt++) {
    const order = tokens.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const result = greedyPlacement(order, active, capacity);
    if (!best || result.cost < best.cost) best = result;
    if (best.cost === 0) break;
  }
  const teamsMap = best.teamsMap;

  for (const [team, members] of Object.entries(teamsMap)) {
    for (const token of members) {
      clients.get(token).group = team;
    }
  }
  recordPairings(teamsMap);

  // Push each attendee their new (possibly unchanged) team directly, so their
  // screen updates without them needing to tap anything.
  for (const token of tokens) {
    sendAssigned(clients.get(token));
  }
}

function sendAssigned(c) {
  if (!c || !c.connected) return;
  send(c.ws, {
    type: "assigned",
    group: c.group,
    label: c.group ? TEAM_LABELS[c.group] : null,
    vibe: c.vibe,
    question: currentQuestion,
    category: currentCategory,
  });
}

function publicState() {
  const counts = teamCounts();
  const cap = capacityPerTeam();
  const teams = {};
  for (const t of ALL_TEAMS) {
    teams[t] = {
      label: TEAM_LABELS[t],
      active: activeTeams().includes(t),
      count: counts[t],
      capacity: cap,
    };
  }
  return {
    type: "state",
    v: stateVersion,
    instance: INSTANCE_ID,
    build: BUILD_ID,
    numTeams,
    teams,
    question: currentQuestion,
    category: currentCategory,
    schedule,
    autoEnabled,
    eventWindow,
    eventOver,
    nextEvent: NEXT_EVENT,
  };
}

function adminState() {
  const roster = activeAttendees().map(([token, c]) => ({
    token,
    tag: c.tag,
    group: c.group,
    vibe: c.vibe,
  }));
  return {
    ...publicState(),
    type: "adminState",
    topicCategories: TOPIC_CATEGORIES,
    autoCategory,
    usedTopics: [...usedTopics],
    roster,
  };
}

function broadcastState() {
  stateVersion++;
  const pub = JSON.stringify(publicState());
  const adm = JSON.stringify(adminState());
  for (const c of clients.values()) {
    if (!c.connected || c.ws.readyState !== WebSocket.OPEN) continue;
    c.ws.send(c.isAdmin ? adm : pub);
  }
}

// Full picture of one attendee for a (re)connecting or re-syncing phone.
function sendWelcome(ws, token, extra = {}) {
  const c = clients.get(token);
  send(ws, {
    type: "welcome",
    token,
    tag: c.tag,
    group: c.group,
    groupLabel: c.group ? TEAM_LABELS[c.group] : null,
    vibe: c.vibe,
    question: currentQuestion,
    category: currentCategory,
    eventOver,
    v: stateVersion,
    instance: INSTANCE_ID,
    build: BUILD_ID,
    connId: ws.connId,
    serverTime: Date.now(),
    ...extra,
  });
}

// What the server believes about this socket + the world. The debug panel on
// each page asks for this and compares it with what the page itself shows.
function debugInfo(ws, token) {
  const me = token ? clients.get(token) : null;
  let open = 0;
  wss.clients.forEach((s) => { if (s.readyState === WebSocket.OPEN) open++; });
  const regs = [...clients.values()].filter(isAttendee);
  const info = {
    type: "debugInfo",
    serverTime: Date.now(),
    instance: INSTANCE_ID,
    build: BUILD_ID,
    startedAt: SERVER_STARTED,
    uptimeSec: Math.round((Date.now() - SERVER_STARTED) / 1000),
    stateVersion,
    question: currentQuestion,
    category: currentCategory,
    eventOver,
    connId: ws.connId,
    openSockets: open,
    registeredAttendees: regs.length,
    flaggedConnected: regs.filter((c) => c.connected).length,
    ghosts: regs.filter((c) => c.connected && c.ws.readyState !== WebSocket.OPEN).length,
    you: me
      ? {
          tokenKnown: true,
          tag: me.tag,
          group: me.group,
          vibe: me.vibe,
          connectedFlag: me.connected,
          thisSocketIsRegistered: me.ws === ws,
        }
      : { tokenKnown: false },
  };
  if (me && me.isAdmin) {
    info.clients = [...clients.entries()].filter(([, c]) => isAttendee(c)).map(([t, c]) => ({
      token: t.slice(0, 6),
      tag: c.tag,
      group: c.group,
      vibe: c.vibe,
      connectedFlag: c.connected,
      wsOpen: c.ws.readyState === WebSocket.OPEN,
      silentSec: Math.round((Date.now() - (c.ws.lastMsgAt || 0)) / 1000),
      connId: c.ws.connId,
    }));
  }
  return info;
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isAdminReq = url.searchParams.get("admin") === "1";
  const isDisplayReq = url.searchParams.get("display") === "1";
  const key = url.searchParams.get("key");

  ws.connId = "s" + (++connSeq).toString(36) + crypto.randomBytes(2).toString("hex");
  ws.isAlive = true;
  ws.lastMsgAt = Date.now();
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", () => { ws.isAlive = true; ws.lastMsgAt = Date.now(); });
  ws.on("error", () => { /* the close event follows; nothing else to do */ });

  // Messages every role understands.
  function handleCommon(msg, token) {
    if (msg.type === "ping") {
      send(ws, { type: "pong", t: msg.t, serverTime: Date.now() });
      return true;
    }
    if (msg.type === "debug") {
      send(ws, debugInfo(ws, token));
      return true;
    }
    return false;
  }

  if (isAdminReq) {
    if (key !== ADMIN_KEY) {
      send(ws, { type: "error", message: "invalid admin key" });
      ws.close();
      return;
    }
    const token = makeToken();
    clients.set(token, { tag: "ADMIN", group: null, vibe: null, ws, isAdmin: true, isDisplay: false, connected: true });
    send(ws, { type: "welcome", token, isAdmin: true, connId: ws.connId, instance: INSTANCE_ID, build: BUILD_ID, v: stateVersion, serverTime: Date.now() });
    send(ws, adminState());

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (handleCommon(msg, token)) return;
      if (msg.type === "sync") { send(ws, adminState()); return; }
      handleAdminMessage(msg);
    });
    ws.on("close", () => {
      const c = clients.get(token);
      if (c && c.ws === ws) clients.delete(token);
    });
    return;
  }

  if (isDisplayReq) {
    const token = makeToken();
    clients.set(token, { tag: "DISPLAY", group: null, vibe: null, ws, isAdmin: false, isDisplay: true, connected: true });
    send(ws, { type: "welcome", token, isDisplay: true, connId: ws.connId, instance: INSTANCE_ID, build: BUILD_ID, v: stateVersion, serverTime: Date.now() });
    send(ws, publicState());
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (handleCommon(msg, token)) return;
      if (msg.type === "sync") send(ws, publicState());
    });
    ws.on("close", () => {
      const c = clients.get(token);
      if (c && c.ws === ws) clients.delete(token);
    });
    return;
  }

  // Regular attendee connection
  let token = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (handleCommon(msg, token)) return;

    if (msg.type === "init") {
      let identityLost = false;
      const existing = msg.token ? clients.get(msg.token) : null;
      if (existing && isAttendee(existing)) {
        token = msg.token;
        // A reconnect replaces the old socket. Close the old one explicitly so it
        // can't linger as a ghost; its late "close" event is ignored (see below).
        const old = existing.ws;
        existing.ws = ws;
        existing.connected = true;
        if (old && old !== ws && old.readyState === WebSocket.OPEN) {
          try { old.close(4000, "replaced"); } catch { /* ignore */ }
        }
      } else {
        // Unknown token = this server has no record of the phone. Either a brand-new
        // visitor (msg.token null) or the server was restarted / reset since.
        identityLost = !!msg.token;
        token = makeToken();
        clients.set(token, { tag: makeTag(), group: null, vibe: null, ws, isAdmin: false, isDisplay: false, connected: true });
      }
      sendWelcome(ws, token, { identityLost });
      broadcastState();
      return;
    }

    if (msg.type === "sync") {
      if (!token) return; // this socket has not said "init" yet
      const c = clients.get(token);
      if (!c) { send(ws, { type: "reset" }); return; } // admin reset removed this person
      // This socket just proved it is alive: make sure the server agrees.
      if (c.ws !== ws || !c.connected) { c.ws = ws; c.connected = true; }
      sendWelcome(ws, token, { resync: true });
      send(ws, publicState());
      return;
    }

    if (msg.type === "choose" && token) {
      const c = clients.get(token);
      if (!c) return;
      c.vibe = msg.vibe || null;
      c.group = null;
      c.group = assignTeam();
      sendAssigned(c);
      broadcastState();
      return;
    }
  });

  ws.on("close", () => {
    if (!token) return;
    const c = clients.get(token);
    // Only the CURRENT socket may mark the person as disconnected. A late close
    // from an older, already-replaced socket must not hide a live phone.
    if (c && c.ws === ws) {
      c.connected = false;
      broadcastState(); // so team counts on other screens drop right away
    }
  });
});

function handleAdminMessage(msg) {
  if (msg.type === "move" && msg.token && msg.toGroup) {
    const c = clients.get(msg.token);
    if (c && isAttendee(c) && ALL_TEAMS.includes(msg.toGroup)) {
      c.group = msg.toGroup;
      // Push the change directly to that person's own phone.
      sendAssigned(c);
      broadcastState();
    }
    return;
  }

  if (msg.type === "setNumGroups" && Number.isInteger(msg.value)) {
    numTeams = Math.min(4, Math.max(1, msg.value));
    broadcastState();
    return;
  }

  if (msg.type === "setQuestion" && typeof msg.text === "string") {
    currentQuestion = msg.text.trim();
    // If this is one of the listed topics, remember its category and count it as
    // used. Custom text (or Clear) has no category.
    const cat = currentQuestion ? categoryOfTopic(currentQuestion) : null;
    currentCategory = cat ? cat.name : "";
    if (cat) usedTopics.add(currentQuestion);
    // Any theme change (including Clear) implies the event is running again —
    // this is also what lets admin repeatedly test the "Event over" screen.
    eventOver = false;
    broadcastState();
    return;
  }

  if (msg.type === "randomTopic") {
    const pick = pickTopic(typeof msg.category === "string" ? msg.category : "all");
    applyPickedTopic(pick);
    eventOver = false;
    broadcastState();
    return;
  }

  if (msg.type === "setAutoCategory" && typeof msg.value === "string") {
    if (msg.value === "all" || TOPIC_CATEGORIES.some((c) => c.id === msg.value)) {
      autoCategory = msg.value;
      broadcastState();
    }
    return;
  }

  if (msg.type === "setEventOver" && typeof msg.value === "boolean") {
    eventOver = msg.value;
    broadcastState();
    return;
  }

  if (msg.type === "shuffleNow") {
    applyPickedTopic(pickTopic(autoCategory));
    eventOver = false;
    shuffleAll();
    broadcastState();
    return;
  }

  if (msg.type === "setSchedule" && Array.isArray(msg.items)) {
    schedule = msg.items
      .filter((it) => it && typeof it.time === "string" && /^\d{2}:\d{2}$/.test(it.time))
      .map((it, idx) => ({ id: `s${idx}_${Date.now()}`, time: it.time, fired: false }))
      .sort((a, b) => a.time.localeCompare(b.time));
    broadcastState();
    return;
  }

  if (msg.type === "toggleAuto" && typeof msg.enabled === "boolean") {
    autoEnabled = msg.enabled;
    broadcastState();
    return;
  }

  if (msg.type === "setEventWindow" && msg.start && msg.end) {
    eventWindow = { start: msg.start, end: msg.end };
    broadcastState();
    return;
  }

  if (msg.type === "reset") {
    // Tell every connected attendee directly, BEFORE deleting their records —
    // otherwise their phone just freezes on stale info forever, since once
    // deleted the server has no way left to reach them with a normal update.
    for (const [token, c] of clients.entries()) {
      if (isAttendee(c)) {
        if (c.connected) send(c.ws, { type: "reset" });
        clients.delete(token);
      }
    }
    currentQuestion = "";
    currentCategory = "";
    eventOver = false;
    pairHistory.clear();
    usedTopics.clear();
    schedule = schedule.map((s) => ({ ...s, fired: false }));
    broadcastState();
    return;
  }
}

// Scheduler tick — checks every 15s whether current time (JST) matches any
// unfired schedule entry, and if so, auto-shuffles + picks a new topic.
setInterval(() => {
  if (!autoEnabled) return;
  const nowJst = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());

  let fired = false;
  for (const item of schedule) {
    if (!item.fired && item.time === nowJst) {
      item.fired = true;
      applyPickedTopic(pickTopic(autoCategory));
      shuffleAll();
      fired = true;
    }
  }
  if (fired) broadcastState();
}, 15000);

// Heartbeat: every 10 s ping every socket (browsers answer automatically) and
// terminate any that did not answer since the last round, then send an app-level
// "tick" carrying the current state version. Clients use the tick as proof the
// connection is alive and to notice they missed a state update.
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 10000;
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
  const tick = JSON.stringify({ type: "tick", v: stateVersion, t: Date.now(), instance: INSTANCE_ID });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(tick);
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  console.log(`Not Alone Cafe grouping server running on http://localhost:${PORT}  (instance ${INSTANCE_ID}, build ${BUILD_ID})`);
  console.log(`Admin page: http://localhost:${PORT}/admin.html?key=${ADMIN_KEY}`);
  console.log(`Display page: http://localhost:${PORT}/display.html`);
});

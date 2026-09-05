// Not Alone Cafe — live event grouping server
//
// - Attendees pick a color/vibe (self-expression only, does not affect team).
// - Team assignment is always balance-driven.
// - Admin can run a schedule of auto-shuffles (new teams + new discussion
//   question at set times), edit that schedule freely, trigger a shuffle
//   manually, and override any individual's team at any time.
// - The shuffle algorithm tries to avoid re-pairing people who have already
//   shared a team earlier in the event.
// - A public /display.html page (no admin key) shows a read-only live status
//   screen (QR code + current question + team sizes) for a shared screen or
//   staff phone. It never shows individual names/tags.
// - Nothing is stored permanently. All state resets when the server restarts.

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "notalone2026"; // change before deploying!

const ALL_TEAMS = ["A", "B", "C", "D"];
const TEAM_LABELS = { A: "チームA", B: "チームB", C: "チームC", D: "チームD" };

// Generic, non-cutesy attendee tags: hiragana + 2-digit number, e.g. "さ08"
const TAG_KANA = ["あ","い","う","え","お","か","き","く","け","こ","さ","し","す","せ","そ","た","ち","つ","て","と"];

// Discussion-starter questions. Server owns this list so scheduled auto-shuffles
// can pick one themselves; the admin page also displays this same list for
// manual selection (sent to admin on connect so there's one source of truth).
const QUESTION_PRESETS = [
  "好きな飲み物は？",
  "最近ハマっていることは？",
  "休日は何をして過ごしていますか？",
  "好きな音楽のジャンルは？",
  "好きな映画やドラマは？",
  "今まで行った中で好きな旅行先は？",
  "好きな食べ物、または苦手な食べ物は？",
  "最近見て良かったものは？（映画・本・SNSなど）",
  "もし何でも一つ叶うとしたら？",
  "東京で好きな場所は？",
  "ペットを飼うなら何を飼いたい？",
  "今年挑戦したいことは？",
];

let numTeams = 4; // admin-adjustable, 1-4
let currentQuestion = "";
let autoEnabled = true;
let eventWindow = { start: "14:00", end: "17:00" };
let eventOver = false; // admin-set "Event over" state — replaces the player's welcome message

// Schedule: list of { id, time: "HH:MM", fired: boolean }. Admin-editable.
let schedule = [
  { id: "s1", time: "15:00", fired: false },
  { id: "s2", time: "15:15", fired: false },
  { id: "s3", time: "15:30", fired: false },
  { id: "s4", time: "15:45", fired: false },
];

// token -> { tag, group, vibe, ws, isAdmin, isDisplay, connected }
const clients = new Map();

// Tracks how many times each pair of tokens has shared a team, so shuffles
// can avoid repeating pairings. Key: "tokenA|tokenB" (sorted).
const pairHistory = new Map();

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

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

function activeAttendees() {
  return [...clients.entries()].filter(
    ([, c]) => c.connected && !c.isAdmin && !c.isDisplay
  );
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

// Full reshuffle of everyone currently connected & already joined. Greedy
// algorithm: shuffle attendee order randomly, then place each person into
// the active team (among those not yet at capacity) where they'd create the
// fewest repeat pairings with people already placed there this round.
function shuffleAll() {
  const attendees = activeAttendees().filter(([, c]) => c.group);
  if (attendees.length === 0) return;

  const tokens = attendees.map(([token]) => token);
  for (let i = tokens.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tokens[i], tokens[j]] = [tokens[j], tokens[i]];
  }

  const active = activeTeams();
  const capacity = Math.max(1, Math.ceil(tokens.length / active.length));
  const teamsMap = {};
  active.forEach((t) => (teamsMap[t] = []));

  for (const token of tokens) {
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
  }

  for (const [team, members] of Object.entries(teamsMap)) {
    for (const token of members) {
      clients.get(token).group = team;
    }
  }
  recordPairings(teamsMap);

  // Push each attendee their new (possibly unchanged) team directly, so their
  // screen updates without them needing to tap anything.
  for (const token of tokens) {
    const c = clients.get(token);
    if (c.connected && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(
        JSON.stringify({
          type: "assigned",
          group: c.group,
          label: TEAM_LABELS[c.group],
          vibe: c.vibe,
          question: currentQuestion,
        })
      );
    }
  }
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
    numTeams,
    teams,
    question: currentQuestion,
    schedule,
    autoEnabled,
    eventWindow,
    eventOver,
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
    type: "adminState",
    numTeams,
    teams: publicState().teams,
    question: currentQuestion,
    schedule,
    autoEnabled,
    eventWindow,
    eventOver,
    questionPresets: QUESTION_PRESETS,
    roster,
  };
}

function broadcastState() {
  const pub = JSON.stringify(publicState());
  const adm = JSON.stringify(adminState());
  for (const c of clients.values()) {
    if (!c.connected || c.ws.readyState !== WebSocket.OPEN) continue;
    c.ws.send(c.isAdmin ? adm : pub);
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isAdminReq = url.searchParams.get("admin") === "1";
  const isDisplayReq = url.searchParams.get("display") === "1";
  const key = url.searchParams.get("key");

  if (isAdminReq) {
    if (key !== ADMIN_KEY) {
      ws.send(JSON.stringify({ type: "error", message: "invalid admin key" }));
      ws.close();
      return;
    }
    const token = makeToken();
    clients.set(token, { tag: "ADMIN", group: null, vibe: null, ws, isAdmin: true, isDisplay: false, connected: true });
    ws.send(JSON.stringify({ type: "welcome", token, isAdmin: true }));
    ws.send(JSON.stringify(adminState()));

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
      handleAdminMessage(raw);
    });
    ws.on("close", () => {
      const c = clients.get(token);
      if (c) c.connected = false;
    });
    return;
  }

  if (isDisplayReq) {
    const token = makeToken();
    clients.set(token, { tag: "DISPLAY", group: null, vibe: null, ws, isAdmin: false, isDisplay: true, connected: true });
    ws.send(JSON.stringify(publicState()));
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    });
    ws.on("close", () => {
      const c = clients.get(token);
      if (c) c.connected = false;
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

    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }

    if (msg.type === "init") {
      if (msg.token && clients.has(msg.token) && !clients.get(msg.token).isAdmin && !clients.get(msg.token).isDisplay) {
        token = msg.token;
        const c = clients.get(token);
        c.ws = ws;
        c.connected = true;
      } else {
        token = makeToken();
        clients.set(token, { tag: makeTag(), group: null, vibe: null, ws, isAdmin: false, isDisplay: false, connected: true });
      }
      const c = clients.get(token);
      ws.send(
        JSON.stringify({
          type: "welcome",
          token,
          tag: c.tag,
          group: c.group,
          groupLabel: c.group ? TEAM_LABELS[c.group] : null,
          vibe: c.vibe,
          question: currentQuestion,
        })
      );
      broadcastState();
      return;
    }

    if (msg.type === "choose" && token) {
      const c = clients.get(token);
      if (!c) return;
      c.vibe = msg.vibe || null;
      c.group = null;
      const team = assignTeam();
      c.group = team;
      ws.send(
        JSON.stringify({
          type: "assigned",
          group: team,
          label: TEAM_LABELS[team],
          vibe: c.vibe,
          question: currentQuestion,
        })
      );
      broadcastState();
      return;
    }
  });

  ws.on("close", () => {
    if (token && clients.has(token)) clients.get(token).connected = false;
  });
});

function handleAdminMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type === "move" && msg.token && msg.toGroup) {
    const c = clients.get(msg.token);
    if (c && !c.isAdmin && !c.isDisplay && ALL_TEAMS.includes(msg.toGroup)) {
      c.group = msg.toGroup;
      // Push the change directly to that person's own phone — without this,
      // their screen kept showing the old team until they manually refreshed,
      // since a manual move never triggered their own "assigned" update.
      if (c.connected && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(
          JSON.stringify({
            type: "assigned",
            group: c.group,
            label: TEAM_LABELS[c.group],
            vibe: c.vibe,
            question: currentQuestion,
          })
        );
      }
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
    // Any theme change (including Clear) implies the event is running again —
    // this is also what lets admin repeatedly test the "Event over" screen.
    eventOver = false;
    broadcastState();
    return;
  }

  if (msg.type === "setEventOver" && typeof msg.value === "boolean") {
    eventOver = msg.value;
    broadcastState();
    return;
  }

  if (msg.type === "shuffleNow") {
    currentQuestion = QUESTION_PRESETS[Math.floor(Math.random() * QUESTION_PRESETS.length)];
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
      if (!c.isAdmin && !c.isDisplay) {
        if (c.connected && c.ws.readyState === WebSocket.OPEN) {
          c.ws.send(JSON.stringify({ type: "reset" }));
        }
        clients.delete(token);
      }
    }
    currentQuestion = "";
    eventOver = false;
    pairHistory.clear();
    schedule = schedule.map((s) => ({ ...s, fired: false }));
    broadcastState();
    return;
  }
}

// Scheduler tick — checks every 15s whether current time (JST) matches any
// unfired schedule entry, and if so, auto-shuffles + picks a new question.
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
      currentQuestion = QUESTION_PRESETS[Math.floor(Math.random() * QUESTION_PRESETS.length)];
      shuffleAll();
      fired = true;
    }
  }
  if (fired) broadcastState();
}, 15000);

server.listen(PORT, () => {
  console.log(`Not Alone Cafe grouping server running on http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin.html?key=${ADMIN_KEY}`);
  console.log(`Display page: http://localhost:${PORT}/display.html`);
});

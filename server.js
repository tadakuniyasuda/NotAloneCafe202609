// Not Alone Cafe — live event grouping server
//
// - Attendees connect from their phone and pick a "vibe" icon (an icebreaker
//   flavor, based on the mascot's poses). The vibe is just self-expression —
//   it does NOT determine which group they land in.
// - Group assignment is always balanced separately: whoever picks next goes
//   to whichever active group currently has the fewest people.
// - Admin can start a "discussion round" by setting a question, which every
//   attendee sees alongside their group. Latecomers get folded into the
//   smallest group and immediately see the current question.
// - Admin can manually move anyone between groups at any time, and change how
//   many groups are active.
// - Nothing is stored permanently. All state lives in memory and resets when
//   the server restarts (fresh start each event night).

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "notalone2026"; // change before deploying!

// All four possible group identities. Only the first `numGroups` are "active"
// at any given time — admin controls this live based on turnout.
const ALL_GROUPS = ["apple", "banana", "fox", "bear"];
const GROUP_LABELS = { apple: "🍎 Apple", banana: "🍌 Banana", fox: "🦊 Fox", bear: "🐻 Bear" };

const TAG_ANIMALS = ["Fox", "Bear", "Otter", "Rabbit", "Deer", "Owl", "Cat", "Finch"];

let numGroups = 4; // admin-adjustable, 1-4
let currentQuestion = ""; // empty string = no discussion round active yet

// token -> { tag, group, vibe, ws, isAdmin, connected }
const clients = new Map();

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function activeGroups() {
  return ALL_GROUPS.slice(0, numGroups);
}

function makeTag() {
  const animal = TAG_ANIMALS[Math.floor(Math.random() * TAG_ANIMALS.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${animal}-${num}`;
}

function makeToken() {
  return crypto.randomBytes(12).toString("hex");
}

function groupCounts() {
  const counts = {};
  for (const g of ALL_GROUPS) counts[g] = 0;
  for (const c of clients.values()) {
    if (c.connected && !c.isAdmin && c.group) counts[c.group] = (counts[c.group] || 0) + 1;
  }
  return counts;
}

function capacityPerGroup() {
  const total = [...clients.values()].filter((c) => c.connected && !c.isAdmin && c.group).length;
  return Math.max(1, Math.ceil(total / Math.max(1, numGroups)));
}

// Pick the active group with the fewest members (ties broken by ALL_GROUPS order)
function leastFullActiveGroup(counts) {
  const active = activeGroups();
  let best = active[0];
  for (const g of active) {
    if (counts[g] < counts[best]) best = g;
  }
  return best;
}

// Group assignment is ALWAYS balance-driven. The vibe icon a person taps is
// flavor only — it's stored separately for display and does not affect which
// group they're placed in.
function assignGroup() {
  const counts = groupCounts();
  return leastFullActiveGroup(counts);
}

function publicState() {
  const counts = groupCounts();
  const cap = capacityPerGroup();
  const groups = {};
  for (const g of ALL_GROUPS) {
    groups[g] = {
      label: GROUP_LABELS[g],
      active: activeGroups().includes(g),
      count: counts[g],
      capacity: cap,
    };
  }
  return { type: "state", numGroups, groups, question: currentQuestion };
}

function adminState() {
  const roster = [...clients.entries()]
    .filter(([, c]) => c.connected && !c.isAdmin)
    .map(([token, c]) => ({ token, tag: c.tag, group: c.group, vibe: c.vibe }));
  return { type: "adminState", numGroups, groups: publicState().groups, question: currentQuestion, roster };
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
  const key = url.searchParams.get("key");

  if (isAdminReq) {
    if (key !== ADMIN_KEY) {
      ws.send(JSON.stringify({ type: "error", message: "invalid admin key" }));
      ws.close();
      return;
    }
    const token = makeToken();
    clients.set(token, { tag: "ADMIN", group: null, vibe: null, ws, isAdmin: true, connected: true });
    ws.send(JSON.stringify({ type: "welcome", token, isAdmin: true }));
    ws.send(JSON.stringify(adminState()));

    ws.on("message", (raw) => handleAdminMessage(raw));
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

    if (msg.type === "init") {
      // Reconnect if we recognize the token, otherwise issue a new one
      if (msg.token && clients.has(msg.token) && !clients.get(msg.token).isAdmin) {
        token = msg.token;
        const c = clients.get(token);
        c.ws = ws;
        c.connected = true;
      } else {
        token = makeToken();
        clients.set(token, { tag: makeTag(), group: null, vibe: null, ws, isAdmin: false, connected: true });
      }
      const c = clients.get(token);
      ws.send(
        JSON.stringify({
          type: "welcome",
          token,
          tag: c.tag,
          group: c.group,
          groupLabel: c.group ? GROUP_LABELS[c.group] : null,
          vibe: c.vibe,
          question: currentQuestion,
        })
      );
      broadcastState();
      return;
    }

    // Picking (or re-picking) a vibe. Always re-balances group placement —
    // this is what powers both first-join AND the "choose again" button.
    if (msg.type === "choose" && token) {
      const c = clients.get(token);
      if (!c) return;
      c.vibe = msg.vibe || null;
      c.group = null; // release current slot so the recompute below is fair
      const group = assignGroup();
      c.group = group;
      ws.send(
        JSON.stringify({
          type: "assigned",
          group,
          label: GROUP_LABELS[group],
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
    if (c && !c.isAdmin && ALL_GROUPS.includes(msg.toGroup)) {
      c.group = msg.toGroup;
      broadcastState();
    }
    return;
  }

  if (msg.type === "setNumGroups" && Number.isInteger(msg.value)) {
    numGroups = Math.min(4, Math.max(1, msg.value));
    broadcastState();
    return;
  }

  if (msg.type === "setQuestion" && typeof msg.text === "string") {
    currentQuestion = msg.text.trim();
    broadcastState();
    return;
  }

  if (msg.type === "reset") {
    for (const [token, c] of clients.entries()) {
      if (!c.isAdmin) clients.delete(token);
    }
    currentQuestion = "";
    broadcastState();
    return;
  }
}

server.listen(PORT, () => {
  console.log(`Not Alone Cafe grouping server running on http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin.html?key=${ADMIN_KEY}`);
});

# How This App Works — Technical Overview

Yes — the whole stack is: **WebSocket + vanilla HTML/CSS/JS on the frontend,
Node.js on the backend, deployed on Render.com.** No frameworks, no database
(yet), no build step. That simplicity was deliberate, and this doc explains
why each piece is what it is.

## The stack, piece by piece

| Layer | What's used | Why |
|---|---|---|
| Frontend | Plain HTML/CSS/JS | No React/Vue needed — the UI is simple enough that a framework would add build tooling for no real benefit |
| Real-time transport | WebSocket (`ws` npm package) | Instant, bidirectional push — the server can tell a phone "you're in Team B now" without the phone asking |
| Backend server | Node.js + Express | Express only serves the static HTML/CSS/JS files; almost all the real logic lives in the WebSocket handler |
| Hosting | Render.com (free tier) | Runs a persistent Node process with WebSocket support — most shared hosting (お名前.com, DreamHost shared) can't do this at all |
| State storage | In-memory (a JS `Map`) | No database — state resets each event, which is fine for a single-night app and avoids a whole extra piece of infrastructure |

## Why WebSocket instead of a normal web request?

A normal web page works like this: phone asks server "what's my status?",
server answers, connection closes. If you want live updates, the phone has to
keep asking over and over (polling).

WebSocket instead opens **one connection that stays open** for as long as the
tab is open. Either side can send a message at any time. That's what makes
"you got assigned to a new team when the admin hit shuffle" work *instantly*,
without the phone having to constantly ask "did anything change yet?"

This directly connects to what you're already doing at work — your
PJ_Element AI conversation system uses the same pattern (Node.js/WebSocket)
for the same reason: instant push instead of poll-and-wait.

## The message protocol

Every WebSocket message is a small JSON object with a `type` field. The
server and every client agree on a shared vocabulary:

```
Client → Server:
  { type: "init", token }       // "I'm here, remember me if you can"
  { type: "choose", vibe }      // "I picked this color"

Server → Client (attendee):
  { type: "welcome", token, tag, group, vibe, question }
  { type: "assigned", group, label, vibe, question }
  { type: "state", teams, question, schedule, autoEnabled }

Admin-only:
  { type: "move", token, toGroup }
  { type: "setQuestion", text }
  { type: "shuffleNow" }
  { type: "setSchedule", items }
  { type: "toggleAuto", enabled }
```

This is basically a tiny hand-rolled RPC system — no library needed, just an
agreed-upon shape for the JSON.

## The team-balancing logic

Two separate mechanisms, doing two different jobs:

**Individual join** (`assignTeam()`): whenever one person taps a vibe icon,
they go to whichever active team currently has the fewest people. Simple,
instant, no history involved.

**Full reshuffle** (`shuffleAll()`): this is the interesting one. Every time
a shuffle happens (scheduled or manual), the server:

1. Shuffles the attendee list into random order
2. Places each person into whichever team would create the **fewest repeat
   pairings** with people already placed in that team this round
3. Records every new pairing into `pairHistory` (a Map of `"tokenA|tokenB" →
   count`) so future shuffles remember who's already met

This is a greedy algorithm, not a perfect solution (the "perfect" version of
this is related to a known hard problem called the **social golfer
problem**), but it's more than good enough for ~20 people and runs instantly.
I tested it directly: 8 people through 3 consecutive shuffles into teams of
2 produced **zero repeated pairings across all three rounds**.

## The scheduler

`setInterval` checks every 15 seconds whether the current time (explicitly
computed in **JST**, regardless of what timezone Render's server itself runs
in) matches any unfired entry in the admin-editable schedule. If it matches,
it fires a shuffle and marks that entry done so it won't fire twice.

## Why Render, not お名前.com or DreamHost

Both of your existing hosting accounts are **shared hosting** — built for
PHP/WordPress, with no ability to run a persistent process. WebSocket needs a
long-lived server process listening for connections, which shared hosting
architecturally can't provide. Render (and services like it — Railway, Fly.io)
are built specifically to run that kind of process. This is also why AWS
(API Gateway WebSocket + Lambda + DynamoDB) came up as your planned next
learning project — it's a different way to solve the same underlying need,
serverless instead of a persistent process.

## Two known trade-offs, on purpose

- **In-memory state, not a database.** Every restart clears everyone's
  team/vibe/pairing history. Fine for "reset before each event," not fine for
  anything meant to persist for months — that's exactly why the future
  message-wall feature will need a real database (Supabase, most likely).
- **Free tier cold starts.** Render's free plan spins the server down after
  15 minutes idle; the next visitor waits 30-60 seconds. Solved operationally
  (open the admin page a few minutes before doors open), not solved in code.

## What would change for the Unity v2 version

The WebSocket message protocol above doesn't need to change much — Unity's
WebSocket client would speak the same JSON "language" as this HTML page does.
The real additions would be: continuous position broadcasts (for the
third-person avatar), and a database (for the message-wall feature), neither
of which this v1 needed.

# DarkenChat

[![CI](https://github.com/Rickion/darkenchat/actions/workflows/ci.yml/badge.svg)](https://github.com/Rickion/darkenchat/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/darkenchat?logo=npm)](https://www.npmjs.com/package/darkenchat)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

**Read this in other languages:** **English** · [中文](docs/i18n/zh/README.md)

**Private · Ephemeral · Peer-to-Peer**

DarkenChat is a browser-based group chat that works without accounts, without servers storing your messages, and without leaving a trace. Rooms live only as long as someone is in them.

**🌐 Live demo: [chat.darken.cc](https://chat.darken.cc/)** — open it, create a room, [add AI members](#ai--mcp-integration), and have them debate a topic for you.

---

https://github.com/user-attachments/assets/1f55792c-c1b1-4129-a23c-8194311d59b9

https://github.com/user-attachments/assets/ba86f26c-45a6-4951-9b72-82796b034d03

---

## Table of contents

- [What makes it different](#what-makes-it-different)
- [How to use](#how-to-use)
- [Known issues](#known-issues)
- [AI / MCP integration](#ai--mcp-integration)
- [How it works](#how-it-works)
- [Features](#features)
- [Quick start (local dev)](#quick-start-local-dev)
- [Self-hosting with Docker](#self-hosting-with-docker)
- [Configuration reference (`config.yaml`)](#configuration-reference-configyaml)
- [Architecture](#architecture)
- [Admin API](#admin-api)
- [Contributing](#contributing)
- [License](#license)

---

## What makes it different

Two things set DarkenChat apart from every other chat app:

### 1. Traceless chat 🕵️

Messages never touch a server. They travel over an **encrypted WebRTC DataChannel directly between browsers** — the signaling server only helps peers find each other and never sees a single message. There are **no accounts, no database, no history**. Rooms exist only while someone is inside; close the last tab and the room — and everything ever said in it — is simply gone.

### 2. Multi-AI panel that argues its way to one answer 🤖⚖️

Pull **several different AIs** (Claude, and any MCP-compatible agent) into the *same* room and let them **debate, review each other, and converge on a single conclusion** — no human moderator needed. Each AI takes a `stance` (agree / disagree with specific members by ID); the server clusters them by an **agreement graph**, one AI acts as **chairperson** and writes the round summary, and a `ROUND_COMPLETE` signal fires automatically once the panel converges. Ask a hard question, walk away, come back to a reasoned, cross-checked answer.

---

## How to use

The simplest path: 
> **send this GitHub repo link to your AI and ask it to set itself up.**

Once it reports success, just tell it:

> Join room `XXXX` with the nickname `XX`.

and it will appear in the room as a bot member. (See [AI / MCP integration](#ai--mcp-integration) below if you'd rather configure it by hand.)

---

## Known issues

AI membership relies on the host's plugin/MCP capability, and an AI stays "present" mainly by **polling the MCP server** to indirectly pick up and reply to room messages. On some hosts this polling loop can be **unstable** — the process is alive and still in the room, but it has quietly stopped polling and goes mute.

If you notice an AI has stopped responding, just tell it something like:

> Re-join the room and keep discussing.

and it will resume the poll loop. The [keep-alive plugins](./plugins/) reduce how often this happens, but can't eliminate it on every host.

---

## AI / MCP integration

Bring Claude and other MCP agents into a room as visible bot members. **The easiest way is the plugin** — it bundles the MCP server (auto-fetched via `npx`, nothing to install by hand) plus a keep-alive hook, so you don't edit any config files.

### Claude Code — one click (recommended)

Run these two commands inside Claude Code:

```
/plugin marketplace add Rickion/darkenchat
/plugin install darkenchat
```

Done. The MCP server and the keep-alive hook are both installed — no JSON to edit. Now just tell the AI to join a room by its 4-character key.

### opencode / OpenClaw

The plugin is available for these hosts too; wire it up by following its README:

- opencode → [`plugins/opencode/`](./plugins/opencode/)
- OpenClaw → [`plugins/openclaw/`](./plugins/openclaw/)

### Other hosts (manual MCP)

For any other MCP host (Claude Desktop, Cursor, …), add the server to your MCP config:

```json
{
  "mcpServers": {
    "darkenchat": {
      "command": "npx",
      "args": ["-y", "darkenchat@latest"]
    }
  }
}
```

Full env-var options (server URL, custom TURN, …) are in [`mcp-server/examples/mcp.json.example`](./mcp-server/examples/mcp.json.example).

---

## How it works

```
Browser A ────────────────────── Browser B
    │       WebRTC DataChannel        │
    │  (messages never touch server)  │
    └──────────────┬──────────────────┘
                   │
          Signaling Server
        (exchanges SDP/ICE only,
         never sees message content)
```

- Rooms are identified by a **4-character key** (e.g. `A7BK`). Share the link, start chatting.
- Messages travel over an **encrypted WebRTC DataChannel** directly between browsers.
- The signaling server only brokers WebRTC negotiation — it never sees message content.
- Close the tab: messages are gone. No accounts, no server-side history.

---

## Features

| Feature | Details |
|---------|---------|
| **Zero registration** | Open a room URL and start chatting — no account, no email |
| **Encrypted transport** | WebRTC DTLS directly between peers; messages never hit a server |
| **Multi-AI expert panel** | Several AIs debate, review each other, and converge on one answer (agreement graph + chairperson + auto `ROUND_COMPLETE`) |
| **AI member support** | Claude and any MCP-compatible agent can join as a transparent bot member |
| **Rich text** | Bold, italic, underline, code blocks, links (Tiptap editor) |
| **@mentions** | Mention a member, `@All` (everyone), or `@AllAI` (every AI at once) |
| **Quoted replies** | Reply to a specific message; click the quote badge to jump to the original |
| **File sharing** | Drag a file onto the input or attach it (up to 5 MB), sent P2P like messages |
| **Voice chat** | Up to 5 members can join a mesh audio call inside any room |
| **Forward / history cards** | Select messages and forward them as a card with a note |
| **Message tools** | Copy any message; long messages collapse/expand (individually or all at once) |
| **Resilient connection** | Signaling reconnects with backoff and auto-rejoins the room after a drop |
| **Auto-election** | If the center relay node goes offline, a new one is elected automatically |
| **Chair (admin) controls** | First member can kick others, end the room, or set a per-AI turn cap |
| **PWA** | Installable as a desktop/mobile app |
| **i18n** | English + Chinese, switchable in-app |
| **Self-hostable** | Single Docker image, no database required |

---

## Quick start (local dev)

**Prerequisites:** Node 24, [coturn](https://github.com/coturn/coturn)

```bash
# 1. Start local TURN (required for two same-machine browser tabs to connect via WebRTC)
turnserver --lt-cred-mech --user test:test123 --realm localhost \
  --listening-port 3478 --listening-ip 127.0.0.1 --no-tls --no-dtls &

# 2. Start signaling server
cd signaling && npm install && npm run dev   # → http://localhost:3000

# 3. Start frontend
cd frontend  && npm install && npm run dev   # → http://localhost:5173

# 4. Open two browser tabs, create a room, start chatting
```

---

## Self-hosting with Docker

> ⚠️ **Single-instance only.** The signaling server keeps all room state in
> process memory. Running two or more instances behind a load balancer will
> split rooms across instances and break connections that land on the "wrong"
> one. Scale vertically (one process, more CPU), or shard by domain if you
> outgrow one box.



### 1. Configure `config.yaml`

Before deploying, open `config.yaml` and change the following:

```yaml
server:
  cors_origins:
    - "https://your-domain.com"   # ← your actual domain
    - "http://localhost:5173"     # ← remove this line in production

security:
  admin_token: "${ADMIN_TOKEN}"   # ← set via environment variable (see below)
  rate_limit:
    max_key_probes: 10            # probes per IP per 60s before temp-ban
```

If you have a TURN server (recommended for production), configure it via environment
variables — `config.yaml` only stores the URL list and HMAC TTL; credentials are
read from env so they never get committed.

```yaml
# config.yaml
ice:
  turn:
    urls: []                       # filled in by TURN_URLS env (comma-separated)
    auth_secret: "${TURN_SECRET}"  # HMAC secret for coturn use-auth-secret
    ttl_seconds: 3600
```

Two auth modes (env vars take precedence over `config.yaml`):

- **HMAC (recommended, coturn `use-auth-secret`)**:
  `TURN_URLS=turn:turn.your-domain.com:3478` + `TURN_SECRET=<shared-secret>`.
  Credentials are time-limited and minted by the signaling server — the secret
  never reaches clients.
- **Static credentials**:
  `TURN_URLS=...` + `TURN_USERNAME=...` + `TURN_CREDENTIAL=...`.

**Or use Metered.ca built-in TURN provider:**

```yaml
ice:
  metered:
    enabled: true
    api_key: "${TURN_METERED_API_KEY}"   # Metered dashboard "API Key"
    domain:  "${TURN_METERED_DOMAIN}"    # e.g. your-app.metered.live
    ttl_seconds: 7200                    # match dashboard TURN_TIME
```

The signaling server calls Metered server-side on every `/api/turn-metered`
request and returns fresh temporary credentials — the API key never reaches
the browser. Clients (browser + MCP) rotate credentials ~10 min before
expiry and hot-swap them onto any active TURN relay, so an in-progress call
is not interrupted. Set the Metered dashboard's TURN_TIME to match
`ttl_seconds` (default 2 h).

Get the API Key and subdomain from [dashboard.metered.ca](https://dashboard.metered.ca/) → Your Project → API Credentials.

### 2. Set the admin token

The admin token protects the `/api/admin/*` endpoints. Set it via environment variable — **do not hardcode it in config.yaml**.

Copy the example env file and fill it in:

```bash
cp .env.example .env
# edit .env:
#   ADMIN_TOKEN=a-long-random-string
```

When `docker compose up` runs, Compose reads `.env` and injects the variables into the container. `config.yaml` then reads them with `"${ADMIN_TOKEN}"` at startup.

### 3. Build and run

```bash
docker compose up -d
```

The container listens on **port 3000** and serves both the static frontend and the WebSocket endpoint at `/ws`.

### 4. Reverse proxy (Nginx example)

You must put a TLS-terminating reverse proxy in front. Example Nginx config:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    # ... your SSL certificate config ...

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # required for WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Deploying via Portainer (Stacks)

1. In Portainer → **Stacks** → **Add stack** → paste or upload `docker-compose.yml`
2. At the bottom of the editor, open the **"Environment variables"** panel
3. Add: `ADMIN_TOKEN` = `your-secret-value`
4. Deploy the stack

> **Note:** The domain name (`server_name`) is not an application setting — it belongs in your reverse proxy config (Nginx/Traefik/Caddy), not in this container.

---

## Configuration reference (`config.yaml`)

| Key | Default | Description |
|-----|---------|-------------|
| `server.port` | `3000` | Listening port |
| `server.cors_origins` | — | Allowed origins for WebSocket connections |
| `security.admin_token` | env var | Token for Admin API endpoints |
| `security.rate_limit.window_seconds` | `60` | Sliding window duration |
| `security.rate_limit.max_key_probes` | `10` | Max room probes per IP per window |
| `security.rate_limit.ban_duration_seconds` | `3600` | How long a temp-ban lasts |
| `room.max_members` | `50` | Max members per room |
| `room.max_bot_members` | `10` | Max AI/bot members per room |
| `room.heartbeat_interval_seconds` | `3` | How often the server sweeps for silent members |
| `room.heartbeat_timeout_seconds` | `10` | Seconds since the last heartbeat before a member is evicted |
| `log.switch_log_max_entries` | `1000` | Rolling cap on probe / switch log entries kept in memory |
| `ice.stun_urls` | Cloudflare + Google | STUN servers advertised to clients |
| `ice.turn.urls` | `[]` | Self-hosted TURN URLs; usually overridden by `TURN_URLS` env |
| `ice.turn.auth_secret` | env `TURN_SECRET` | HMAC secret for coturn `use-auth-secret` mode |
| `ice.turn.ttl_seconds` | `3600` | TTL for HMAC-issued TURN credentials |
| `ice.metered.enabled` | `false` | Use Metered.ca built-in TURN provider |
| `ice.metered.api_key` | env | Metered project API key (server-side only) |
| `ice.metered.domain` | env | Metered project subdomain (e.g. `your-app.metered.live`) |
| `ice.metered.ttl_seconds` | `7200` | TTL for Metered temp credentials; must match dashboard TURN_TIME |
| `log.level` | `info` | Fastify logger level |


---

## Architecture

```
darkenchat/
├── frontend/        # Vite · Vue 3 · Vuetify 4 · Pinia · Tiptap v3
├── signaling/       # Fastify 5 · @fastify/websocket  (Node 24)
├── mcp-server/      # @modelcontextprotocol/sdk · @roamhq/wrtc
├── docker/          # Dockerfile (multi-stage, node:24-alpine, ~220 MB)
└── config.yaml      # Runtime configuration (mounted as volume)
```

**Message flow:**
1. Browser connects to signaling server via WebSocket
2. Server assigns `clientId`, returns room state
3. Center node and peers exchange SDP/ICE via signaling (perfect negotiation)
4. WebRTC DataChannel opens — signaling server is no longer in the loop
5. Messages flow P2P; center node relays to all other peers

**Deeper dives:**

- [Multi-AI expert-panel protocol](./mcp-server/examples/README.md) — how the structured `stance` field (`position` + `agreeWith`/`disagreeWith` clientIds), `tally_positions`, and the auto-`ROUND_COMPLETE` system message let several AIs converge on one answer without a human moderator.
- [Agent behaviour rules](./mcp-server/AGENT.md) — long-poll loop, turn counting, convergence reminders, terminal room states.

---

## Admin API

All endpoints except `/api/admin/auth` require the `X-Admin-Token: <your-token>` header.

```
POST   /api/admin/auth                    verify the admin token (body: { "token": "…" })
GET    /api/admin/rooms                   list active rooms
DELETE /api/admin/rooms/:key              force-dissolve a room (broadcasts room_ended)
GET    /api/admin/logs                    probe / switch logs
GET    /api/admin/bans                    list current bans (IPs + room keys)
DELETE /api/admin/bans/:type/:value       unban an IP or room key (type = "ip" or "key")
```

Bans are auto-created by the rate-limit guard; there is no manual ban endpoint —
only unban.

---

## Contributing

Pull requests are welcome. Please open an issue first for significant changes.

- All packages use TypeScript with strict mode enabled.
- Run `npm run build` in each package before submitting a PR.

---

## License

DarkenChat is open source under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

You are free to use, modify, and self-host this software. If you distribute a modified version or run it as a network service, you must release the source code of your modifications under the same license.

**Commercial licensing available** — for organizations that need private deployment without AGPL obligations, enterprise support, or white-labeling. 

See [LICENSE](./LICENSE).

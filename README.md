# DarkenChat

[![CI](https://github.com/Rickion/darkenchat/actions/workflows/ci.yml/badge.svg)](https://github.com/Rickion/darkenchat/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/darkenchat?logo=npm)](https://www.npmjs.com/package/darkenchat)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

**Read this in other languages:** **English** · [中文](docs/i18n/zh/README.md)

**Private · Ephemeral · Peer-to-Peer**

DarkenChat is a browser-based group chat that works without accounts, without servers storing your messages, and without leaving a trace. Rooms live only as long as someone is in them.

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
| **Zero registration** | Open a room URL and start chatting |
| **Encrypted transport** | WebRTC DTLS between peers |
| **Rich text** | Bold, italic, underline, code blocks, links (Tiptap editor) |
| **Voice chat** | Up to 5 members can join a mesh audio call inside any room |
| **Forward / history cards** | Select messages and forward them as a card with a note |
| **Auto-election** | If the center node goes offline, a new one is elected automatically |
| **Chair (admin) controls** | First member can kick others or end the room |
| **AI member support** | Claude and MCP-compatible agents can join as transparent bot members |
| **PWA** | Installable as a desktop/mobile app |
| **i18n** | English + Chinese |
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

## AI / MCP integration

DarkenChat ships an [MCP server](./mcp-server/) so Claude and other MCP-compatible agents can join rooms.

### Install

Run it directly with npx (no global install needed) — most MCP hosts do this for you:

```bash
npx -y darkenchat@latest
```

Or install it globally:

```bash
npm install -g darkenchat
# `darkenchat` is now on your PATH
```

Or build from source:

```bash
cd mcp-server && npm install && npm run build
# entry point: mcp-server/dist/index.js
```

### Wire it into your MCP host

Add to your Claude Desktop / Cursor / Claude Code config:

```json
{
  "mcpServers": {
    "darkenchat": {
      "command": "darkenchat"
    }
  }
}
```

If you built from source instead, swap the command for:

```json
{ "command": "node", "args": ["/abs/path/to/mcp-server/dist/index.js"] }
```

See [`mcp-server/examples/mcp.json.example`](./mcp-server/examples/mcp.json.example) for the full env-var set (server URL, custom TURN, convergence reminder, …).

**Tools:** `join_room` · `wait_for_mention` (long-poll, steady-state loop) · `get_messages` · `send_message` (optional structured `stance` for expert panels) · `tally_positions` (stance tally) · `leave_room`

See [`mcp-server/AGENT.md`](./mcp-server/AGENT.md) for the loop pattern and behavior rules each AI agent must follow.

Bot members always appear in the member list with a robot icon (`mdi-robot`). Invisible join is not possible.

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

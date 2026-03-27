# DarkenChat

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

If you have a TURN server (recommended for production), uncomment and fill in:

```yaml
ice:
  turn:
    urls:
      - "turn:turn.your-domain.com:3478"
    username: "${TURN_USERNAME}"
    credential: "${TURN_CREDENTIAL}"
```

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
| `room.max_bot_members` | `3` | Max AI/bot members per room |
| `room.heartbeat_timeout_seconds` | `10` | Seconds before a silent peer is considered gone |

---

## AI / MCP integration

DarkenChat ships an [MCP server](./mcp-server/) so Claude and other MCP-compatible agents can join rooms.

```bash
cd mcp-server && npm install && npm run build
```

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "darkenchat": {
      "command": "node",
      "args": ["/path/to/darkenchat/mcp-server/dist/index.js"]
    }
  }
}
```

**Tools:** `join_room` · `send_message` · `get_messages` · `leave_room`

Bot members always appear in the member list with a 🤖 icon. Invisible join is not possible.

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

---

## Admin API

All endpoints require `X-Admin-Token: <your-token>` header.

```
GET    /api/admin/rooms                        list active rooms
GET    /api/admin/rooms/:key/members           list members
POST   /api/admin/rooms/:key/kick/:clientId    kick a member
POST   /api/admin/rooms/:key/end               end a room
GET    /api/admin/bans                         list bans
POST   /api/admin/bans/ip/:ip                  ban an IP
DELETE /api/admin/bans/ip/:ip                  unban an IP
POST   /api/admin/bans/key/:key                ban a room key
DELETE /api/admin/bans/key/:key                unban a room key
GET    /api/admin/logs                         probe / switch logs
```

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

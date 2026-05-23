import Fastify from 'fastify'
import fastifyWS from '@fastify/websocket'
import fastifyCors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import yaml from 'js-yaml'
import { nanoid } from 'nanoid'

import type { C2S } from './types.js'
import { PROTOCOL_VERSION } from './types.js'
import {
  rooms,
  generateKey,
  getOrCreateRoom,
  addMember,
  removeMember,
  broadcast,
  send,
  memberInfo,
  dissolveIfBotsOnly,
  announceChairChange,
} from './rooms.js'
import { checkAndRecord, bannedKeys, configure as configureGuard } from './guard.js'
import { handleScore } from './election.js'
import { registerAdminRoutes, setAdminToken } from './admin.js'

// ─── Load config ──────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url))
// APP_ROOT is set to /app in Docker; in dev __dir is signaling/dist so ../../ reaches project root
const APP_ROOT = process.env.APP_ROOT ?? resolve(__dir, '../..')
const cfgPath = resolve(APP_ROOT, 'config.yaml')
const cfg: any = existsSync(cfgPath)
  ? yaml.load(readFileSync(cfgPath, 'utf8').replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? ''))
  : {}

const HOST = cfg?.server?.host ?? '0.0.0.0'
const PORT = cfg?.server?.port ?? 3000
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? cfg?.security?.admin_token ?? 'dev-token'
const CORS_ORIGINS: string[] | true = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : (cfg?.server?.cors_origins ?? true)
const MAX_MEMBERS = cfg?.room?.max_members ?? 50
const MAX_BOTS = cfg?.room?.max_bot_members ?? 10
// STUN list advertised by /api/ice so every client (browser + MCP) shares one
// source of truth. Defaults match the project's historical hardcode.
const STUN_URLS: string[] = cfg?.ice?.stun_urls ?? ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302']
// How often the sweep runs, and how long a member can be silent before it
// gets evicted. The sweep also drops recentLeft entries past their TTL so
// the map doesn't grow unbounded.
const HEARTBEAT_INTERVAL_MS = (cfg?.room?.heartbeat_interval_seconds ?? 3) * 1000
const HEARTBEAT_TIMEOUT_MS = (cfg?.room?.heartbeat_timeout_seconds ?? 10) * 1000
const RECENT_LEFT_TTL_MS = 5 * 60 * 1000 // 5 min — matches the "returning member" window

// TURN — env vars take precedence over config.yaml.
// Auth: TURN_SECRET (HMAC, for coturn use-auth-secret) OR TURN_USERNAME+TURN_CREDENTIAL (static).
// HMAC is preferred when both are set.
const TURN_URLS: string[] = process.env.TURN_URLS
  ? process.env.TURN_URLS.split(',')
      .map(s => s.trim())
      .filter(Boolean)
  : (cfg?.ice?.turn?.urls ?? [])
const TURN_SECRET = process.env.TURN_SECRET ?? cfg?.ice?.turn?.auth_secret ?? ''
const TURN_USERNAME = process.env.TURN_USERNAME ?? ''
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL ?? ''
const TURN_TTL = cfg?.ice?.turn?.ttl_seconds ?? 3600

// Metered.ca built-in TURN provider — server-side fetch only.
// The API key never reaches the browser. Each /api/turn-metered call hits
// Metered's credentials endpoint and returns the resulting ICE server list
// plus an `expiresAt` (computed from METERED_TTL) so clients can rotate
// before the temp credentials die.
const METERED_API_KEY = process.env.TURN_METERED_API_KEY ?? cfg?.ice?.metered?.api_key ?? ''
const METERED_DOMAIN = process.env.TURN_METERED_DOMAIN ?? cfg?.ice?.metered?.domain ?? ''
const METERED_TTL = Number(process.env.TURN_METERED_TTL ?? cfg?.ice?.metered?.ttl_seconds ?? 7200)
const METERED_ENABLED =
  (process.env.TURN_METERED_ENABLED === 'true' || cfg?.ice?.metered?.enabled === true) &&
  !!METERED_API_KEY &&
  !!METERED_DOMAIN

configureGuard({
  windowSeconds: cfg?.security?.rate_limit?.window_seconds ?? 60,
  maxKeyProbes: cfg?.security?.rate_limit?.max_key_probes ?? 10,
  banDurationSeconds: cfg?.security?.rate_limit?.ban_duration_seconds ?? 3600,
  switchLogMaxEntries: cfg?.log?.switch_log_max_entries ?? 1000,
})
setAdminToken(ADMIN_TOKEN)

// ─── Server ───────────────────────────────────────────────
const app = Fastify({ logger: { level: cfg?.log?.level ?? 'info' } })

await app.register(fastifyCors, {
  origin: CORS_ORIGINS,
})
await app.register(fastifyWS)

// Serve built frontend if present
const publicDir = resolve(APP_ROOT, 'public')
if (existsSync(publicDir)) {
  await app.register(fastifyStatic, { root: publicDir, prefix: '/', wildcard: false })
}

// SPA fallback: serve index.html for all non-API, non-asset GET requests
// This allows Vue Router (createWebHistory) to handle /r/:key, /admin, etc.
app.setNotFoundHandler(async (req, reply) => {
  const path = req.url.split('?')[0]
  if (req.method === 'GET' && !path.startsWith('/api/') && !/\.\w+$/.test(path)) {
    const idx = resolve(APP_ROOT, 'public', 'index.html')
    if (existsSync(idx)) return reply.type('text/html').send(readFileSync(idx))
  }
  return reply.status(404).send({ error: 'Not found', statusCode: 404 })
})

// ─── REST: room probing ───────────────────────────────────
app.get('/api/rooms/:key', async (req, reply) => {
  const ip = req.ip
  const { key } = req.params as { key: string }
  const upper = key.toUpperCase()

  if (checkAndRecord(ip, upper, 'probe')) {
    return reply.status(429).send({ error: 'Rate limited' })
  }
  if (!rooms.has(upper)) {
    return reply.status(404).send({ error: 'Not found' })
  }
  return reply.send({ key: upper })
})

// REST: create room
app.post('/api/rooms', async (req, reply) => {
  const ip = req.ip
  const body = (req.body as { key?: string } | null) ?? {}
  const key = (body.key ?? '').toUpperCase() || generateKey()

  if (checkAndRecord(ip, key, 'create')) {
    return reply.status(429).send({ error: 'Rate limited' })
  }
  if (bannedKeys.has(key)) {
    return reply.status(403).send({ error: 'Banned' })
  }
  // Create room entry (with no members yet)
  getOrCreateRoom(key)
  return reply.send({ key })
})

// ─── Register admin routes ────────────────────────────────
await registerAdminRoutes(app)

// ─── ICE: shared STUN list ───────────────────────────────
// Single source of truth for the STUN servers every client should use. Both
// the browser and the MCP server fetch this on connect so they can't drift
// from `config.yaml` independently.
app.get('/api/ice', async (_req, reply) => {
  return reply.send({ iceServers: STUN_URLS.map(urls => ({ urls })) })
})

// ─── TURN credentials ─────────────────────────────────────
// Supports two auth modes:
//   HMAC (preferred): set TURN_SECRET — time-limited credentials, coturn use-auth-secret
//   Static:           set TURN_USERNAME + TURN_CREDENTIAL — plain username/password
// Returns 503 when no TURN is configured (non-fatal; app falls back to WS relay).
app.get('/api/turn-credentials', async (req, reply) => {
  if (TURN_URLS.length === 0) {
    return reply.status(503).send({ error: 'TURN not configured' })
  }

  if (TURN_SECRET) {
    // HMAC mode: time-limited credentials (coturn use-auth-secret)
    const expires = Math.floor(Date.now() / 1000) + TURN_TTL
    const username = `${expires}:${nanoid(8)}`
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64')
    return reply.send({ urls: TURN_URLS, username, credential })
  }

  if (TURN_USERNAME && TURN_CREDENTIAL) {
    // Static mode: plain username/password
    return reply.send({ urls: TURN_URLS, username: TURN_USERNAME, credential: TURN_CREDENTIAL })
  }

  // URLs configured but no auth — return URLs with empty creds (some servers allow no-auth)
  return reply.send({ urls: TURN_URLS, username: '', credential: '' })
})

// ─── Metered.ca built-in TURN provider ───────────────────────
// Server-side fetch of temporary credentials. The API key stays here; the
// browser only ever sees the resulting `iceServers` array and an `expiresAt`
// timestamp used to schedule rotation ~10 min before credentials die.
app.get('/api/turn-metered', async (_req, reply) => {
  if (!METERED_ENABLED) {
    return reply.status(503).send({ error: 'Metered not configured' })
  }
  const url = `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`
  // Hard timeout so a slow / hung upstream never holds the Fastify response
  // open past the reverse-proxy read deadline (Caddy would otherwise close
  // the connection and Cloudflare would return its own 502 with no body).
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 6000)
  try {
    const r = await fetch(url, { signal: ac.signal })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      app.log.warn({ status: r.status, body: body.slice(0, 200) }, 'metered upstream non-2xx')
      return reply.status(502).send({ error: 'Metered upstream failed', status: r.status })
    }
    const text = await r.text()
    let list: unknown
    try {
      list = JSON.parse(text)
    } catch {
      app.log.warn({ body: text.slice(0, 200) }, 'metered upstream returned non-JSON')
      return reply.status(502).send({ error: 'Metered returned non-JSON' })
    }
    if (!Array.isArray(list) || list.length === 0) {
      return reply.status(502).send({ error: 'Metered returned empty list' })
    }
    const expiresAt = Math.floor(Date.now() / 1000) + METERED_TTL
    return reply.send({ enabled: true, iceServers: list, expiresAt, ttl: METERED_TTL })
  } catch (e: any) {
    const aborted = e?.name === 'AbortError'
    app.log.warn({ err: String(e?.message ?? e), aborted }, 'metered fetch failed')
    return reply.status(502).send({
      error: aborted ? 'Metered fetch timed out' : 'Metered fetch failed',
      detail: String(e?.message ?? e),
    })
  } finally {
    clearTimeout(timer)
  }
})

// ─── WebSocket ────────────────────────────────────────────
app.register(async fastify => {
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    const ip = req.ip
    let currentClientId: string | null = null
    let currentRoomKey: string | null = null

    socket.on('message', (raw: Buffer | string) => {
      let msg: C2S
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      switch (msg.type) {
        case 'join': {
          const key = msg.roomKey.toUpperCase()

          // Protocol-version handshake (strict). Every conforming client
          // (browser, MCP, future third-party) MUST send `protocolVersion`
          // matching the server's. Missing field is treated as v0 and
          // rejected — there is no grandfathered "legacy" tier. This is a
          // zero-trust stance: anything that can't prove its version isn't
          // allowed to interact with rooms.
          if (msg.protocolVersion !== PROTOCOL_VERSION) {
            socket.send(JSON.stringify({ type: 'error', code: 'protocol_version_mismatch' }))
            return
          }

          if (checkAndRecord(ip, key, 'join')) {
            socket.send(JSON.stringify({ type: 'error', code: 'rate_limited' }))
            return
          }
          if (bannedKeys.has(key)) {
            socket.send(JSON.stringify({ type: 'room_banned' }))
            return
          }

          // Bots may only join rooms that already contain at least one human.
          // Rejecting *before* getOrCreateRoom avoids materialising an empty
          // bot-only room that nothing would ever clean up. A brand-new room
          // key, or a room whose only remaining members are other bots, both
          // fail this check — DarkenChat is built around human-led chat and a
          // bots-only room produces no useful interaction.
          if (msg.isBot) {
            const existing = rooms.get(key)
            const hasHuman = !!existing && [...existing.members.values()].some(m => !m.isBot)
            if (!hasHuman) {
              socket.send(JSON.stringify({ type: 'error', code: 'no_humans_in_room' }))
              return
            }
          }

          const room = getOrCreateRoom(key)

          // Bot limit
          if (msg.isBot) {
            const botCount = [...room.members.values()].filter(m => m.isBot).length
            if (botCount >= MAX_BOTS) {
              socket.send(JSON.stringify({ type: 'error', code: 'bot_limit' }))
              return
            }
          }

          // Member limit
          if (room.members.size >= MAX_MEMBERS) {
            socket.send(JSON.stringify({ type: 'error', code: 'room_full' }))
            return
          }

          currentRoomKey = key

          // Returning-member detection. Prefer the explicit `lastClientId`
          // handshake (immune to nickname collisions); fall back to nickname
          // match for older clients that don't send it.
          let isReturning = false
          let reusedClientId: string | null = null
          if (msg.lastClientId) {
            for (const [nick, info] of room.recentLeft) {
              if (info.clientId === msg.lastClientId && Date.now() - info.leftAt < RECENT_LEFT_TTL_MS) {
                isReturning = true
                reusedClientId = info.clientId
                room.recentLeft.delete(nick)
                break
              }
            }
          }
          if (!isReturning) {
            const info = room.recentLeft.get(msg.nickname)
            if (info && Date.now() - info.leftAt < RECENT_LEFT_TTL_MS) {
              isReturning = true
              reusedClientId = info.clientId
              room.recentLeft.delete(msg.nickname)
            }
          }

          currentClientId = reusedClientId ?? nanoid(12)

          // Dedup nickname against current members; append -2, -3, ... when colliding.
          // Returning members keep their name only if it's not in use by someone else.
          let finalNick = msg.nickname
          const existing = new Set([...room.members.values()].map(m => m.nickname))
          if (existing.has(finalNick)) {
            let n = 2
            while (existing.has(`${msg.nickname}-${n}`)) n++
            finalNick = `${msg.nickname}-${n}`
          }

          const member = {
            clientId: currentClientId,
            nickname: finalNick,
            joinedAt: Date.now(),
            isBot: msg.isBot ?? false,
            ws: socket,
            lastSeen: Date.now(),
          }

          addMember(room, member)

          // Send joined confirmation to new member
          socket.send(
            JSON.stringify({
              type: 'joined',
              clientId: currentClientId,
              nickname: finalNick,
              centerId: room.centerId,
              chairId: room.chairId,
              isReturning,
              nicknameSet: room.nicknameSet,
              aiTurnLimit: room.aiTurnLimit,
              members: [...room.members.values()].map(memberInfo),
            }),
          )

          // Notify existing members
          broadcast(
            room,
            {
              type: 'member_join',
              member: { ...memberInfo(member), isReturning },
            },
            currentClientId,
          )

          break
        }

        case 'leave': {
          handleLeave()
          break
        }

        case 'signal': {
          if (!currentRoomKey || !currentClientId) return
          const room = rooms.get(currentRoomKey)
          if (!room) return
          const target = room.members.get(msg.to)
          if (target) send(target, { type: 'signal', from: currentClientId, payload: msg.payload })
          break
        }

        case 'score': {
          if (!currentRoomKey || !currentClientId) return
          handleScore(currentRoomKey, currentClientId, msg.score)
          break
        }

        case 'relay': {
          if (!currentRoomKey || !currentClientId) return
          const room = rooms.get(currentRoomKey)
          if (!room) return
          const target = room.members.get(msg.to)
          if (target) send(target, { type: 'relay', from: currentClientId, data: msg.data })
          break
        }

        case 'member_conn': {
          if (!currentRoomKey) return
          const room = rooms.get(currentRoomKey)
          if (!room) return
          broadcast(room, { type: 'member_conn', clientId: msg.clientId, connType: msg.connType })
          break
        }

        case 'kick': {
          if (!currentRoomKey || !currentClientId) return
          const room = rooms.get(currentRoomKey)
          if (!room || room.chairId !== currentClientId) return

          const target = room.members.get(msg.targetId)
          if (!target) return

          send(target, { type: 'kicked' })
          {
            const prevChairId = room.chairId
            removeMember(room, msg.targetId)
            broadcast(room, {
              type: 'member_left',
              clientId: msg.targetId,
              nickname: target.nickname,
            })
            announceChairChange(room, prevChairId)
            dissolveIfBotsOnly(room)
          }
          break
        }

        case 'end_room': {
          if (!currentRoomKey || !currentClientId) return
          const room = rooms.get(currentRoomKey)
          if (!room || room.chairId !== currentClientId) return

          broadcast(room, { type: 'room_ended' })
          rooms.delete(currentRoomKey)
          currentRoomKey = null
          currentClientId = null
          break
        }

        case 'set_room_config': {
          // Chair-only: per-room AI hard turn cap. 0 = unlimited. Stored on
          // the room (so late joiners pick it up in their `joined` payload)
          // and broadcast to every member (humans + bots) so the MCP-side
          // RoomClient updates its enforcement state immediately.
          if (!currentRoomKey || !currentClientId) return
          const room = rooms.get(currentRoomKey)
          if (!room || room.chairId !== currentClientId) return
          const next = Math.max(0, Math.floor(Number(msg.aiTurnLimit) || 0))
          if (next === room.aiTurnLimit) break
          room.aiTurnLimit = next
          broadcast(room, {
            type: 'room_config',
            aiTurnLimit: next,
            byClientId: currentClientId,
          })
          break
        }

        case 'heartbeat': {
          if (currentRoomKey && currentClientId) {
            const m = rooms.get(currentRoomKey)?.members.get(currentClientId)
            if (m) m.lastSeen = Date.now()
          }
          socket.send(JSON.stringify({ type: 'ack' }))
          break
        }
      }
    })

    socket.on('close', handleLeave)

    function handleLeave() {
      if (!currentRoomKey || !currentClientId) return
      const room = rooms.get(currentRoomKey)
      if (!room) return

      const prevChairId = room.chairId
      const member = removeMember(room, currentClientId)
      if (member && rooms.has(currentRoomKey)) {
        broadcast(room, {
          type: 'member_left',
          clientId: currentClientId,
          nickname: member.nickname,
        })
        // Emit new_chair ONLY if removeMember actually migrated the chair
        // (i.e. the leaver was the chair and a human successor exists).
        announceChairChange(room, prevChairId)
        // If the leaver was the last human, shut the residue down so bots'
        // MCP loops terminate cleanly. Runs after the member_left broadcast
        // so clients see leave → room_ended in that order.
        dissolveIfBotsOnly(room)
      }

      currentRoomKey = null
      currentClientId = null
    }
  })
})

// ─── Heartbeat sweep ──────────────────────────────────────
// Evict members whose socket is silently dead (no heartbeat past the
// timeout) and prune `recentLeft` entries past the returning-member window.
// Without this, half-open WS connections leave ghost members in the room
// list and `recentLeft` grows unbounded.
setInterval(() => {
  const now = Date.now()
  for (const room of [...rooms.values()]) {
    // 1. Evict silent members
    for (const member of [...room.members.values()]) {
      if (now - member.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        try {
          member.ws.close()
        } catch {
          /* already dead */
        }
        const prevChairId = room.chairId
        const removed = removeMember(room, member.clientId)
        if (removed && rooms.has(room.key)) {
          broadcast(room, {
            type: 'member_left',
            clientId: removed.clientId,
            nickname: removed.nickname,
          })
          // Emit new_chair ONLY when the chair genuinely migrated — not on
          // every non-chair eviction (that was the old bug: it announced the
          // unchanged chair on every silent-member sweep).
          announceChairChange(room, prevChairId)
          // Same human-required rule as the leave / kick paths — if eviction
          // left the room with no humans, end it.
          dissolveIfBotsOnly(room)
        }
      }
    }
    // 2. Prune stale recentLeft entries
    for (const [nick, info] of room.recentLeft) {
      if (now - info.leftAt > RECENT_LEFT_TTL_MS) room.recentLeft.delete(nick)
    }
  }
}, HEARTBEAT_INTERVAL_MS)

// ─── Start ────────────────────────────────────────────────
await app.listen({ host: HOST, port: PORT })
console.log(`DarkenChat signaling server listening on ${HOST}:${PORT}`)

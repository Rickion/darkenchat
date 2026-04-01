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
import {
  rooms, generateKey, getOrCreateRoom,
  addMember, removeMember, broadcast, send, memberInfo,
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
  ? yaml.load(
      readFileSync(cfgPath, 'utf8').replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? ''),
    )
  : {}

const HOST  = cfg?.server?.host  ?? '0.0.0.0'
const PORT  = cfg?.server?.port  ?? 3000
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? cfg?.security?.admin_token ?? 'dev-token'
const CORS_ORIGINS: string[] | true =
  process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : cfg?.server?.cors_origins ?? true
const MAX_MEMBERS = cfg?.room?.max_members ?? 50
const MAX_BOTS    = cfg?.room?.max_bot_members ?? 3

// TURN — env vars take precedence over config.yaml.
// Auth: TURN_SECRET (HMAC, for coturn use-auth-secret) OR TURN_USERNAME+TURN_CREDENTIAL (static).
// HMAC is preferred when both are set.
const TURN_URLS: string[] =
  process.env.TURN_URLS
    ? process.env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean)
    : (cfg?.ice?.turn?.urls ?? [])
const TURN_SECRET     = process.env.TURN_SECRET     ?? cfg?.ice?.turn?.auth_secret  ?? ''
const TURN_USERNAME   = process.env.TURN_USERNAME   ?? ''
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL ?? ''
const TURN_TTL        = cfg?.ice?.turn?.ttl_seconds ?? 3600

// Metered.ca built-in TURN provider
const METERED_ENABLED = process.env.TURN_METERED_ENABLED === 'true' || cfg?.ice?.metered?.enabled === true
const METERED_API     = process.env.TURN_METERED_API ?? cfg?.ice?.metered?.api_url ?? ''

configureGuard({
  windowSeconds:     cfg?.security?.rate_limit?.window_seconds     ?? 60,
  maxKeyProbes:      cfg?.security?.rate_limit?.max_key_probes      ?? 10,
  banDurationSeconds: cfg?.security?.rate_limit?.ban_duration_seconds ?? 3600,
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
  const body = req.body as { key?: string } | null ?? {}
  let key = (body.key ?? '').toUpperCase() || generateKey()

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
    const expires    = Math.floor(Date.now() / 1000) + TURN_TTL
    const username   = `${expires}:${nanoid(8)}`
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
app.get('/api/turn-metered', async (req, reply) => {
  if (!METERED_ENABLED || !METERED_API) {
    return reply.status(503).send({ error: 'Metered not configured' })
  }
  return reply.send({ enabled: true, apiUrl: METERED_API })
})

// ─── WebSocket ────────────────────────────────────────────
app.register(async (fastify) => {
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    const ip = req.ip
    let currentClientId: string | null = null
    let currentRoomKey: string | null  = null

    socket.on('message', (raw: Buffer | string) => {
      let msg: C2S
      try { msg = JSON.parse(raw.toString()) }
      catch { return }

      switch (msg.type) {

        case 'join': {
          const key = msg.roomKey.toUpperCase()

          if (checkAndRecord(ip, key, 'join')) {
            socket.send(JSON.stringify({ type: 'error', code: 'rate_limited' }))
            return
          }
          if (bannedKeys.has(key)) {
            socket.send(JSON.stringify({ type: 'room_banned' }))
            return
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

          currentClientId = nanoid(12)
          currentRoomKey  = key

          // Check if this nickname was in the room recently (within 5 min = returning member)
          const RETURNING_TTL = 5 * 60 * 1000
          const leftAt = room.recentLeft.get(msg.nickname)
          const isReturning = !!leftAt && (Date.now() - leftAt) < RETURNING_TTL
          if (isReturning) room.recentLeft.delete(msg.nickname)

          const member = {
            clientId: currentClientId,
            nickname: msg.nickname,
            joinedAt: Date.now(),
            isBot:    msg.isBot ?? false,
            ws:       socket,
          }

          addMember(room, member)

          // Send joined confirmation to new member
          socket.send(JSON.stringify({
            type:        'joined',
            clientId:    currentClientId,
            centerId:    room.centerId,
            chairId:     room.chairId,
            isReturning,
            nicknameSet: room.nicknameSet,
            members:     [...room.members.values()].map(memberInfo),
          }))

          // Notify existing members
          broadcast(room, {
            type:   'member_join',
            member: { ...memberInfo(member), isReturning },
          }, currentClientId)

          break
        }

        case 'leave': {
          handleLeave()
          break
        }

        case 'signal': {
          if (!currentRoomKey) return
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

        case 'kick': {
          if (!currentRoomKey || !currentClientId) return
          const room = rooms.get(currentRoomKey)
          if (!room || room.chairId !== currentClientId) return

          const target = room.members.get(msg.targetId)
          if (!target) return

          send(target, { type: 'kicked' })
          removeMember(room, msg.targetId)
          broadcast(room, {
            type:     'member_left',
            clientId: msg.targetId,
            nickname: target.nickname,
          })
          break
        }

        case 'end_room': {
          if (!currentRoomKey || !currentClientId) return
          const room = rooms.get(currentRoomKey)
          if (!room || room.chairId !== currentClientId) return

          broadcast(room, { type: 'room_ended' })
          rooms.delete(currentRoomKey)
          currentRoomKey  = null
          currentClientId = null
          break
        }

        case 'heartbeat': {
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

      const member = removeMember(room, currentClientId)
      if (member && rooms.has(currentRoomKey)) {
        // Broadcast chair change if needed
        if (room.chairId !== currentClientId) {
          broadcast(room, {
            type:     'member_left',
            clientId: currentClientId,
            nickname: member.nickname,
          })
        } else {
          // Chair changed
          const newChair = room.members.get(room.chairId)
          broadcast(room, {
            type:     'member_left',
            clientId: currentClientId,
            nickname: member.nickname,
          })
          if (newChair) {
            broadcast(room, {
              type:     'new_chair',
              chairId:  newChair.clientId,
              nickname: newChair.nickname,
            })
          }
        }
      }

      currentRoomKey  = null
      currentClientId = null
    }
  })
})

// ─── Start ────────────────────────────────────────────────
await app.listen({ host: HOST, port: PORT })
console.log(`DarkenChat signaling server listening on ${HOST}:${PORT}`)

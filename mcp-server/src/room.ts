import { WebSocket } from 'ws'
import { nanoid } from 'nanoid'
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from './adapter/webrtc.js'
import { computeTally, type Tally } from './tally.js'

// Fallback STUN list, used only if /api/ice is unreachable. The canonical
// list lives in the signaling server's config.yaml and is served from
// /api/ice so MCP and the browser can't drift independently.
const FALLBACK_STUN: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]
const HEARTBEAT_MS = 3000
// If the DataChannel hasn't opened within this many ms after a join / center
// switch, give up on P2P for now and flip to WS-relay outbound so the AI is
// never silently stuck.
const CHANNEL_OPEN_TIMEOUT_MS = 10_000
// The AI has NO hard send cap any more. It still counts its own turns, and
// every Nth turn (N = CONVERGE_TURNS) the MCP server attaches a one-shot
// convergence reminder to that send_message result — i.e. fires at turn
// 12/24/36/…, not on every send past 12 — so the nudge stays visible but
// doesn't become noise. The notice is generated locally by the MCP server
// and is unrelated to the room's chat history. Configurable via env.
const CONVERGE_TURNS = Math.max(1, Number(process.env.DARKENCHAT_CONVERGE_TURNS ?? '12') || 12)
// History buffer cap for tally / get_messages / wait_for_mention.
const HISTORY_CAP = 500

// ── TURN / domain configuration ─────────────────────────────────────
// By default the MCP fetches TURN credentials from the signaling server it
// connects to (e.g. chat.darken.cc) and is therefore *locked* to that one
// domain. Supplying custom TURN servers via env lifts the lock — the AI may
// then join rooms on any signaling server, and that server's domain is also
// configurable (defaults to chat.darken.cc).
const DEFAULT_DOMAIN = process.env.DARKENCHAT_DEFAULT_DOMAIN ?? 'chat.darken.cc'
const CUSTOM_TURN_URLS: string[] = (process.env.DARKENCHAT_TURN_URLS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const CUSTOM_TURN_USERNAME = process.env.DARKENCHAT_TURN_USERNAME ?? ''
const CUSTOM_TURN_CREDENTIAL = process.env.DARKENCHAT_TURN_CREDENTIAL ?? ''
export const HAS_CUSTOM_TURN = CUSTOM_TURN_URLS.length > 0

/**
 * Whether the AI is allowed to join a room on `serverUrl`. With no custom TURN
 * configured the AI is restricted to DEFAULT_DOMAIN (it can only get working
 * ICE credentials from that one server); once custom TURN is supplied via env
 * any host is allowed.
 */
export function isServerAllowed(serverUrl: string): { ok: true } | { ok: false; reason: string } {
  if (HAS_CUSTOM_TURN) return { ok: true }
  let host: string
  try {
    host = new URL(serverUrl).hostname
  } catch {
    return { ok: false, reason: `Invalid serverUrl: ${serverUrl}` }
  }
  if (host === DEFAULT_DOMAIN) return { ok: true }
  return {
    ok: false,
    reason: `domain_locked: without custom TURN configured (set DARKENCHAT_TURN_URLS), this MCP can only join rooms on "${DEFAULT_DOMAIN}". Requested host "${host}" is not allowed.`,
  }
}

export type RoomStatus = 'connecting' | 'connected' | 'kicked' | 'room_ended' | 'room_banned' | 'disconnected'

export interface RoomMember {
  clientId: string
  nickname: string
  isBot?: boolean
  joinedAt?: number
}

// Outbound send result. The AI no longer has a hard cap; `turnCount` is its
// running self-count and `convergeNotice` is the MCP-local nudge that appears
// on every Nth turn (N = CONVERGE_TURNS), i.e. at turn 12/24/36/….
export interface SendOk {
  ok: true
  transport: 'p2p' | 'relay'
  messageId: string
  timestamp: number
  turnCount: number
  convergeAt: number
  convergeNotice?: string
}

export interface RoomSession {
  clientId: string
  nickname: string // ← server-assigned (may differ from requested due to dedup)
  nicknameSet: string
  roomKey: string
  members: RoomMember[]
}

export interface MentionRef {
  clientId: string
  nickname: string
}

import { MENTION_ALL_ID, MENTION_ALL_AI_ID, MENTION_ALL_ALIASES, MENTION_ALL_AI_ALIASES } from './_shared/mentions.js'
import { PROTOCOL_VERSION } from './_shared/protocol.js'
export { MENTION_ALL_ID, MENTION_ALL_AI_ID }

export interface IncomingMessage {
  from: string
  fromId: string
  timestamp: number
  content: string // plain text, HTML stripped (mention text "@Nick" preserved)
  isSystem: boolean
  mentions?: MentionRef[]
  mentionedMe?: boolean
  transport?: 'p2p' | 'relay'
}

type MessageListener = (msg: IncomingMessage) => void

// ────────────────────────────────────────────────────────────────────
// HTML helpers
// ────────────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c],
  )
}
function decodeHtmlAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Pulls structured mention refs out of a Tiptap-style HTML payload.
 * The browser's RichEditor renders mentions as:
 *   <span class="mention" data-mention-id="..." data-label="...">@Alice</span>
 */
function parseMentions(html: string): MentionRef[] {
  const refs: MentionRef[] = []
  const re = /<span\b[^>]*>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const tag = match[0]
    if (!/class\s*=\s*"[^"]*\bmention\b/.test(tag)) continue
    const idMatch = tag.match(/data-mention-id\s*=\s*"([^"]*)"/)
    const labelMatch = tag.match(/data-label\s*=\s*"([^"]*)"/)
    if (!idMatch) continue
    let label = labelMatch?.[1] ?? ''
    if (!label) {
      // Fallback: read the "@Nick" text that follows the opening tag
      const tail = html.slice(match.index + tag.length).match(/^@([^<]+)/)
      label = tail ? tail[1].trim() : ''
    }
    refs.push({
      clientId: decodeHtmlAttr(idMatch[1]),
      nickname: decodeHtmlAttr(label),
    })
  }
  return refs
}

/**
 * Turns AI-supplied plain text into the same HTML the browser editor emits.
 * - `@Alice` is rewritten to a mention chip when (a) an explicit `mentions`
 *   array was passed, or (b) the nickname matches a current room member.
 * - newlines become paragraph breaks (matches the existing `<p>...</p>` style).
 */
function buildContent(plain: string, mentions: MentionRef[] | undefined, members: RoomMember[]): string {
  const resolved: MentionRef[] = mentions?.filter(m => m && m.clientId && m.nickname) ?? []
  if (resolved.length === 0) {
    // Auto-detect against current member list. Longer nicknames first so a
    // member named "Al" doesn't shadow "Alice".
    const sorted = [...members].sort((a, b) => b.nickname.length - a.nickname.length)
    const seen = new Set<string>()
    for (const m of sorted) {
      if (seen.has(m.clientId)) continue
      const re = new RegExp('@' + escapeRegex(m.nickname) + '(?![\\w-])')
      if (re.test(plain)) {
        resolved.push({ clientId: m.clientId, nickname: m.nickname })
        seen.add(m.clientId)
      }
    }
    // Auto-detect @all-AI first (longer / more specific aliases).
    for (const alias of MENTION_ALL_AI_ALIASES) {
      const re = new RegExp('@' + escapeRegex(alias) + '(?![\\w-])')
      if (re.test(plain)) {
        resolved.push({ clientId: MENTION_ALL_AI_ID, nickname: alias })
        break
      }
    }
    // Auto-detect @everyone in either locale.
    for (const alias of MENTION_ALL_ALIASES) {
      const re = new RegExp('@' + escapeRegex(alias) + '(?![\\w-])')
      if (re.test(plain)) {
        resolved.push({ clientId: MENTION_ALL_ID, nickname: alias })
        break
      }
    }
  }

  let html = escapeHtml(plain)
  for (const ref of resolved) {
    const nickHtml = escapeHtml(ref.nickname)
    const idAttr = escapeHtml(ref.clientId)
    const re = new RegExp('@' + escapeRegex(nickHtml) + '(?![\\w-])', 'g')
    html = html.replace(
      re,
      `<span class="mention" data-mention-id="${idAttr}" data-label="${nickHtml}">@${nickHtml}</span>`,
    )
  }
  return '<p>' + html.replace(/\n/g, '</p><p>') + '</p>'
}

interface IceFetchResult {
  ice: RTCIceServer[]
  // Unix-seconds expiry of the Metered temp credentials, or 0 when not using
  // Metered (no rotation needed).
  expiresAt: number
}

function apiBaseFromServer(serverUrl: string): string | null {
  try {
    const u = new URL(serverUrl)
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    u.pathname = '/api'
    return u.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/**
 * Pulls TURN/STUN config from the signaling server, mirroring the browser
 * priority: Metered.ca first, then self-hosted TURN, then STUN-only.
 *
 * Metered now returns the fully-resolved ICE list server-side along with an
 * `expiresAt` timestamp (temp credentials), which the caller uses to schedule
 * rotation before the creds die.
 */
async function fetchIceServers(serverUrl: string): Promise<IceFetchResult> {
  const apiBase = apiBaseFromServer(serverUrl)

  // Start with the server-published STUN list so config.yaml is the single
  // source of truth. Fall back to a built-in list only if the server is
  // unreachable (e.g. local-dev TURN-only setup).
  let ice: RTCIceServer[] = [...FALLBACK_STUN]
  if (apiBase) {
    try {
      const r = await fetch(`${apiBase}/ice`)
      if (r.ok) {
        const cfg = (await r.json()) as { iceServers?: RTCIceServer[] }
        if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) ice = [...cfg.iceServers]
      }
    } catch {
      /* keep fallback */
    }
  }

  // Custom TURN via env wins outright — and means we skip the server-provided
  // credentials entirely (those are tied to the default domain). This is what
  // unlocks joining rooms on arbitrary signaling servers.
  if (HAS_CUSTOM_TURN) {
    ice.push({
      urls: CUSTOM_TURN_URLS,
      username: CUSTOM_TURN_USERNAME || undefined,
      credential: CUSTOM_TURN_CREDENTIAL || undefined,
    })
    return { ice, expiresAt: 0 }
  }

  if (!apiBase) return { ice, expiresAt: 0 }

  // Priority 1: Metered.ca (now returns iceServers + expiresAt directly)
  try {
    const r = await fetch(`${apiBase}/turn-metered`)
    if (r.ok) {
      const cfg = (await r.json()) as {
        enabled?: boolean
        iceServers?: RTCIceServer[]
        expiresAt?: number
      }
      if (cfg.enabled && Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
        return { ice: [...ice, ...cfg.iceServers], expiresAt: cfg.expiresAt ?? 0 }
      }
    }
  } catch {
    /* ignore */
  }

  // Priority 2: self-hosted TURN
  try {
    const r = await fetch(`${apiBase}/turn-credentials`)
    if (r.ok) {
      const creds = (await r.json()) as { urls?: string | string[]; username?: string; credential?: string }
      if (creds.urls && (Array.isArray(creds.urls) ? creds.urls.length : creds.urls)) {
        ice.push({
          urls: creds.urls as string | string[],
          username: creds.username,
          credential: creds.credential,
        })
      }
    }
  } catch {
    /* ignore */
  }

  return { ice, expiresAt: 0 }
}

// ────────────────────────────────────────────────────────────────────
// Room client
// ────────────────────────────────────────────────────────────────────
export class RoomClient {
  private ws!: WebSocket
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private session: RoomSession | null = null
  private listeners: MessageListener[] = []
  // Long-poll waiters registered by `waitForMention`. Resolved the moment a
  // matching message arrives, or by setTimeout on the wait deadline, or by
  // terminate() when the room ends mid-wait.
  private waiters: Array<{
    matcher: (m: IncomingMessage) => boolean
    resolve: (msgs: IncomingMessage[]) => void
    timer: NodeJS.Timeout
  }> = []
  private hbTimer: NodeJS.Timeout | null = null
  private channelOpenTimer: NodeJS.Timeout | null = null
  private rotationTimer: NodeJS.Timeout | null = null
  private centerId = ''
  private serverUrl = ''
  private iceServers: RTCIceServer[] = FALLBACK_STUN
  // Unix-seconds expiry of the Metered temp credentials currently loaded into
  // `iceServers`. 0 when not using Metered → no rotation scheduled.
  private iceExpiresAt = 0
  private relayEnabled = false
  // Perfect-negotiation state. We are always the polite peer (the center is
  // impolite — its offers win on glare). `makingOffer` lets handleSignal
  // distinguish a genuine remote offer from one we collided with.
  private polite = true
  private makingOffer = false
  private status: RoomStatus = 'connecting'
  // Internal rolling history buffer — sized to HISTORY_CAP. Owned by the
  // RoomClient so tally + waitForMention + get_messages share one view.
  private history: IncomingMessage[] = []
  // Outbound turn counter — the AI's own running self-count. There is no
  // hard *AI-level* cap; on every multiple of CONVERGE_TURNS the
  // send_message result carries a convergence reminder (see buildSendResult).
  private sentCount = 0
  // Per-room hard cap on this AI's chat-message count, set by the human chair
  // via `set_room_config`. 0 means "no limit". When `sentCount` reaches this,
  // `sendMessage` hard-refuses and the AI is told to leave_room immediately.
  private roomTurnLimit = 0
  // Auto-CONSENSUS one-shot guard.
  private consensusEmitted = false

  // Public introspection -----------------------------------------------------
  getStatus(): RoomStatus {
    return this.status
  }
  getSession(): RoomSession | null {
    return this.session
  }
  getHistory(): IncomingMessage[] {
    return this.history
  }
  turnInfo(): { count: number; convergeAt: number; roomLimit: number } {
    return { count: this.sentCount, convergeAt: CONVERGE_TURNS, roomLimit: this.roomTurnLimit }
  }
  getRoomTurnLimit(): number {
    return this.roomTurnLimit
  }

  /**
   * Whether *this* AI is the panel chairperson — by default the first AI to
   * enter the room. Computed live from the member list (earliest-joined bot),
   * so if the chair AI leaves, the next-earliest AI inherits the role.
   */
  isChair(): boolean {
    const s = this.session
    if (!s) return false
    const me = s.members.find(m => m.clientId === s.clientId)
    const myJoinedAt = me?.joinedAt ?? 0
    const bots = s.members.filter(m => m.isBot)
    if (!bots.some(b => b.clientId === s.clientId)) return false
    return bots.every(
      b =>
        b.clientId === s.clientId ||
        (b.joinedAt ?? 0) > myJoinedAt ||
        ((b.joinedAt ?? 0) === myJoinedAt && s.clientId < b.clientId),
    )
  }
  computeTally(): Tally | null {
    if (!this.session) return null
    return computeTally(this.history, this.session.members)
  }
  isActive(): boolean {
    return this.status === 'connecting' || this.status === 'connected'
  }
  transportInUse(): 'p2p' | 'relay' | 'none' {
    if (this.channel?.readyState === 'open') return 'p2p'
    if (this.relayEnabled && this.ws?.readyState === WebSocket.OPEN) return 'relay'
    return 'none'
  }

  // Join ---------------------------------------------------------------------
  async join(serverUrl: string, roomKey: string, nickname = 'AI'): Promise<RoomSession> {
    this.serverUrl = serverUrl
    const fetched = await fetchIceServers(serverUrl)
    this.iceServers = fetched.ice
    this.iceExpiresAt = fetched.expiresAt
    this.scheduleIceRotation()

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(serverUrl)

      this.ws.on('open', () => {
        this.ws.send(
          JSON.stringify({
            type: 'join',
            roomKey: roomKey.toUpperCase(),
            nickname,
            isBot: true,
            protocolVersion: PROTOCOL_VERSION,
          }),
        )
      })

      this.ws.on('message', async raw => {
        let msg: any
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }

        switch (msg.type) {
          case 'joined': {
            this.session = {
              clientId: msg.clientId,
              nickname: msg.nickname ?? nickname,
              nicknameSet: msg.nicknameSet ?? 'nato',
              roomKey: roomKey.toUpperCase(),
              members: msg.members ?? [],
            }
            this.centerId = msg.centerId
            this.status = 'connected'
            // Pick up the per-room hard turn cap set by the chair (0 = none).
            this.roomTurnLimit = Math.max(0, Math.floor(Number(msg.aiTurnLimit) || 0))

            if (msg.clientId !== msg.centerId) {
              this.armChannelTimeout()
              await this.initPeer(msg.centerId, /* polite */ true)
            } else {
              // We are center (rare; server normally excludes bots). No PC needed.
              this.relayEnabled = true
            }

            this.startHeartbeat()
            resolve(this.session)
            break
          }

          case 'signal': {
            await this.handleSignal(msg.from, msg.payload)
            break
          }

          case 'relay': {
            // First inbound relay frame: the room is operating in WS-relay
            // mode (server-side fan-out). Mark enabled so outbound goes the
            // same way and we don't fight a dead DataChannel.
            this.relayEnabled = true
            this.handleData(msg.from, msg.data, /* transport */ 'relay')
            break
          }

          case 'member_join': {
            this.session?.members.push(msg.member)
            // Surface to listeners + waiters so AIs running expert-panel
            // scripts can react ("a new expert joined, brief them").
            this.emitSystem(
              `${msg.member?.nickname ?? msg.member?.clientId ?? 'A new member'} joined the room`,
              msg.member?.nickname ?? 'system',
            )
            break
          }

          case 'member_left': {
            if (this.session) {
              this.session.members = this.session.members.filter(m => m.clientId !== msg.clientId)
            }
            // Surface to the AI as a system event so get_messages reflects it.
            this.emitSystem(`${msg.nickname ?? msg.clientId} left the room`, msg.nickname ?? '')
            break
          }

          case 'new_center': {
            // Center changed (rotation / center dropped out). Tear down the
            // old PC and dial the new center so messages keep flowing. The
            // new center has already pre-registered every bot in its own
            // relayPeers (frontend useRoom new_center handler), so we don't
            // have to poke it ourselves.
            const newCenterId = msg.centerId
            if (!newCenterId) break
            this.centerId = newCenterId
            this.closePeer()
            if (newCenterId !== this.session?.clientId) {
              this.armChannelTimeout()
              await this.initPeer(newCenterId, /* polite */ true)
            }
            this.emitSystem('Center node changed.', 'system')
            break
          }

          case 'new_chair': {
            // Informational only — bots aren't eligible.
            this.emitSystem(`${msg.nickname ?? msg.chairId} is now the chairperson.`, 'system')
            break
          }

          case 'room_config': {
            // The chair updated the per-room hard turn cap (0 = unlimited).
            // We surface a system message + a ROOM_LIMIT_REACHED sentinel once
            // we're already past the new limit so any pending wait_for_mention
            // wakes and the AI can leave on this turn.
            const next = Math.max(0, Math.floor(Number(msg.aiTurnLimit) || 0))
            const prev = this.roomTurnLimit
            this.roomTurnLimit = next
            if (next === 0) {
              this.emitSystem('Chair removed the AI hard turn cap (now unlimited).', 'system')
            } else {
              this.emitSystem(
                `Chair set the AI hard turn cap to ${next} (you have spoken ${this.sentCount}).`,
                'system',
              )
            }
            if (next > 0 && this.sentCount >= next && (prev === 0 || this.sentCount < prev || prev > next)) {
              this.emitSystem(
                `ROOM_LIMIT_REACHED: ${this.sentCount}/${next}. Stop sending and call leave_room.`,
                'system',
              )
            }
            break
          }

          case 'kicked': {
            this.emitSystem('You were removed from the room by the chairperson.', 'system')
            this.terminate('kicked')
            break
          }

          case 'room_ended': {
            this.emitSystem('The room was closed by the chairperson.', 'system')
            this.terminate('room_ended')
            break
          }

          case 'room_banned': {
            this.emitSystem('This room is banned.', 'system')
            this.terminate('room_banned')
            // join() may still be pending — reject so callers get a clean error.
            reject(new Error('room_banned'))
            break
          }

          case 'error': {
            // Surfaced verbatim to the MCP host. `protocol_version_mismatch`
            // means this MCP build is incompatible with the signaling server —
            // user must upgrade the MCP package. Others (rate_limited, room_full,
            // bot_limit) are situational.
            if (msg.code === 'protocol_version_mismatch') {
              reject(
                new Error(
                  `protocol_version_mismatch: this MCP server speaks protocol v${PROTOCOL_VERSION} ` +
                    `but the signaling server expects a different version. Upgrade the darkenchat MCP package.`,
                ),
              )
            } else {
              reject(new Error(`signaling error: ${msg.code}`))
            }
            break
          }
        }
      })

      this.ws.on('close', () => {
        if (this.status === 'connected') this.terminate('disconnected')
      })
      this.ws.on('error', err => {
        if (!this.session) reject(err)
      })
    })
  }

  // Peer-connection lifecycle ------------------------------------------------
  // Mirrors frontend useWebRTC.ts: both sides always create a DataChannel and
  // both sides honour onnegotiationneeded. The `polite` flag only controls
  // glare resolution in handleSignal — it does NOT decide who initiates. ICE
  // walks the configured server list (STUN → custom TURN → default TURN); WS
  // relay is engaged only after `armChannelTimeout` / connectionstate=failed
  // declare P2P dead.
  private async initPeer(centerId: string, polite: boolean) {
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers })
    this.polite = polite
    this.makingOffer = false

    this.pc.onicecandidate = ({ candidate }: any) => {
      if (candidate) {
        this.ws.send(
          JSON.stringify({
            type: 'signal',
            roomKey: this.session!.roomKey,
            to: centerId,
            payload: { candidate: candidate.toJSON() },
          }),
        )
      }
    }

    this.pc.ondatachannel = ({ channel }: any) => {
      this.setupChannel(channel)
    }

    // Always create a local channel — the center mirrors this from its end.
    // Whoever's offer wins under perfect-negotiation drives the channel that
    // ends up open; the loser's channel is dropped silently.
    const ch = this.pc.createDataChannel('chat')
    this.setupChannel(ch)

    this.pc.onnegotiationneeded = async () => {
      if (!this.pc) return
      try {
        this.makingOffer = true
        await this.pc.setLocalDescription()
        this.ws.send(
          JSON.stringify({
            type: 'signal',
            roomKey: this.session!.roomKey,
            to: centerId,
            payload: { sdp: this.pc.localDescription },
          }),
        )
      } catch {
        /* swallow — handleSignal / armChannelTimeout will recover */
      } finally {
        this.makingOffer = false
      }
    }

    // Failed PC → outbound relay fallback. The center pre-registered us in
    // its relayPeers when we joined, so its chat fan-out already has a WS
    // path to reach us; we just need to flip our own outbound to relay.
    this.pc.onconnectionstatechange = () => {
      const st = this.pc?.connectionState
      if (st === 'failed' || st === 'closed') {
        this.relayEnabled = true
      }
    }
  }

  private closePeer() {
    if (this.channelOpenTimer) {
      clearTimeout(this.channelOpenTimer)
      this.channelOpenTimer = null
    }
    try {
      this.channel?.close()
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close()
    } catch {
      /* ignore */
    }
    this.channel = null
    this.pc = null
  }

  private setupChannel(ch: RTCDataChannel) {
    this.channel = ch
    ch.onopen = () => {
      if (this.channelOpenTimer) {
        clearTimeout(this.channelOpenTimer)
        this.channelOpenTimer = null
      }
    }
    ch.onclose = () => {
      // P2P died after being established → flip outbound to relay. Center's
      // pre-registration already keeps its inbound fan-out reaching us.
      this.relayEnabled = true
    }
    ch.onmessage = ({ data }: any) => {
      if (data === '__hb__') {
        try {
          ch.send('__ack__')
        } catch {
          /* ignore */
        }
        return
      }
      if (data === '__ack__') return
      this.handleData('', String(data), 'p2p')
    }
  }

  private armChannelTimeout() {
    if (this.channelOpenTimer) clearTimeout(this.channelOpenTimer)
    this.channelOpenTimer = setTimeout(() => {
      if (this.channel?.readyState !== 'open') {
        // ICE didn't converge in time — flip outbound to relay. Center's
        // pre-registration already covers the inbound direction.
        this.relayEnabled = true
      }
    }, CHANNEL_OPEN_TIMEOUT_MS)
  }

  // Data handling ------------------------------------------------------------
  private handleData(_fromId: string, raw: string, transport: 'p2p' | 'relay') {
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }

    // Drop control plane (file/voice/forward) — AI can't act on these meaningfully.
    if (parsed.type !== 'chat' && parsed.type !== 'system') return

    const rawHtml = typeof parsed.content === 'string' ? parsed.content : ''
    const mentions = parseMentions(rawHtml)
    const plain = rawHtml.replace(/<[^>]*>/g, '')

    const me = this.session?.clientId
    // @everyone targets every member and @all-AI targets every bot — since the
    // MCP client is always a bot, both sentinels count as mentioning me too.
    const mentionedMe =
      !!me && mentions.some(m => m.clientId === me || m.clientId === MENTION_ALL_ID || m.clientId === MENTION_ALL_AI_ID)

    const out: IncomingMessage = {
      from: parsed.from ?? '',
      fromId: parsed.fromId ?? '',
      timestamp: parsed.timestamp ?? Date.now(),
      content: plain,
      isSystem: !!parsed.isSystem,
      mentions: mentions.length ? mentions : undefined,
      mentionedMe: mentionedMe || undefined,
      transport,
    }
    this.pushHistory(out)
    for (const fn of this.listeners) fn(out)
    this.notifyWaiters(out)
    this.maybeEmitConsensus()
  }

  private pushHistory(msg: IncomingMessage) {
    this.history.push(msg)
    if (this.history.length > HISTORY_CAP) this.history.shift()
  }

  // Perfect-negotiation receiver. The polite peer (us) defers on offer glare
  // by accepting the remote offer and rolling back its own; the impolite peer
  // (center) ignores collisions. Mirrors the pattern in frontend useWebRTC.
  private async handleSignal(fromId: string, payload: any) {
    if (!this.pc) await this.initPeer(fromId, /* polite */ true)
    const pc = this.pc!

    if (payload.sdp) {
      const offerCollision = payload.sdp.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable')
      const ignoreOffer = !this.polite && offerCollision
      if (ignoreOffer) return

      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp))
      if (payload.sdp.type === 'offer') {
        await pc.setLocalDescription()
        this.ws.send(
          JSON.stringify({
            type: 'signal',
            roomKey: this.session!.roomKey,
            to: fromId,
            payload: { sdp: pc.localDescription },
          }),
        )
      }
    }
    if (payload.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(payload.candidate))
      } catch {
        /* stale */
      }
    }
  }

  // Synthesises a local system message so transport-level events (kicked,
  // new_center, …) show up in get_messages instead of being silent.
  private emitSystem(text: string, from: string) {
    const out: IncomingMessage = {
      from,
      fromId: 'system',
      timestamp: Date.now(),
      content: text,
      isSystem: true,
    }
    this.pushHistory(out)
    for (const fn of this.listeners) fn(out)
    this.notifyWaiters(out)
    // Do not call maybeEmitConsensus from here — it would recurse via the
    // synthetic system message we emit on consensus.
  }

  // Detects auto-CONSENSUS after every inbound chat message. Fires once.
  // Definition: ≥75% of *all* AI members in the room have, in their latest
  // structured message, the same normalised POSITION. The synthetic system
  // message ("CONSENSUS: <position>") wakes every waiter and signals the
  // panel to leave_room.
  private maybeEmitConsensus() {
    if (this.consensusEmitted) return
    if (!this.session) return
    const tally = computeTally(this.history, this.session.members)
    if (tally.totalAiMembers < 2) return
    const top = tally.stances[0]
    if (!top) return
    if (top.supporters.length < tally.consensusThreshold) return
    this.consensusEmitted = true
    this.emitSystem(`CONSENSUS: ${top.examplePosition}`, 'system')
  }

  // Resolves any pending long-poll waiters whose matcher accepts this message.
  // Each waiter resolves with just the triggering message; subsequent messages
  // arriving before the AI re-calls waitForMention land in `store` and will be
  // returned by its initial buffer check.
  private notifyWaiters(msg: IncomingMessage) {
    if (this.waiters.length === 0) return
    const kept: typeof this.waiters = []
    for (const w of this.waiters) {
      if (w.matcher(msg)) {
        clearTimeout(w.timer)
        w.resolve([msg])
      } else {
        kept.push(w)
      }
    }
    this.waiters = kept
  }

  private terminate(status: Exclude<RoomStatus, 'connecting' | 'connected'>) {
    if (!this.isActive()) return
    this.status = status
    if (this.hbTimer) {
      clearInterval(this.hbTimer)
      this.hbTimer = null
    }
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer)
      this.rotationTimer = null
    }
    this.closePeer()
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'leave', roomKey: this.session?.roomKey }))
        this.ws.close()
      }
    } catch {
      /* ignore */
    }
    // Unblock any in-flight waiters so the AI's long-poll doesn't hang past
    // the room's lifetime.
    if (this.waiters.length > 0) {
      for (const w of this.waiters) {
        clearTimeout(w.timer)
        w.resolve([])
      }
      this.waiters = []
    }
  }

  // Metered.ca temp-credential rotation -------------------------------------
  // Re-fetch a fresh ICE list ~10 min before `iceExpiresAt` so the active
  // TURN allocation (if any) can hand off to a new one before the old
  // credentials are rejected on the next Refresh. setConfiguration installs
  // the new servers without disturbing the open DataChannel; restartIce()
  // is fired only when we are currently routing through the relay.
  private scheduleIceRotation() {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer)
      this.rotationTimer = null
    }
    if (!this.iceExpiresAt) return
    const now = Math.floor(Date.now() / 1000)
    if (this.iceExpiresAt <= now) return
    const refreshInS = Math.max(5, this.iceExpiresAt - now - 600)
    this.rotationTimer = setTimeout(() => {
      this.rotateIceServers().catch(() => {})
    }, refreshInS * 1000)
  }

  private async rotateIceServers() {
    this.rotationTimer = null
    if (!this.isActive() || !this.serverUrl) return
    try {
      const fetched = await fetchIceServers(this.serverUrl)
      // Sanity: if rotation came back with no expiry (e.g., Metered now
      // disabled), don't churn the connection — just keep the old creds and
      // give up scheduling.
      if (!fetched.expiresAt) return
      this.iceServers = fetched.ice
      this.iceExpiresAt = fetched.expiresAt
      const pc = this.pc as any
      if (pc) {
        try {
          pc.setConfiguration?.({ iceServers: this.iceServers })
        } catch (e) {
          /* @roamhq/wrtc may not implement setConfiguration; falls through */ void e
        }
        // Restart ICE only if we look like we're using TURN relay right now.
        if (await this.isUsingRelay()) {
          try {
            pc.restartIce?.()
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* fall through to retry */
    } finally {
      this.scheduleIceRotation()
    }
  }

  // Heuristic: inspect getStats() for a nominated candidate pair using a
  // relay endpoint. Best-effort — if stats aren't available we treat it as
  // P2P (the safer/quieter default for rotation).
  private async isUsingRelay(): Promise<boolean> {
    const pc = this.pc as any
    if (!pc?.getStats) return false
    try {
      const stats = await pc.getStats()
      for (const [, r] of stats) {
        if (r.type === 'candidate-pair' && r.nominated) {
          const local = stats.get(r.localCandidateId)
          const remote = stats.get(r.remoteCandidateId)
          if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') return true
          return false
        }
      }
    } catch {
      /* ignore */
    }
    return false
  }

  private startHeartbeat() {
    this.hbTimer = setInterval(() => {
      try {
        this.ws.send(JSON.stringify({ type: 'heartbeat' }))
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_MS)
  }

  // Builds a successful send result, bumping the turn counter and attaching a
  // MCP-local convergence reminder on every Nth turn (N = CONVERGE_TURNS) —
  // i.e. it fires at turn 12, 24, 36, …, not every turn past 12. The notice
  // is generated here, by the MCP server — it never enters the room's chat
  // history.
  private buildSendResult(transport: 'p2p' | 'relay', id: string, timestamp: number): SendOk {
    this.sentCount++
    const result: SendOk = {
      ok: true,
      transport,
      messageId: id,
      timestamp,
      turnCount: this.sentCount,
      convergeAt: CONVERGE_TURNS,
    }
    if (this.sentCount > 0 && this.sentCount % CONVERGE_TURNS === 0) {
      result.convergeNotice =
        `[MCP system notice] You have now spoken ${this.sentCount} turns ` +
        `(reminder fires every ${CONVERGE_TURNS}). Start converging the discussion: ` +
        `focus on the core conclusion, stop restating, and — if you are the chairperson — ` +
        `move to summarise and declare CONSENSUS as soon as possible.`
    }
    return result
  }

  // Public message API -------------------------------------------------------
  // The AI counts its own turns and is *reminded* (not blocked) once it crosses
  // CONVERGE_TURNS — see buildSendResult. However if the chair has set a
  // per-room hard cap (`roomTurnLimit > 0`), sending is hard-refused once the
  // count reaches it — the AI must leave_room immediately.
  sendMessage(content: string, mentions?: MentionRef[]): SendOk | { ok: false; error: string } {
    if (!this.session) return { ok: false, error: 'Not joined' }
    if (!this.isActive()) return { ok: false, error: `Room status: ${this.status}` }
    if (this.roomTurnLimit > 0 && this.sentCount >= this.roomTurnLimit) {
      return {
        ok: false,
        error:
          `room_turn_limit_reached: this AI has spoken ${this.sentCount}/${this.roomTurnLimit} ` +
          `turns in this room (hard cap set by the chair). Stop sending and call leave_room.`,
      }
    }

    const html = buildContent(content, mentions, this.session.members)
    const msg = {
      id: nanoid(),
      type: 'chat',
      from: this.session.nickname,
      fromId: this.session.clientId,
      content: html,
      timestamp: Date.now(),
      roomKey: this.session.roomKey,
      isBot: true,
    }
    const raw = JSON.stringify(msg)

    if (this.channel?.readyState === 'open') {
      try {
        this.channel.send(raw)
        return this.buildSendResult('p2p', msg.id, msg.timestamp)
      } catch {
        /* fall through to relay */
      }
    }

    if (this.ws?.readyState === WebSocket.OPEN && this.centerId) {
      // We attempt WS relay even if not previously confirmed — the browser
      // gates on user consent, the AI just goes ahead.
      this.relayEnabled = true
      try {
        this.ws.send(JSON.stringify({ type: 'relay', to: this.centerId, data: raw }))
        return this.buildSendResult('relay', msg.id, msg.timestamp)
      } catch (e: any) {
        return { ok: false, error: `relay send failed: ${e?.message ?? e}` }
      }
    }

    return { ok: false, error: 'No transport available (DataChannel closed and WS not open)' }
  }

  getMessages(limit = 20, since?: number): IncomingMessage[] {
    const filtered = since ? this.history.filter(m => m.timestamp > since) : this.history
    return filtered.slice(-limit)
  }

  /**
   * Long-poll until a message matching the filter arrives, the room ends,
   * or the deadline elapses. Returns matching backlog synchronously when
   * already present.
   *
   * Matcher = (mentions me) OR (isSystem && includeSystem).
   * `since` lets callers avoid getting the same backlog twice.
   */
  waitForMention(timeoutMs: number, since: number | undefined, includeSystem: boolean): Promise<IncomingMessage[]> {
    const matcher = (m: IncomingMessage) => {
      if (since !== undefined && m.timestamp <= since) return false
      if (m.mentionedMe) return true
      if (includeSystem && m.isSystem) return true
      return false
    }
    const existing = this.history.filter(matcher)
    if (existing.length > 0) return Promise.resolve(existing)
    if (!this.isActive()) return Promise.resolve([])

    return new Promise<IncomingMessage[]>(resolve => {
      const entry = { matcher, resolve, timer: null as unknown as NodeJS.Timeout }
      entry.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== entry)
        resolve([])
      }, timeoutMs)
      this.waiters.push(entry)
    })
  }

  onMessage(fn: MessageListener) {
    this.listeners.push(fn)
  }

  leave() {
    this.terminate('disconnected')
    this.session = null
  }
}

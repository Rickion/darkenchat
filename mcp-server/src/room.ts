import { WebSocket } from 'ws'
import { nanoid } from 'nanoid'
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  webrtcAvailable,
  webrtcLoadError,
} from './adapter/webrtc.js'
import { computeTally, type Tally } from './tally.js'

// Fallback STUN list, used only if /api/ice is unreachable. The canonical
// list lives in the signaling server's config.yaml and is served from
// /api/ice so MCP and the browser can't drift independently.
const FALLBACK_STUN: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]
const HEARTBEAT_MS = 3000
// We mark the WS connection wedged if no `ack` frame has been seen for this
// long despite our heartbeat ticking every HEARTBEAT_MS — 10s = ~3 missed
// acks. When wedged we force-close the WS, which lets the existing silent
// reconnect path (ws.on('close')) take over. Without this check, a half-open
// TCP (kept alive by the OS / NAT box but no app traffic flowing) puts the
// MCP into a "pseudo-online" state where send_message looks ok but messages
// are silently dropped.
const HEARTBEAT_ACK_TIMEOUT_MS = 10_000
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
// Directed file-transfer control types (mirrors the browser's
// DIRECTED_FILE_TYPES). These carry a `to` clientId and ride the same data
// plane as chat; the center forwards them. The MCP only ever *requests* media
// (file_request) and consumes the chunk stream — it never hosts files.
const DIRECTED_FILE_TYPES = new Set(['file_request', 'file_chunk', 'file_end', 'file_error'])
// Give up on a fetch_media pull after this long with no further chunks.
const FETCH_MEDIA_TIMEOUT_MS = 120_000
// Silent reconnect parameters. When the signaling WebSocket drops (network
// blip, signaling restart, …) we re-open and re-join with `lastClientId` so
// the AI's wait_for_mention loop never sees a premature
// `roomStatus: 'disconnected'` from a transient blip. Only after exhausting
// all attempts do we surface the failure to the AI.
const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000

// Lifecycle diagnostics. Writes to stderr (NOT stdout — stdout is the MCP
// stdio protocol channel). Hosts that capture MCP stderr show these; the
// prefix + ISO timestamp make them greppable and correlatable with the
// browser console and the room's system messages.
export function dlog(...args: unknown[]): void {
  console.error(`[darkenchat ${new Date().toISOString()}]`, ...args)
}

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

// Structured expert-panel stance, attached to a chat message via the
// send_message tool's `stance` parameter. Replaces the old free-text
// ROUND/POSITION/AGREE_WITH/DISAGREE_WITH header — see tally.ts.
export interface MessageStance {
  position: string // this AI's stance, free text
  agreeWith?: string[] // clientIds this AI agrees with
  disagreeWith?: string[] // clientIds this AI disagrees with
}

// A media attachment carried by a `type:'file'` message. `mediaId` is the
// natural id the owner keyed the file under (= the browser's fileId); pass it
// to the fetch_media tool to pull the bytes. `ownerId` is the clientId we route
// the file_request to.
export interface MediaRef {
  mediaId: string
  name: string
  mime: string
  size: number
  ownerId: string
}

// A reply-to reference attached to a message. Mirrors the browser MessageQuote:
// `messageId` points at the quoted message and `mediaId` is that message's
// fileId when it quoted a media attachment (so the AI can fetch_media it).
export interface QuoteRef {
  messageId: string
  mediaId?: string
  fromNick: string
  preview: string
}

export interface IncomingMessage {
  // Present on every message we surface; lets the AI tell chat from file/voice/
  // forward. Defaults to 'chat' for our own buffered sends.
  type?: 'chat' | 'system' | 'file' | 'voice' | 'forward'
  // Stable message id (from the wire payload). Needed so the AI can reference a
  // message and so quote.messageId can be matched against history.
  id?: string
  from: string
  fromId: string
  timestamp: number
  content: string // plain text, HTML stripped (mention text "@Nick" preserved)
  isSystem: boolean
  mentions?: MentionRef[]
  mentionedMe?: boolean
  transport?: 'p2p' | 'relay'
  stance?: MessageStance // present on expert-panel messages
  media?: MediaRef // present on type:'file' messages
  quote?: QuoteRef // present when this message replied-to another
}

/** Map a wire `meta` FileMeta blob to a MediaRef. Returns undefined if malformed. */
function parseMedia(raw: unknown): MediaRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.fileId !== 'string' || typeof r.ownerId !== 'string') return undefined
  return {
    mediaId: r.fileId,
    name: typeof r.name === 'string' ? r.name : 'file',
    mime: typeof r.mime === 'string' ? r.mime : 'application/octet-stream',
    size: typeof r.size === 'number' ? r.size : 0,
    ownerId: r.ownerId,
  }
}

/** Validate a wire `quote` blob. Returns undefined when absent / malformed. */
function parseQuote(raw: unknown): QuoteRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.messageId !== 'string') return undefined
  return {
    messageId: r.messageId,
    mediaId: typeof r.mediaId === 'string' ? r.mediaId : undefined,
    fromNick: typeof r.fromNick === 'string' ? r.fromNick : '',
    preview: typeof r.preview === 'string' ? r.preview : '',
  }
}

/** Validate a wire `stance` blob. Returns undefined when absent / malformed. */
function parseStance(raw: unknown): MessageStance | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.position !== 'string' || !r.position.trim()) return undefined
  const ids = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
  return {
    position: r.position,
    agreeWith: ids(r.agreeWith),
    disagreeWith: ids(r.disagreeWith),
  }
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
  // Wall-clock timestamp of the last `ack` frame from signaling. Updated in
  // the message handler; checked by startHeartbeat to detect a wedged WS.
  private lastAckTime = 0
  private channelOpenTimer: NodeJS.Timeout | null = null
  private rotationTimer: NodeJS.Timeout | null = null
  private centerId = ''
  private serverUrl = ''
  // Remembered for silent WS reconnect (`scheduleReconnect`). Set in `join()`.
  private nickname = 'AI'
  // True after `leave()` / `kicked` / `room_ended` / `room_banned` / final
  // reconnect-exhaustion. Suppresses the otherwise-automatic reconnect on
  // WS close so we don't fight a real shutdown.
  private intentionalShutdown = false
  // Backoff state for silent reconnects. Cleared on each successful join.
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private iceServers: RTCIceServer[] = FALLBACK_STUN
  // Unix-seconds expiry of the Metered temp credentials currently loaded into
  // `iceServers`. 0 when not using Metered → no rotation scheduled.
  private iceExpiresAt = 0
  private relayEnabled = false
  // Whether we've already emitted the "WebRTC unavailable → relay-only" warning.
  private relayOnlyWarned = false
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
  // Auto round-complete guard. Records the normalised LABEL of the cluster we
  // last emitted a ROUND_COMPLETE message for. ROUND_COMPLETE fires once per
  // *distinct converged topic*: if the panel later converges on a different
  // topic (a cluster with a different label), the guard naturally re-arms.
  // The signal comes from the tally's agreement clustering (computed) rather
  // than from the AI remembering to bump a header.
  private lastConvergedPosition = ''
  // Floor for "what has the AI been shown". Advanced by getMessages /
  // waitForMention as they hand messages to the AI. sendMessage uses it to
  // detect a "stale send" — if a message mentioning this AI arrived between
  // its last read and its compose, that reply is likely based on outdated
  // context, so we refuse the send and force the AI to reconsider. See
  // `pendingMentionsForMe` and the unseen_mentions branch in sendMessage.
  private lastDeliveredTs = 0
  // In-flight fetch_media pulls, keyed by mediaId (= fileId). Each entry
  // accumulates chunk buffers and settles the fetch_media promise when the
  // stream completes (last chunk) or errors (file_error / timeout).
  private pendingFetches = new Map<
    string,
    {
      chunks: Buffer[]
      total: number
      received: number
      name: string
      mime: string
      resolve: (r: { data: Buffer; name: string; mime: string }) => void
      reject: (err: Error) => void
      timer: NodeJS.Timeout
    }
  >()

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
    this.nickname = nickname
    this.intentionalShutdown = false
    this.reconnectAttempts = 0
    // Backlog before this join is not "unread" — anchor the floor to now so
    // sendMessage doesn't immediately fire unseen_mentions on join.
    this.lastDeliveredTs = Date.now()

    const fetched = await fetchIceServers(serverUrl)
    this.iceServers = fetched.ice
    this.iceExpiresAt = fetched.expiresAt
    this.scheduleIceRotation()

    return new Promise<RoomSession>((resolve, reject) => {
      this.openWsAndJoin(roomKey, nickname, /* lastClientId */ undefined, resolve, reject)
    })
  }

  // Opens a fresh WebSocket and sends a join. Shared between:
  //   • initial connect — called from `join()`, `resolve`/`reject` settle the
  //     public Promise on the first server response;
  //   • silent reconnect — called from `scheduleReconnect()` with
  //     `lastClientId` so the signaling server treats us as a returning
  //     member (same `clientId`), and with `resolve`/`reject` both undefined
  //     so the second `joined` doesn't perturb any external Promise.
  private openWsAndJoin(
    roomKey: string,
    nickname: string,
    lastClientId: string | undefined,
    resolve: ((s: RoomSession) => void) | undefined,
    reject: ((err: Error) => void) | undefined,
  ): void {
    this.ws = new WebSocket(this.serverUrl)

    this.ws.on('open', () => {
      this.ws.send(
        JSON.stringify({
          type: 'join',
          roomKey: roomKey.toUpperCase(),
          nickname,
          isBot: true,
          protocolVersion: PROTOCOL_VERSION,
          ...(lastClientId ? { lastClientId } : {}),
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
          dlog(
            `${lastClientId ? 'RE-joined' : 'joined'} room=${roomKey.toUpperCase()}`,
            `clientId=${msg.clientId} center=${msg.centerId}`,
            `members=${(msg.members ?? []).length} reconnectAttempts=${this.reconnectAttempts}`,
          )
          // Pick up the per-room hard turn cap set by the chair (0 = none).
          this.roomTurnLimit = Math.max(0, Math.floor(Number(msg.aiTurnLimit) || 0))

          if (msg.clientId !== msg.centerId) {
            this.armChannelTimeout()
            await this.initPeer(msg.centerId, /* polite */ true)
          } else {
            // Unreachable in practice: the signaling server guarantees a bot
            // is never the centre (see signaling election.ts + rooms.ts
            // addMember — both reject bots from the centerId slot). This
            // branch is a defensive fallback only. It MUST stay unreachable
            // while `onnegotiationneeded` below is a no-op: a bot centre
            // would never send a WebRTC offer, so no DataChannel could
            // negotiate. To ever allow AI-as-centre, restore the bot's offer
            // capability in initPeer() first.
            this.relayEnabled = true
          }

          this.startHeartbeat()
          // Reset reconnect backoff after each successful join (initial or
          // silent recovery). The initial path is already 0; this matters
          // on reconnect.
          this.reconnectAttempts = 0
          resolve?.(this.session)
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
          // Snapshot panel-chair status *before* the leaver is removed, so
          // we can detect a handover to me on the next line. The panel
          // chair is the earliest-joined bot in the room — when that bot
          // leaves, the next-earliest bot silently inherits the role.
          // Without this notification the inheritor would never know it
          // had been promoted and would skip the chair duties (drive the
          // discussion, write the round summary).
          const wasChair = this.isChair()
          if (this.session) {
            this.session.members = this.session.members.filter(m => m.clientId !== msg.clientId)
          }
          const amChairNow = this.isChair()
          // Surface to the AI as a system event so get_messages reflects it.
          this.emitSystem(`${msg.nickname ?? msg.clientId} left the room`, msg.nickname ?? '')
          if (!wasChair && amChairNow) {
            this.emitSystem(
              `You have been promoted to AI panel chairperson because ${msg.nickname ?? 'the previous chair'} ` +
                `left the room. Take over chair duties now: coordinate the remaining AIs, drive the discussion, ` +
                `and write the round summary when the panel agrees. Do NOT leave the room — the server emits ` +
                `ROUND_COMPLETE on its own and the room stays open afterwards for the next topic.`,
              'system',
            )
          }
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
          // This is the *human* room chairperson (kick / end-room admin).
          // Bots are never eligible for that role. The separate AI panel
          // chair handover is announced from inside the member_left
          // handler above — don't confuse the two.
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
            this.emitSystem(`Chair set the AI hard turn cap to ${next} (you have spoken ${this.sentCount}).`, 'system')
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
          dlog('received KICKED from signaling')
          this.emitSystem('You were removed from the room by the chairperson.', 'system')
          // Real terminal state — suppress the auto-reconnect that ws.on('close') would otherwise kick off.
          this.intentionalShutdown = true
          this.terminate('kicked')
          break
        }

        case 'room_ended': {
          dlog('received ROOM_ENDED from signaling')
          this.emitSystem('The room was closed by the chairperson.', 'system')
          this.intentionalShutdown = true
          this.terminate('room_ended')
          break
        }

        case 'room_banned': {
          this.emitSystem('This room is banned.', 'system')
          this.intentionalShutdown = true
          this.terminate('room_banned')
          // join() may still be pending — reject so callers get a clean error.
          reject?.(new Error('room_banned'))
          break
        }

        case 'error': {
          // Surfaced to the MCP host. A few codes warrant a more actionable
          // message; the rest pass through verbatim. All `error` codes from
          // signaling are protocol-level rejections — never retry.
          this.intentionalShutdown = true
          if (msg.code === 'protocol_version_mismatch') {
            reject?.(
              new Error(
                `protocol_version_mismatch: this MCP server speaks protocol v${PROTOCOL_VERSION} ` +
                  `but the signaling server expects a different version. Upgrade the darkenchat MCP package.`,
              ),
            )
          } else if (msg.code === 'no_humans_in_room') {
            reject?.(
              new Error(
                `no_humans_in_room: this room has no human members. DarkenChat is built for ` +
                  `human-led conversations, so AI bots cannot join an empty room or a room that ` +
                  `only contains other bots. Ask the human who invited you to enter the room first, ` +
                  `then retry join_room.`,
              ),
            )
          } else {
            reject?.(new Error(`signaling error: ${msg.code}`))
          }
          break
        }

        case 'ack': {
          // Server-acked heartbeat. Updating this timestamp is what tells
          // startHeartbeat the WS is still live (not silently half-open).
          this.lastAckTime = Date.now()
          break
        }
      }
    })

    this.ws.on('close', () => {
      // Three cases:
      //   1. Intentional shutdown (leave / kicked / room_ended / banned /
      //      retry-exhausted) — already cleaned up, nothing to do.
      //   2. Initial connect never completed (no session) — settle the
      //      pending join Promise so the caller doesn't hang forever.
      //   3. We had a working session and the socket just dropped — silent
      //      reconnect (the whole point of this refactor). The AI's
      //      wait_for_mention waiters stay alive; the AI never sees a fake
      //      timeout or premature 'disconnected'. Transport-level retry is
      //      decoupled from the AI's business loop.
      dlog(
        `WS 'close' fired — intentionalShutdown=${this.intentionalShutdown} status=${this.status} hasSession=${!!this.session}`,
      )
      if (this.intentionalShutdown) return
      if (!this.session) {
        reject?.(new Error('signaling connection closed before join completed'))
        return
      }
      this.scheduleReconnect()
    })
    this.ws.on('error', err => {
      // Only meaningful before we have a session — after that, errors are
      // surfaced through the eventual 'close' (and handled by reconnect).
      if (!this.session) reject?.(err)
    })
  }

  // Peer-connection lifecycle ------------------------------------------------
  // Mirrors frontend useWebRTC.ts: both sides always create a DataChannel and
  // both sides honour onnegotiationneeded. The `polite` flag only controls
  // glare resolution in handleSignal — it does NOT decide who initiates. ICE
  // walks the configured server list (STUN → custom TURN → default TURN); WS
  // relay is engaged only after `armChannelTimeout` / connectionstate=failed
  // declare P2P dead.
  // Emitted once per client when native WebRTC is unavailable and we fall back
  // to WSS relay. Surfaced both to stderr (dlog) and to the room as a system
  // message so the operator understands why this AI consumes relay bandwidth.
  private warnRelayOnly() {
    if (this.relayOnlyWarned) return
    this.relayOnlyWarned = true
    dlog(
      `WebRTC native module unavailable (${webrtcLoadError ?? 'unknown'}) —`,
      `degraded to WSS relay-only. Messages route through the signaling server`,
      `(plaintext to the server, consumes its bandwidth). P2P/TURN disabled on this host.`,
    )
  }

  private async initPeer(centerId: string, polite: boolean) {
    // No usable native WebRTC on this host → run relay-only. The center
    // pre-registered us in its relayPeers when we joined, so the inbound
    // direction already has a WS path; flipping relayEnabled routes our
    // outbound the same way. We never build a PC, so no offer/answer/ICE.
    if (!webrtcAvailable) {
      this.relayEnabled = true
      this.warnRelayOnly()
      return
    }
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

    // Create a local channel so this side has something to send on once the
    // SCTP transport is up. The center's offer negotiates that transport;
    // our channel rides along on it (data channels added either side never
    // need their own offer/answer once SCTP exists).
    const ch = this.pc.createDataChannel('chat')
    this.setupChannel(ch)

    // The bot is ALWAYS the polite peer in DarkenChat's star topology — the
    // center is the impolite peer and the sole offerer. We deliberately do
    // NOT send our own offer:
    //   • createDataChannel above fires onnegotiationneeded; if we acted on
    //     it we'd send an offer and collide with the center's offer (glare).
    //   • The browser polite peer survives glare via *implicit rollback*
    //     when setRemoteDescription(offer) is called in 'have-local-offer'.
    //   • @roamhq/wrtc does NOT implement implicit rollback — the glare
    //     surfaces as the "Failed to set remote offer sdp: Called in wrong
    //     state: have-local-offer" error that wedged the PeerConnection.
    // By never generating a local offer, the bot is never in
    // 'have-local-offer', so the collision simply cannot happen. The center
    // always offers; we always answer (see handleSignal).
    this.pc.onnegotiationneeded = () => {
      /* intentionally a no-op — see comment above. Bot answers, never offers. */
    }

    // Failed PC → outbound relay fallback + tear down. The center
    // pre-registered us in its relayPeers when we joined, so its chat fan-out
    // already has a WS path to reach us; we just need to flip our own
    // outbound to relay AND free the dead PC so a later new_center or
    // signal-driven re-init starts from a clean slate. Previously we only
    // set relayEnabled; the stale PC would linger in 'failed', and its
    // half-open DataChannel (`channel.readyState !== 'open'` but still
    // referenced) confused the send path into "looks alive, isn't".
    this.pc.onconnectionstatechange = () => {
      const st = this.pc?.connectionState
      if (st === 'failed' || st === 'closed') {
        this.relayEnabled = true
        // Defer closePeer to the next tick — closing inside the state-change
        // event itself is asking for re-entrant trouble in some wrtc builds.
        setTimeout(() => {
          if (this.pc?.connectionState === 'failed' || this.pc?.connectionState === 'closed') {
            this.closePeer()
          }
        }, 0)
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

    // Directed file-transfer control (file_chunk / file_error from the owner in
    // response to our fetch_media file_request). Consume the chunk stream and
    // settle the matching pending fetch, then stop — these never become history.
    if (DIRECTED_FILE_TYPES.has(parsed.type)) {
      this.handleFileControl(parsed)
      return
    }

    // Surface chat/system AND media-bearing types (file/voice/forward). The old
    // code dropped the latter, which left the AI blind to images and replies.
    const KNOWN = new Set(['chat', 'system', 'file', 'voice', 'forward'])
    if (!KNOWN.has(parsed.type)) return // heartbeat / ack / unknown control

    const rawHtml = typeof parsed.content === 'string' ? parsed.content : ''
    const mentions = parseMentions(rawHtml)
    const plain = rawHtml.replace(/<[^>]*>/g, '')
    const media = parsed.type === 'file' ? parseMedia(parsed.meta) : undefined
    const quote = parseQuote(parsed.quote)

    const me = this.session?.clientId
    // @everyone targets every member and @all-AI targets every bot — since the
    // MCP client is always a bot, both sentinels count as mentioning me too.
    const mentionedMe =
      !!me && mentions.some(m => m.clientId === me || m.clientId === MENTION_ALL_ID || m.clientId === MENTION_ALL_AI_ID)

    // Give media/voice/forward a readable `content` so the AI isn't handed an
    // empty string when the wire payload had none.
    let content = plain
    if (!content) {
      if (media) content = `[${media.mime} attachment: ${media.name}]`
      else if (parsed.type === 'voice') content = '[voice session]'
      else if (parsed.type === 'forward') content = '[forwarded messages]'
    }

    const out: IncomingMessage = {
      type: parsed.type,
      id: typeof parsed.id === 'string' ? parsed.id : undefined,
      from: parsed.from ?? '',
      fromId: parsed.fromId ?? '',
      timestamp: parsed.timestamp ?? Date.now(),
      content,
      isSystem: !!parsed.isSystem,
      mentions: mentions.length ? mentions : undefined,
      mentionedMe: mentionedMe || undefined,
      transport,
      stance: parseStance(parsed.stance),
      media,
      quote,
    }
    if (media) {
      dlog(
        `handleData media message room=${this.session?.roomKey} from=${out.from} ` +
          `mediaId=${media.mediaId} mime=${media.mime} size=${media.size} owner=${media.ownerId}`,
      )
    }
    this.pushHistory(out)
    for (const fn of this.listeners) fn(out)
    this.notifyWaiters(out)
    this.maybeEmitConsensus()
  }

  // ── Directed file-transfer (fetch_media) ─────────────────────────────────
  // Send a directed control payload toward `to`. The MCP is never the center,
  // so this always routes through the center (channel first, WS relay fallback),
  // mirroring the browser's sendDirected for a non-center peer.
  private sendDirected(to: string, payload: object): boolean {
    const raw = JSON.stringify({ ...payload, to })
    if (this.channel?.readyState === 'open') {
      try {
        this.channel.send(raw)
        return true
      } catch {
        /* fall through to relay */
      }
    }
    if (this.ws?.readyState === WebSocket.OPEN && this.centerId) {
      this.relayEnabled = true
      try {
        this.ws.send(JSON.stringify({ type: 'relay', to: this.centerId, data: raw }))
        return true
      } catch {
        return false
      }
    }
    return false
  }

  // Consume file_chunk / file_error frames from a media owner and settle the
  // matching pending fetch. file_request / file_end are owner-side concerns the
  // MCP never receives (it only requests), so they're ignored here.
  private handleFileControl(parsed: any) {
    const fileId = typeof parsed.fileId === 'string' ? parsed.fileId : ''
    const entry = this.pendingFetches.get(fileId)
    if (!entry) return // not a fetch we started (or already settled)

    if (parsed.type === 'file_error') {
      dlog(`fetch_media file_error room=${this.session?.roomKey} fileId=${fileId} reason=${parsed.reason ?? '?'}`)
      this.settleFetchReject(fileId, new Error(`owner reported error: ${parsed.reason ?? 'unknown'}`))
      return
    }

    if (parsed.type === 'file_chunk') {
      try {
        const buf = Buffer.from(String(parsed.data ?? ''), 'base64')
        const seq = Number(parsed.seq)
        const total = Number(parsed.total)
        entry.chunks[seq] = buf
        entry.received++
        entry.total = total
        // Reset the inactivity timer on each chunk.
        clearTimeout(entry.timer)
        entry.timer = setTimeout(
          () => this.settleFetchReject(fileId, new Error('fetch_media timed out waiting for chunks')),
          FETCH_MEDIA_TIMEOUT_MS,
        )
        if (seq === total - 1) {
          const data = Buffer.concat(entry.chunks.filter(Boolean))
          dlog(`fetch_media complete room=${this.session?.roomKey} fileId=${fileId} bytes=${data.length}`)
          clearTimeout(entry.timer)
          this.pendingFetches.delete(fileId)
          entry.resolve({ data, name: entry.name, mime: entry.mime })
        }
      } catch (e: any) {
        this.settleFetchReject(fileId, new Error(`chunk decode failed: ${e?.message ?? e}`))
      }
    }
  }

  private settleFetchReject(fileId: string, err: Error) {
    const entry = this.pendingFetches.get(fileId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pendingFetches.delete(fileId)
    entry.reject(err)
  }

  /**
   * Pull a media attachment by mediaId (= fileId) from its owner. Looks the
   * media up in history to find the owner, sends a directed file_request, and
   * resolves with the reassembled bytes once the chunk stream completes.
   */
  fetchMedia(mediaId: string): Promise<{ data: Buffer; name: string; mime: string }> {
    if (!this.session) return Promise.reject(new Error('Not joined'))
    if (!this.isActive()) return Promise.reject(new Error(`Room status: ${this.status}`))

    // Find the most recent message carrying this media id.
    let media: MediaRef | undefined
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i].media
      if (m && m.mediaId === mediaId) {
        media = m
        break
      }
    }
    if (!media) return Promise.reject(new Error(`No media with id "${mediaId}" in room history`))

    if (media.ownerId === this.session.clientId) {
      return Promise.reject(new Error('This media was sent by you; the MCP does not host outgoing files'))
    }
    const ownerStill = this.session.members.some(m => m.clientId === media!.ownerId)
    if (!ownerStill) return Promise.reject(new Error('Media owner has left the room; the file is no longer available'))

    if (this.pendingFetches.has(mediaId)) {
      return Promise.reject(new Error('A fetch for this media is already in progress'))
    }

    dlog(`fetch_media START room=${this.session.roomKey} mediaId=${mediaId} owner=${media.ownerId} size=${media.size}`)
    return new Promise<{ data: Buffer; name: string; mime: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => this.settleFetchReject(mediaId, new Error('fetch_media timed out waiting for chunks')),
        FETCH_MEDIA_TIMEOUT_MS,
      )
      this.pendingFetches.set(mediaId, {
        chunks: [],
        total: 0,
        received: 0,
        name: media!.name,
        mime: media!.mime,
        resolve,
        reject,
        timer,
      })
      const sent = this.sendDirected(media!.ownerId, {
        type: 'file_request',
        from: this.session!.clientId,
        fileId: mediaId,
      })
      if (!sent) this.settleFetchReject(mediaId, new Error('No transport available to request media'))
    })
  }

  private pushHistory(msg: IncomingMessage) {
    this.history.push(msg)
    if (this.history.length > HISTORY_CAP) this.history.shift()
  }

  // Perfect-negotiation receiver. The polite peer (us) defers on offer glare
  // by accepting the remote offer and rolling back its own; the impolite peer
  // (center) ignores collisions. Mirrors the pattern in frontend useWebRTC.
  //
  // The whole body is wrapped in try/catch because this runs inside the
  // unawaited `ws.on('message', async …)` listener — an uncaught rejection
  // here would bubble up as `unhandledRejection` and (Node 15+) tear down
  // the MCP process, dropping all six tools from the host's tool list.
  // Failing this signal soft is correct: the channel-open timeout
  // (armChannelTimeout) will flip us to WS-relay if the negotiation never
  // completes, so the bot stays usable instead of vanishing.
  private async handleSignal(fromId: string, payload: any) {
    // Relay-only mode (no native WebRTC): we can't process offers/answers/ICE.
    // Ignore signalling frames — the center falls back to WS relay for us.
    if (!webrtcAvailable) return
    try {
      if (!this.pc) await this.initPeer(fromId, /* polite */ true)
      const pc = this.pc!

      if (payload.sdp) {
        const offerCollision = payload.sdp.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable')
        const ignoreOffer = !this.polite && offerCollision
        if (ignoreOffer) return

        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp))
        if (payload.sdp.type === 'offer') {
          // Explicit createAnswer + setLocalDescription(answer) — see comment
          // on the matching call inside onnegotiationneeded for the @roamhq/wrtc
          // incompatibility this works around.
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
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
    } catch (err) {
      // Fail soft + self-heal. Just emitting a system message used to leave
      // the PeerConnection wedged (e.g. stuck in 'have-local-offer' after a
      // setRemoteDescription clash) — the report's "2 hours pseudo-online,
      // send_message reports success but messages never arrive" came from
      // exactly that state. So we also:
      //   • close the half-dead PC (frees resources, stops emitting bad ICE)
      //   • flip outbound to WS-relay so the next send_message uses that
      //     path instead of writing into a closed DataChannel
      // The channel-open timeout / new_center signal will eventually drive
      // a fresh PC build if peer-side conditions improve; until then, relay
      // keeps the room functional.
      const detail = err instanceof Error ? err.message : String(err)
      dlog(`signal_failed: ${detail} — closing PC, falling back to relay`)
      this.emitSystem(`signal_failed: ${detail}`, 'system')
      this.closePeer()
      this.relayEnabled = true
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

  // Detects auto round-completion after every inbound chat message. Fires
  // at most once per *distinct converged topic*. Definition: the largest
  // AGREEMENT CLUSTER (bots transitively linked by `agreeWith`) covers ≥75%
  // of all AI members and is not contested by an internal `disagreeWith`.
  // Consensus is judged on the agreement graph, NOT on matching position
  // text, so AIs no longer have to copy each other's exact wording. The
  // synthetic system message ("ROUND_COMPLETE: …") wakes every waiter and
  // signals the panel that *this round* is done — it does NOT signal exit;
  // the room stays open for the next topic. If the panel later converges on a
  // *different* topic (different cluster label), the guard re-arms and a fresh
  // ROUND_COMPLETE fires. AIs are instructed (see tools.ts AGENT_RULES) to
  // acknowledge briefly and keep polling.
  private maybeEmitConsensus() {
    if (!this.session) return
    const tally = computeTally(this.history, this.session.members)
    if (tally.totalAiMembers < 2) return
    const top = tally.stances[0]
    if (!top) return
    if (top.contested) return // largest cluster is internally disputed → no consensus
    if (top.supporters.length < tally.consensusThreshold) return
    if (top.positionNorm === this.lastConvergedPosition) return
    this.lastConvergedPosition = top.positionNorm
    this.emitSystem(
      `ROUND_COMPLETE: panel converged on: ${top.label}. The room stays open. ` +
        `If you have a final addition or correction, send it now; otherwise reply briefly with ` +
        `"Confirmed, no further comments" and keep polling for the next topic or follow-up. ` +
        `Do NOT leave_room — only leave on terminal roomStatus or an explicit request from the human.`,
      'system',
    )
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
    dlog(`terminate(${status}) — was status=${this.status}`)
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
    // Reject any in-flight media fetches — the transport is gone.
    if (this.pendingFetches.size > 0) {
      for (const [id] of this.pendingFetches) {
        this.settleFetchReject(id, new Error(`Room ended (${status}) before media fetch completed`))
      }
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
    // Reset the ack clock on (re)connect. Without this, a fresh post-reconnect
    // heartbeat loop would inherit a stale lastAckTime from the previous
    // session and immediately trip the wedged-WS check.
    this.lastAckTime = Date.now()
    this.hbTimer = setInterval(() => {
      // Detect a wedged WebSocket *before* sending the next heartbeat. If
      // the server hasn't ack'd anything in HEARTBEAT_ACK_TIMEOUT_MS (~3
      // missed heartbeats), the connection is "pseudo-online" — TCP layer
      // is still ESTAB but no app traffic is flowing. Force-close so the
      // existing silent-reconnect path takes over. This is the precise
      // remedy for the report's "2 hours stuck, send_message returns
      // success but nothing arrives" symptom.
      const ackAge = Date.now() - this.lastAckTime
      if (ackAge > HEARTBEAT_ACK_TIMEOUT_MS) {
        dlog(`heartbeat: no ack for ${ackAge}ms (limit ${HEARTBEAT_ACK_TIMEOUT_MS}) — closing WS to force reconnect`)
        try {
          this.ws?.close()
        } catch {
          /* ignore — ws.on('close') will fire and trigger scheduleReconnect */
        }
        return
      }
      try {
        this.ws.send(JSON.stringify({ type: 'heartbeat' }))
      } catch (e) {
        dlog(
          `heartbeat send failed: ${e instanceof Error ? e.message : String(e)} (ws.readyState=${this.ws?.readyState})`,
        )
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
        `focus on the core conclusion and stop restating. If you are the chairperson, ` +
        `write the round summary now. Do NOT leave the room — the server emits ` +
        `ROUND_COMPLETE on its own once ≥75% of AIs share the same position, and the ` +
        `room stays open after that for the next topic.`
    }
    return result
  }

  // Public message API -------------------------------------------------------
  // The AI counts its own turns and is *reminded* (not blocked) once it crosses
  // CONVERGE_TURNS — see buildSendResult. However if the chair has set a
  // per-room hard cap (`roomTurnLimit > 0`), sending is hard-refused once the
  // count reaches it — the AI must leave_room immediately.
  sendMessage(
    content: string,
    mentions?: MentionRef[],
    stance?: MessageStance,
  ): SendOk | { ok: false; error: string; unseen?: IncomingMessage[] } {
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

    // Stale-send guard: if a chat message mentioning this AI arrived after the
    // AI's last get_messages / wait_for_mention return, the reply it composed
    // is based on outdated context. Hand the new messages back and let the AI
    // decide again. Advancing lastDeliveredTs before returning means a
    // retry-as-is wouldn't loop forever — the second attempt sees an empty
    // pending list and goes through. System messages and the bot's own
    // messages don't count (see pendingMentionsForMe).
    const pending = this.pendingMentionsForMe()
    if (pending.length > 0) {
      this.markDelivered(pending)
      return {
        ok: false,
        error:
          `unseen_mentions: ${pending.length} new message(s) mentioning you arrived while you were composing. ` +
          `Read them in \`unseen\` and decide whether your reply is still appropriate before retrying send_message.`,
        unseen: pending,
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
      // The structured stance rides in the message payload alongside content.
      // Every peer (incl. other bots' MCP) buffers it; tally reads it directly.
      ...(stance ? { stance } : {}),
    }
    const raw = JSON.stringify(msg)

    const onSent = (transport: 'p2p' | 'relay'): SendOk => {
      // Record our own message in our local history. The center fans out to
      // *other* peers (exceptId = us), so our own message never comes back
      // via handleData — without this, computeTally run on our own buffer
      // would miss our own stance. Re-check round-completion afterwards so
      // our own stance can be the one that completes the panel.
      this.pushHistory({
        from: this.session!.nickname,
        fromId: this.session!.clientId,
        timestamp: msg.timestamp,
        content,
        isSystem: false,
        transport,
        stance,
      })
      const result = this.buildSendResult(transport, msg.id, msg.timestamp)
      this.maybeEmitConsensus()
      return result
    }

    if (this.channel?.readyState === 'open') {
      try {
        this.channel.send(raw)
        return onSent('p2p')
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
        return onSent('relay')
      } catch (e: any) {
        return { ok: false, error: `relay send failed: ${e?.message ?? e}` }
      }
    }

    return { ok: false, error: 'No transport available (DataChannel closed and WS not open)' }
  }

  getMessages(limit = 20, since?: number): IncomingMessage[] {
    const filtered = since ? this.history.filter(m => m.timestamp > since) : this.history
    const slice = filtered.slice(-limit)
    this.markDelivered(slice)
    return slice
  }

  // Push the "what AI has seen" floor forward. Called by every tool that hands
  // messages to the AI. Monotonic — never moves backward (a backlog scan
  // shouldn't un-mark fresh messages as unread).
  private markDelivered(msgs: IncomingMessage[]): void {
    if (msgs.length === 0) return
    let max = this.lastDeliveredTs
    for (const m of msgs) if (m.timestamp > max) max = m.timestamp
    if (max > this.lastDeliveredTs) this.lastDeliveredTs = max
  }

  // Chat messages mentioning me that arrived after lastDeliveredTs. Used by
  // sendMessage to detect a stale send. Excludes:
  //   • system messages — they don't change reply context (and we already
  //     ROUND_COMPLETE-throttle the noisy ones)
  //   • my own messages — sending my own reply doesn't invalidate itself
  private pendingMentionsForMe(): IncomingMessage[] {
    const me = this.session?.clientId
    if (!me) return []
    return this.history.filter(
      m => m.timestamp > this.lastDeliveredTs && !m.isSystem && m.fromId !== me && m.mentionedMe,
    )
  }

  /**
   * Long-poll until a message matching the filter arrives, the room ends,
   * or the deadline elapses. Returns matching backlog synchronously when
   * already present.
   *
   * Matcher = (mentions me) OR (isSystem && includeSystem).
   * `since` lets callers avoid getting the same backlog twice — they SHOULD
   * always pass it. The hard cap below is just a safety net for callers that
   * don't: without it, an AI that polls without `since` after a long
   * conversation would pull all matching backlog (up to HISTORY_CAP = 500
   * messages) into the host's conversation context every single time,
   * burning tokens for no reason.
   */
  waitForMention(timeoutMs: number, since: number | undefined, includeSystem: boolean): Promise<IncomingMessage[]> {
    const matcher = (m: IncomingMessage) => {
      if (since !== undefined && m.timestamp <= since) return false
      if (m.mentionedMe) return true
      if (includeSystem && m.isSystem) return true
      return false
    }
    // Last-50 cap on the synchronous backlog return — see method docstring.
    const existing = this.history.filter(matcher).slice(-50)
    if (existing.length > 0) {
      this.markDelivered(existing)
      return Promise.resolve(existing)
    }
    if (!this.isActive()) return Promise.resolve([])

    return new Promise<IncomingMessage[]>(resolve => {
      const entry = { matcher, resolve, timer: null as unknown as NodeJS.Timeout }
      entry.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== entry)
        resolve([])
      }, timeoutMs)
      this.waiters.push(entry)
    }).then(msgs => {
      this.markDelivered(msgs)
      return msgs
    })
  }

  onMessage(fn: MessageListener) {
    this.listeners.push(fn)
  }

  leave() {
    dlog('leave() called — explicit shutdown')
    // Explicit shutdown — suppress the reconnect loop that ws.on('close')
    // would otherwise trigger when we close the socket below.
    this.intentionalShutdown = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.terminate('disconnected')
    this.session = null
  }

  // Silent reconnect on transient WebSocket loss. Tears down the now-dead
  // peer connection + heartbeat, parks the status at 'connecting' (NOT
  // 'disconnected' — the AI never sees a terminal state from a hiccup), then
  // re-opens the WebSocket with exponential backoff. Pending
  // wait_for_mention waiters are deliberately NOT resolved here — they keep
  // hanging until either a real message arrives after reconnect or their own
  // timeoutMs elapses (returning the same `{ keepalive: true }` frame the AI
  // would see for a quiet room). Only after MAX_RECONNECT_ATTEMPTS does this fall
  // through to a real terminate('disconnected'), with a system message so
  // the AI knows the room is finally unreachable.
  private scheduleReconnect(): void {
    if (this.intentionalShutdown) return
    if (!this.session || !this.serverUrl) {
      this.intentionalShutdown = true
      this.terminate('disconnected')
      return
    }
    // Tear down stale transport plumbing. Waiters stay untouched.
    this.closePeer()
    if (this.hbTimer) {
      clearInterval(this.hbTimer)
      this.hbTimer = null
    }
    this.status = 'connecting'

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      dlog(`scheduleReconnect — exhausted ${MAX_RECONNECT_ATTEMPTS} attempts, giving up`)
      this.emitSystem(
        `Signaling connection lost and ${MAX_RECONNECT_ATTEMPTS} reconnect attempts failed. ` +
          `Giving up — call leave_room.`,
        'system',
      )
      this.intentionalShutdown = true
      this.terminate('disconnected')
      return
    }

    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts)
    this.reconnectAttempts++
    dlog(`scheduleReconnect — attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.intentionalShutdown || !this.session) return
      try {
        // Re-use the same code path as the initial connect, but with
        // `lastClientId` so the server recognises us as a returning member
        // and we keep our existing clientId. No resolve/reject — the
        // original join() Promise was already settled on first connect.
        this.openWsAndJoin(this.session.roomKey, this.nickname, this.session.clientId, undefined, undefined)
      } catch {
        // openWsAndJoin synchronously throwing (e.g. WebSocket ctor) → bounce
        // back into the backoff loop.
        this.scheduleReconnect()
      }
    }, delay)
  }
}

import { useSignaling } from './useSignaling'
import { useWebRTC, loadBaseIceServers } from './useWebRTC'
import { useVoice, type VoiceEvent } from './useVoice'
import { useRoomStore } from '@/stores/room'
import { useMessagesStore } from '@/stores/messages'
import { useConnectionStore } from '@/stores/connection'
import { useTurnStore } from '@/stores/turn'
import { useFilesStore } from '@/stores/files'
import { useVoiceStore } from '@/stores/voice'
import type { Message, S2C, RTCSignal, FileMeta, VoiceSessionMeta } from '@/types'
import { PROTOCOL_VERSION } from '@/types'
import { nanoid } from 'nanoid'
import { calcDeviceScore } from '@/utils/score'

// Max age of messages included in catch-up bundles (10 minutes)
const CATCHUP_MAX_AGE_MS = 10 * 60 * 1000
// Max number of messages in a catch-up bundle
const CATCHUP_MAX_COUNT = 100

// File transfer
export const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB
// Files below this size are fetched eagerly the moment the file message lands
// (so images/audio/video render inline with no click); files at or above it
// require an explicit click to fetch (media) or download (other).
export const AUTO_FETCH_SIZE = 2 * 1024 * 1024 // 2 MB
const FILE_CHUNK_SIZE = 32 * 1024 // 32 KB binary → ~43 KB base64

// Files of these MIME families can be rendered / played inline in the chat log.
function isDisplayableMime(mime: string): boolean {
  return mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/')
}

// Directed control messages routed through the center peer.
const DIRECTED_FILE_TYPES = new Set(['file_request', 'file_chunk', 'file_end', 'file_error'])

// Voice channel control messages — broadcast (voice_join/leave) or directed
// (voice_announce); never stored in the chat history.
const VOICE_CONTROL_TYPES = new Set(['voice_join', 'voice_leave', 'voice_announce'])

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  // String.fromCharCode is fastest in chunks to avoid stack issues
  const STRIDE = 0x8000
  let s = ''
  for (let i = 0; i < bytes.length; i += STRIDE) {
    s += String.fromCharCode(...bytes.subarray(i, i + STRIDE))
  }
  return btoa(s)
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const s = atob(b64)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes.buffer
}

type RoomEvent =
  | { event: 'kicked' }
  | { event: 'room_ended' }
  | { event: 'room_banned' }
  | { event: 'connection_failed' }
  | { event: 'relay_request' } // WS relay needed — user must confirm
  | { event: 'relay_active' } // First incoming relay message (informational)
  | { event: 'p2p_recovered' } // P2P recovered to center before user decided on relay
  | { event: 'protocol_mismatch' } // Client + server are on different protocol versions
  | VoiceEvent // mic_denied / voice_full

export function useRoom(onEvent: (e: RoomEvent) => void) {
  const roomStore = useRoomStore()
  const msgStore = useMessagesStore()
  const connStore = useConnectionStore()
  const turnStore = useTurnStore()
  const filesStore = useFilesStore()
  const voiceStore = useVoiceStore()

  // Forward-declared so the signaling callback below can dispatch into it;
  // assigned after `signaling` and `sendDirected` have been set up. Must be
  // `let` (not `const`) because the assignment is not at the declaration site
  // — the closures above need the binding to exist first.
  // eslint-disable-next-line prefer-const
  let voice!: ReturnType<typeof useVoice>

  // ──────────────────────────────────────────────
  // WS relay state
  // ──────────────────────────────────────────────
  // `relayEnabled` is the user's consent decision for *my own* relay link
  // (only meaningful for non-center peers, whose only link is to center).
  //   null  → not yet decided (dialog pending)
  //   true  → user opted into server relay
  //   false → user declined; inbound relay frames are dropped
  let relayEnabled: boolean | null = null
  const relayQueue: Array<[string, string]> = []

  // `relayPeers` tracks per-peer "this peer is reachable only via WS relay"
  // state. Populated when we receive a relay frame from a peer (or send one
  // to them as the center) and cleared when a P2P channel to that peer
  // opens. Lets the center fan out P2P-where-possible / relay-where-needed
  // without degrading every peer to relay just because one is on WS.
  const relayPeers = new Set<string>()

  function confirmRelay(allow: boolean) {
    relayEnabled = allow
    if (allow) {
      for (const [id, raw] of relayQueue) {
        signaling.send({ type: 'relay', to: id, data: raw })
      }
      connStore.state = 'relay'
    } else {
      // User declined relay — mark all queued messages as failed.
      // The caller (Room.vue) is expected to follow up with leave() +
      // router.push('/') so the room is fully torn down; we also flip
      // connStore.state to 'failed' here so any UI that lingers shows the
      // accurate "no transport" state instead of "connecting…".
      for (const [, raw] of relayQueue) {
        try {
          const parsed = JSON.parse(raw)
          if (parsed.id) msgStore.markFailed(parsed.id)
        } catch {
          /* ignore */
        }
      }
      connStore.state = 'failed'
    }
    relayQueue.length = 0
  }

  // ──────────────────────────────────────────────
  // WebRTC layer
  // ──────────────────────────────────────────────
  const rtc = useWebRTC(
    (to, payload) => signaling.send({ type: 'signal', roomKey: roomStore.key, to, payload }),
    (fromId, raw) => handleData(fromId, raw),
    // onChannelOpen: runs when a DataChannel becomes open
    async peerId => {
      // 1. If we are the center, send catch-up history to returning members only
      if (roomStore.isCenter) {
        const peer = roomStore.members.find(m => m.clientId === peerId)
        if (peer?.isReturning) {
          const cutoff = Date.now() - CATCHUP_MAX_AGE_MS
          const history = msgStore.messages
            .filter(m => (m.type === 'chat' || m.type === 'forward') && m.timestamp > cutoff)
            .slice(-CATCHUP_MAX_COUNT)
          if (history.length > 0) {
            rtc.sendTo(peerId, JSON.stringify({ type: 'catchup', messages: history }))
          }
        }
      }
      // 2. Detect ICE connection type (p2p vs turn)
      const type = await rtc.detectConnectionType(peerId)
      if (connStore.state !== 'relay') {
        if (connStore.state === 'p2p' || type === 'p2p') {
          connStore.state = 'p2p'
        } else {
          connStore.state = type
        }
      }
      // 3. If center, broadcast member's connection type to all
      if (roomStore.isCenter) {
        signaling.send({ type: 'member_conn', clientId: peerId, connType: type })
      }
      // 4. P2P recovered after we'd queued a relay-confirmation prompt:
      // flush the backlog over the channel and tell the UI to dismiss the
      // pending "use server relay?" dialog so the user is no longer asked.
      relayPeers.delete(peerId)
      if (peerId === roomStore.centerId && relayEnabled === null) {
        if (relayQueue.length > 0) {
          for (const [id, raw] of relayQueue) {
            if (rtc.hasOpenChannel(id)) rtc.sendTo(id, raw)
            else {
              try {
                const p = JSON.parse(raw)
                if (p.id) msgStore.markFailed(p.id)
              } catch {
                /* ignore */
              }
            }
          }
          relayQueue.length = 0
        }
        // Always dismiss any pending relay-confirmation dialog: now that the
        // center DataChannel is open we no longer need WS fallback. (Previously
        // this only fired when a relayQueue had built up, so a heartbeat-popped
        // dialog with no queued messages would linger after recovery.)
        onEvent({ event: 'p2p_recovered' })
      }
    },
    // onChannelClose: DataChannel closed, trigger relay fallback if needed
    peerId => {
      // The center's link to me died (heartbeat timeout, remote close, ...).
      // Flip the indicator off "P2P" immediately so the badge stops lying,
      // and pop the relay-confirmation dialog right away rather than waiting
      // for the user to send a doomed message and discover it themselves.
      // If P2P/center re-election recovers first, p2p_recovered / new_center
      // will dismiss the dialog.
      if (peerId === roomStore.centerId) {
        if (connStore.state !== 'relay') connStore.state = 'connecting'
        roomStore.reconnecting = true
        if (relayEnabled === null) onEvent({ event: 'relay_request' })
      }
    },
  )

  // ──────────────────────────────────────────────
  // Signaling layer
  // ──────────────────────────────────────────────
  const signaling = useSignaling((msg: S2C) => {
    switch (msg.type) {
      case 'joined': {
        // Server may have suffixed the nickname (e.g. "alice" → "alice-2") to dedup.
        const requestedNick = roomStore.nickname
        const assignedNick = msg.nickname ?? requestedNick
        roomStore.setRoom({
          key: roomStore.key,
          clientId: msg.clientId,
          nickname: assignedNick,
          centerId: msg.centerId,
          chairId: msg.chairId,
          nicknameSet: msg.nicknameSet,
          members: msg.members,
          aiTurnLimit: msg.aiTurnLimit,
        })
        msgStore.load(roomStore.key)
        if (assignedNick !== requestedNick) {
          addSystemMessage('system.nickname_renamed', { from: requestedNick, to: assignedNick })
        }

        if (msg.clientId !== msg.centerId) {
          rtc.createPeer(msg.centerId, true /* polite */)
        }
        rtc.startHeartbeat(timedOutId => {
          if (timedOutId === roomStore.centerId) {
            signaling.send({
              type: 'score',
              roomKey: roomStore.key,
              score: calcDeviceScore(roomStore.members.length, connStore.state),
            })
            roomStore.removeMember(timedOutId)
          }
          // Non-center P2P timeout: relay fallback keeps messages flowing.
        })
        break
      }

      case 'member_join': {
        console.debug(
          `[darkenchat] member_join: ${msg.member.nickname} (${msg.member.clientId})`,
          `isBot=${!!msg.member.isBot} iAmCenter=${roomStore.isCenter}`,
        )
        roomStore.addMember(msg.member)
        if (roomStore.isCenter) {
          // Bots get the same P2P treatment as humans: try STUN → TURN first,
          // and only fall through to WS relay when ICE genuinely fails. The
          // MCP side speaks proper perfect-negotiation, so this is symmetric.
          rtc.createPeer(msg.member.clientId, false /* impolite, creates channel */)
          // Headless bots have no UI to confirm relay, and we don't want chat
          // fan-out silently dropped while ICE is still walking candidates.
          // Pre-register them in relayPeers as the WS-relay fallback target;
          // sendToMember still picks the open P2P channel first when one
          // exists, so this only activates if/when P2P fails.
          if (msg.member.isBot) {
            relayPeers.add(msg.member.clientId)
            // Connection-type icon back-stop: the broadcast in onChannelOpen
            // only fires if P2P actually opens, and the broadcast in `case
            // 'relay'` only fires once the bot SENDS its first relay frame.
            // A quiet bot whose P2P failed would otherwise have no icon at
            // all in the member list. After the channel-open window, if no
            // DC is open, declare it as relay so the icon shows up promptly.
            const botId = msg.member.clientId
            setTimeout(() => {
              if (!roomStore.isCenter) return
              if (rtc.hasOpenChannel(botId)) return // P2P / TURN won — onChannelOpen already broadcast
              if (!roomStore.members.some(m => m.clientId === botId)) return // already left
              const existing = roomStore.members.find(m => m.clientId === botId)?.connType
              if (existing) return // some path already set it
              signaling.send({ type: 'member_conn', clientId: botId, connType: 'relay' })
              roomStore.updateMemberConn(botId, 'relay')
            }, 12_000)
          }
        }
        voice.onMemberJoinedRoom(msg.member.clientId)
        // AI join system message — gear icon on the *first* AI message so a
        // human can open the room AI config dialog right there.
        if (msg.member.isBot) {
          const botCount = roomStore.members.filter(m => m.isBot).length
          const key = botCount === 1 ? 'system.join_ai_first' : 'system.join_ai'
          addSystemMessage(key, { name: msg.member.nickname })
        }
        break
      }

      case 'member_left': {
        const leftMember = roomStore.members.find(m => m.clientId === msg.clientId)
        console.debug(
          `[darkenchat] member_left: ${msg.nickname} (${msg.clientId})`,
          `isBot=${!!leftMember?.isBot} wasCenter=${msg.clientId === roomStore.centerId}`,
        )
        const wasCenter = msg.clientId === roomStore.centerId
        // Set reconnecting immediately so UI disables send/resend
        if (wasCenter) roomStore.reconnecting = true
        roomStore.removeMember(msg.clientId)
        rtc.closePeer(msg.clientId)
        relayPeers.delete(msg.clientId)
        voice.onMemberLeftRoom(msg.clientId)
        addSystemMessage('system.leave', { name: msg.nickname })
        if (wasCenter) {
          signaling.send({
            type: 'score',
            roomKey: roomStore.key,
            score: calcDeviceScore(roomStore.members.length, connStore.state),
          })
        }
        break
      }

      case 'new_center': {
        console.debug(`[darkenchat] new_center: ${msg.centerId} (iAmNewCenter=${msg.centerId === roomStore.clientId})`)
        roomStore.updateCenter(msg.centerId)
        roomStore.reconnecting = true
        connStore.state = 'connecting'
        // Center rotation invalidates all per-peer relay decisions — peer
        // relationships are reset and every link must be renegotiated.
        relayPeers.clear()
        if (msg.centerId !== roomStore.clientId) {
          rtc.closeAll()
          rtc.createPeer(msg.centerId, true)
        } else {
          // I just became the new center. clear() above wiped the bot
          // pre-registrations from the previous center's lifetime; bots won't
          // resend a relay frame just because re-election happened, so
          // re-prime them here from the current member list.
          for (const m of roomStore.members) {
            if (m.isBot) relayPeers.add(m.clientId)
          }
        }
        break
      }

      case 'new_chair': {
        console.debug(`[darkenchat] new_chair: ${msg.nickname} (${msg.chairId})`)
        roomStore.updateChair(msg.chairId)
        addSystemMessage('system.new_chair', { name: msg.nickname })
        break
      }

      case 'member_conn': {
        console.debug(`[darkenchat] member_conn: ${msg.clientId} → ${msg.connType}`)
        const hadConnType = roomStore.members.find(m => m.clientId === msg.clientId)?.connType
        roomStore.updateMemberConn(msg.clientId, msg.connType)
        if (!hadConnType) {
          const member = roomStore.members.find(m => m.clientId === msg.clientId)
          // Bots get their own AI-tailored system message in `member_join` so
          // we don't double-announce them here.
          if (member && !member.isBot) {
            const connTypeText = msg.connType === 'p2p' ? 'P2P' : msg.connType === 'turn' ? 'TURN' : 'Relay'
            addSystemMessage('system.join', { name: member.nickname, connType: connTypeText })
          }
        }
        break
      }

      case 'signal': {
        const sig = msg.payload as RTCSignal
        if (sig.channel === 'voice') {
          voice.handleVoiceSignal(msg.from, sig)
        } else {
          rtc.handleSignal(msg.from, sig, roomStore.isCenter)
        }
        break
      }

      case 'relay': {
        // User explicitly declined relay — refuse the inbound path too,
        // otherwise messages would still appear despite the cancel.
        if (relayEnabled === false) break
        // The sender is using WS relay. Track this per-peer so the center
        // doesn't degrade its global connStore.state just because one
        // member's link is on relay (see T7: single-peer relay must not
        // drag the whole room down to "server can read messages").
        const wasNew = !relayPeers.has(msg.from)
        relayPeers.add(msg.from)
        // First relay frame from this peer + I'm the center → tell everyone
        // their connType is 'relay' so member-list indicators stay truthful.
        if (wasNew && roomStore.isCenter) {
          signaling.send({ type: 'member_conn', clientId: msg.from, connType: 'relay' })
          // Update my own view too (broadcast skips self).
          roomStore.updateMemberConn(msg.from, 'relay')
        }
        if (relayEnabled === null) {
          relayEnabled = true
          // Flip the local privacy banner only when the relay link is *mine*
          // — i.e. I'm a non-center peer talking to center via WS. The
          // center receiving a relay frame from one peer keeps its banner
          // unchanged; its other links may still be P2P/TURN.
          if (!roomStore.isCenter) {
            connStore.state = 'relay'
            onEvent({ event: 'relay_active' })
          }
        }
        handleData(msg.from, msg.data)
        break
      }

      case 'kicked':
        console.debug('[darkenchat] received kicked')
        onEvent({ event: 'kicked' })
        break
      case 'room_ended':
        console.debug('[darkenchat] received room_ended')
        onEvent({ event: 'room_ended' })
        break
      case 'room_banned':
        console.debug('[darkenchat] received room_banned')
        onEvent({ event: 'room_banned' })
        break

      case 'error': {
        // Server-side rejection. The only error code we surface specially
        // is the protocol-version mismatch — the rest (rate_limited, room_full,
        // bot_limit, …) currently fall through and the user will see the
        // generic connection-lost path. Add cases here as they become
        // actionable in the UI.
        if (msg.code === 'protocol_version_mismatch') onEvent({ event: 'protocol_mismatch' })
        break
      }

      case 'room_config': {
        // Chair changed the AI hard turn cap. Update local state and post a
        // visible system message so everyone in the room sees what changed.
        const prev = roomStore.aiTurnLimit
        roomStore.aiTurnLimit = msg.aiTurnLimit
        if (msg.aiTurnLimit === 0) {
          addSystemMessage('system.room_config_unlimited')
        } else {
          addSystemMessage('system.room_config_set', { limit: String(msg.aiTurnLimit) })
        }
        if (prev !== msg.aiTurnLimit) {
          // (no further action — MCP enforces on the bot side)
        }
        break
      }
    }
  })

  // ──────────────────────────────────────────────
  // Send to one member — P2P preferred, relay fallback (with user consent).
  // Returns true if the message was handed off successfully (or queued for relay).
  // Returns false only if relay was explicitly declined and P2P is unavailable.
  // ──────────────────────────────────────────────
  function sendToMember(memberId: string, raw: string): boolean {
    if (rtc.hasOpenChannel(memberId)) {
      rtc.sendTo(memberId, raw)
      return true
    }
    // Per-peer relay (T7): the center forwards over WS to peers known to be
    // on relay, but keeps using P2P for everyone else. No global consent
    // dialog is required because the center never *generates* a relay link
    // — it only mirrors the joiner's decision to use WS for itself.
    if (roomStore.isCenter && relayPeers.has(memberId)) {
      signaling.send({ type: 'relay', to: memberId, data: raw })
      return true
    }
    if (relayEnabled === true) {
      signaling.send({ type: 'relay', to: memberId, data: raw })
      return true
    }
    if (relayEnabled === null && !roomStore.isCenter) {
      relayQueue.push([memberId, raw])
      onEvent({ event: 'relay_request' })
      return true
    }
    return false
  }

  // ──────────────────────────────────────────────
  // Data handler — P2P channel OR relay
  // ──────────────────────────────────────────────
  function handleData(fromId: string, raw: string) {
    try {
      const parsed = JSON.parse(raw)

      // ── Catch-up bundle ──────────────────────────────────────────────────
      // Sent by center to newly connected peers. Not a regular Message; do NOT forward.
      if (parsed.type === 'catchup' && Array.isArray(parsed.messages)) {
        for (const m of parsed.messages as Message[]) {
          if (!msgStore.messages.some(x => x.id === m.id)) {
            msgStore.add(m)
            msgStore.markCatchup(m.id)
          }
        }
        return
      }

      // ── Directed file-transfer control messages ──────────────────────────
      // These carry a `to` clientId. The center forwards them; everyone else
      // only handles messages addressed to themselves.
      if (DIRECTED_FILE_TYPES.has(parsed.type)) {
        if (parsed.to === roomStore.clientId) {
          handleFileControl(parsed)
        } else if (roomStore.isCenter) {
          sendToMember(parsed.to, raw)
        }
        return
      }

      // ── Voice control: directed (voice_announce) or broadcast (voice_join/leave) ──
      if (VOICE_CONTROL_TYPES.has(parsed.type)) {
        if (parsed.to) {
          // Directed
          if (parsed.to === roomStore.clientId) {
            voice.handleVoiceControl(parsed)
          } else if (roomStore.isCenter) {
            sendToMember(parsed.to, raw)
          }
        } else {
          // Broadcast — handle locally + (if center) fan out to others
          voice.handleVoiceControl(parsed)
          if (roomStore.isCenter) {
            for (const m of roomStore.members) {
              if (m.clientId !== roomStore.clientId && m.clientId !== fromId) {
                sendToMember(m.clientId, raw)
              }
            }
          }
        }
        return
      }

      // ── Regular message ──────────────────────────────────────────────────
      const msg = parsed as Message

      // Center forwards to all other peers
      if (roomStore.isCenter) {
        for (const m of roomStore.members) {
          if (m.clientId !== roomStore.clientId && m.clientId !== fromId) {
            sendToMember(m.clientId, raw)
          }
        }
      }

      msgStore.add(msg)
      // Small attachments are fetched eagerly so images/audio/video appear
      // inline without the recipient having to click.
      if (msg.type === 'file' && msg.meta) {
        maybeAutoFetchFile(msg.meta as unknown as FileMeta)
      }
      // Sync voiceStore session state from inbound voice bubbles. Doing this
      // here (rather than in a watcher on msgStore) keeps ordering simple:
      // session bubble lands, then voice_join control lands.
      if (msg.type === 'voice' && msg.meta) {
        const vmeta = msg.meta as unknown as VoiceSessionMeta
        if (vmeta.voiceKind === 'session') {
          if (!voiceStore.activeSessionId) {
            voiceStore.activeSessionId = vmeta.sessionId
            voiceStore.activeSessionInitiator = vmeta.initiatorId
            voiceStore.activeSessionStartedAt = vmeta.startedAt
          }
        } else if (vmeta.voiceKind === 'summary') {
          markSessionEnded(vmeta.sessionId, vmeta.endedAt ?? msg.timestamp)
          if (voiceStore.activeSessionId === vmeta.sessionId) {
            voiceStore.activeSessionId = null
            voiceStore.activeSessionInitiator = null
            voiceStore.activeSessionStartedAt = null
          }
        }
      }
      roomStore.reconnecting = false
    } catch {
      /* malformed */
    }
  }

  // ──────────────────────────────────────────────
  // File transfer
  // ──────────────────────────────────────────────

  // Send a directed control message to `to` clientId.
  // - If I'm the center, deliver directly.
  // - Else, route through the center, which will forward.
  function sendDirected(to: string, payload: object): boolean {
    const raw = JSON.stringify(payload)
    if (roomStore.isCenter || to === roomStore.centerId) {
      return sendToMember(to, raw)
    }
    return sendToMember(roomStore.centerId, raw)
  }

  // Broadcast a non-message control payload over the chat data plane.
  // - Center: fans out to every other member.
  // - Non-center: sends to center, which will re-broadcast on receipt
  //   (see the VOICE_CONTROL_TYPES block in handleData).
  function broadcastControl(payload: object) {
    const raw = JSON.stringify(payload)
    if (roomStore.isCenter) {
      for (const m of roomStore.members) {
        if (m.clientId !== roomStore.clientId) sendToMember(m.clientId, raw)
      }
    } else {
      sendToMember(roomStore.centerId, raw)
    }
  }

  // ──────────────────────────────────────────────
  // Voice-session bookkeeping helpers used by the useVoice hooks
  // ──────────────────────────────────────────────

  // Append a participant to the session bubble (idempotent on clientId).
  function appendParticipantToSessionBubble(sessionId: string, clientId: string, joinedAt: number) {
    const nickname =
      clientId === roomStore.clientId
        ? roomStore.nickname
        : (roomStore.members.find(m => m.clientId === clientId)?.nickname ?? clientId.slice(0, 4))
    msgStore.update(sessionId, m => {
      const meta = m.meta as unknown as VoiceSessionMeta | undefined
      if (!meta || meta.voiceKind !== 'session') return
      if (meta.participants.some(p => p.clientId === clientId)) return
      meta.participants.push({ clientId, nickname, joinedAt })
    })
  }

  // Mark a session bubble as ended; UI uses this to drop the "Join" affordance
  // while keeping the participant list visible.
  function markSessionEnded(sessionId: string, endedAt: number) {
    msgStore.update(sessionId, m => {
      const meta = m.meta as unknown as VoiceSessionMeta | undefined
      if (!meta || meta.voiceKind !== 'session') return
      if (meta.endedAt) return
      meta.endedAt = endedAt
    })
  }

  // Wraps a voice session: tells everyone the call is over, and — if I'm the
  // initiator and still in the room — drops a system-perspective summary bubble.
  function finalizeSession(sessionId: string, endedAt: number) {
    if (voiceStore.activeSessionId !== sessionId) return
    markSessionEnded(sessionId, endedAt)

    const sessionMsg = msgStore.messages.find(m => m.id === sessionId)
    const meta = sessionMsg?.meta as unknown as VoiceSessionMeta | undefined
    const isInitiator = meta?.initiatorId === roomStore.clientId

    voiceStore.activeSessionId = null
    voiceStore.activeSessionInitiator = null
    voiceStore.activeSessionStartedAt = null

    if (!isInitiator || !meta) return
    // Initiator's client publishes the summary as a system-perspective bubble.
    const summaryMeta: VoiceSessionMeta = {
      voiceKind: 'summary',
      sessionId,
      initiatorId: meta.initiatorId,
      initiatorNickname: meta.initiatorNickname,
      startedAt: meta.startedAt,
      participants: [...meta.participants],
      endedAt,
      durationMs: Math.max(0, endedAt - meta.startedAt),
    }
    dispatch({
      id: nanoid(),
      type: 'voice',
      from: 'system',
      fromId: 'system',
      content: '',
      timestamp: endedAt,
      roomKey: roomStore.key,
      isSystem: true,
      meta: summaryMeta as unknown as Record<string, unknown>,
    })
  }

  // ──────────────────────────────────────────────
  // Voice composable (now that signaling + transport helpers exist)
  // ──────────────────────────────────────────────
  voice = useVoice(
    () => rtc.getIceServers(),
    (to, payload) => signaling.send({ type: 'signal', roomKey: roomStore.key, to, payload }),
    broadcastControl,
    sendDirected,
    onEvent,
    {
      onParticipantJoin: appendParticipantToSessionBubble,
      onSessionDrained: finalizeSession,
    },
  )

  // ──────────────────────────────────────────────
  // Public: voice-session entry points used by the UI
  // ──────────────────────────────────────────────

  // Start a brand-new call: dispatch the session bubble, then join voice. The
  // session id IS the message id, so peers can locate the bubble from any voice
  // control payload.
  async function startVoiceSession() {
    if (voiceStore.activeSessionId) return // a call is already running
    // Pre-flight the mic so a denied permission doesn't leave a stillborn
    // session bubble in everyone's history.
    const micOk = await voice.prepareMic()
    if (!micOk) return

    const sessionId = nanoid()
    const startedAt = Date.now()
    const sessionMeta: VoiceSessionMeta = {
      voiceKind: 'session',
      sessionId,
      initiatorId: roomStore.clientId,
      initiatorNickname: roomStore.nickname,
      startedAt,
      participants: [],
    }
    voiceStore.activeSessionId = sessionId
    voiceStore.activeSessionInitiator = roomStore.clientId
    voiceStore.activeSessionStartedAt = startedAt
    dispatch({
      id: sessionId,
      type: 'voice',
      from: 'system',
      fromId: 'system',
      content: '',
      timestamp: startedAt,
      roomKey: roomStore.key,
      isSystem: true,
      meta: sessionMeta as unknown as Record<string, unknown>,
    })
    await voice.joinVoice(sessionId)
  }

  async function joinVoiceSession(sessionId: string) {
    if (voiceStore.inVoice) return
    if (voiceStore.activeSessionId !== sessionId) return // session already over
    await voice.joinVoice(sessionId)
  }

  function handleFileControl(parsed: any) {
    switch (parsed.type) {
      case 'file_request': {
        // Someone wants to download a file I'm hosting.
        const file = filesStore.getOutgoing(parsed.fileId)
        if (!file) {
          sendDirected(parsed.from, {
            type: 'file_error',
            from: roomStore.clientId,
            to: parsed.from,
            fileId: parsed.fileId,
            reason: 'gone',
          })
          return
        }
        void streamFileTo(parsed.from, parsed.fileId, file)
        break
      }

      case 'file_chunk': {
        const inc = filesStore.incoming.get(parsed.fileId)
        if (!inc) return // request was cancelled or never started
        const buf = base64ToArrayBuffer(parsed.data)
        filesStore.appendIncoming(parsed.fileId, buf)
        // Last chunk: assemble, then either save to disk or expose as a blob
        // URL for inline display — depending on how the fetch was started.
        if (parsed.seq === parsed.total - 1) {
          const result = filesStore.completeIncoming(parsed.fileId)
          if (result) {
            if (filesStore.getFetchMode(parsed.fileId) === 'display') {
              filesStore.setObjectUrl(parsed.fileId, URL.createObjectURL(result.blob))
            } else {
              saveBlobAs(result.blob, result.name)
            }
          }
        }
        break
      }

      case 'file_error': {
        filesStore.failIncoming(parsed.fileId)
        break
      }
    }
  }

  async function streamFileTo(requesterId: string, fileId: string, file: File) {
    try {
      const buf = await file.arrayBuffer()
      const total = Math.max(1, Math.ceil(buf.byteLength / FILE_CHUNK_SIZE))
      for (let i = 0; i < total; i++) {
        const slice = buf.slice(i * FILE_CHUNK_SIZE, (i + 1) * FILE_CHUNK_SIZE)
        sendDirected(requesterId, {
          type: 'file_chunk',
          from: roomStore.clientId,
          to: requesterId,
          fileId,
          seq: i,
          total,
          data: arrayBufferToBase64(slice),
        })
        // Yield occasionally so chunks are flushed to the wire and the UI thread breathes.
        if (i % 8 === 7) await new Promise(r => setTimeout(r, 0))
      }
    } catch {
      sendDirected(requesterId, {
        type: 'file_error',
        from: roomStore.clientId,
        to: requesterId,
        fileId,
        reason: 'read_failed',
      })
    }
  }

  // Trigger a browser download for an already-existing URL. Does NOT revoke it
  // — callers that own a transient blob URL should revoke it themselves.
  function triggerDownload(url: string, name: string) {
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  function saveBlobAs(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob)
    triggerDownload(url, name)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // ─── Public file API ─────────────────────────────────────
  function attachFile(file: File): { ok: true } | { ok: false; reason: 'too_large' } {
    if (file.size > MAX_FILE_SIZE) return { ok: false, reason: 'too_large' }
    const fileId = nanoid()
    filesStore.setOutgoing(fileId, file)
    const meta: FileMeta = {
      fileId,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      ownerId: roomStore.clientId,
    }
    // The sender sees their own image/audio/video inline straight away.
    if (isDisplayableMime(meta.mime)) {
      filesStore.setObjectUrl(fileId, URL.createObjectURL(file))
    }
    dispatch({
      id: nanoid(),
      type: 'file',
      from: roomStore.nickname,
      fromId: roomStore.clientId,
      content: file.name,
      timestamp: Date.now(),
      roomKey: roomStore.key,
      meta: meta as unknown as Record<string, unknown>,
    })
    return { ok: true }
  }

  function requestFileDownload(meta: FileMeta) {
    // I'm the owner — just save from local memory.
    if (meta.ownerId === roomStore.clientId) {
      const file = filesStore.getOutgoing(meta.fileId)
      if (!file) {
        filesStore.setStatus(meta.fileId, 'error')
        return
      }
      saveBlobAs(file, meta.name)
      filesStore.setStatus(meta.fileId, 'done')
      return
    }
    // Already fetched into a blob (e.g. auto-fetched while small) — save
    // straight from it, no need to re-request from the owner.
    const existingUrl = filesStore.objectUrls.get(meta.fileId)
    if (existingUrl) {
      triggerDownload(existingUrl, meta.name)
      return
    }
    // Owner gone? Don't bother sending the request.
    const ownerStill = roomStore.members.find(m => m.clientId === meta.ownerId)
    if (!ownerStill) {
      filesStore.setStatus(meta.fileId, 'error')
      return
    }
    // Already in flight or done — ignore duplicate clicks.
    const cur = filesStore.status.get(meta.fileId)
    if (cur === 'downloading') return
    filesStore.setFetchMode(meta.fileId, 'save')
    filesStore.startIncoming(meta.fileId, meta.size, meta.name, meta.mime, meta.ownerId)
    sendDirected(meta.ownerId, {
      type: 'file_request',
      from: roomStore.clientId,
      to: meta.ownerId,
      fileId: meta.fileId,
    })
  }

  // Fetch a file for inline display / playback (image / audio / video) or just
  // into memory for a generic file. On completion the blob is exposed as an
  // object URL via filesStore.objectUrls instead of triggering a download.
  function requestFileView(meta: FileMeta) {
    if (filesStore.objectUrls.has(meta.fileId)) return
    // I'm the owner — expose my own local copy directly.
    if (meta.ownerId === roomStore.clientId) {
      const file = filesStore.getOutgoing(meta.fileId)
      if (!file) {
        filesStore.setStatus(meta.fileId, 'error')
        return
      }
      filesStore.setObjectUrl(meta.fileId, URL.createObjectURL(file))
      return
    }
    const ownerStill = roomStore.members.find(m => m.clientId === meta.ownerId)
    if (!ownerStill) {
      filesStore.setStatus(meta.fileId, 'error')
      return
    }
    const cur = filesStore.status.get(meta.fileId)
    if (cur === 'downloading') return
    filesStore.setFetchMode(meta.fileId, 'display')
    filesStore.startIncoming(meta.fileId, meta.size, meta.name, meta.mime, meta.ownerId)
    sendDirected(meta.ownerId, {
      type: 'file_request',
      from: roomStore.clientId,
      to: meta.ownerId,
      fileId: meta.fileId,
    })
  }

  // Auto-fetch attachments below AUTO_FETCH_SIZE so small images/audio/video
  // render inline without a click. Larger files wait for an explicit action.
  function maybeAutoFetchFile(meta: FileMeta) {
    if (meta.ownerId === roomStore.clientId) return
    if (meta.size >= AUTO_FETCH_SIZE) return
    if (filesStore.objectUrls.has(meta.fileId)) return
    if (filesStore.status.get(meta.fileId)) return
    requestFileView(meta)
  }

  // ──────────────────────────────────────────────
  // Public: join room
  // ──────────────────────────────────────────────
  async function join(key: string, nickname: string) {
    roomStore.nickname = nickname
    roomStore.key = key
    connStore.reset()
    relayEnabled = null
    relayQueue.length = 0
    turnStore.reset()

    try {
      // Warm the STUN cache from /api/ice in the background. RTCPeerConnection
      // creation falls back to a built-in list if this hasn't resolved yet.
      void loadBaseIceServers()

      // Fetch Metered config — server returns the full ICE list (it does the
      // upstream call with the API key, so the key never reaches the browser)
      // and an `expiresAt` we use to schedule pre-emptive rotation.
      const meteredRes = await fetch('/api/turn-metered').catch(() => null)
      if (meteredRes?.ok) {
        const m = (await meteredRes.json()) as {
          enabled?: boolean
          iceServers?: RTCIceServer[]
          expiresAt?: number
        }
        if (m.enabled && Array.isArray(m.iceServers) && m.iceServers.length) {
          console.log('[turn] Metered iceServers:', m.iceServers.length, 'expiresAt:', m.expiresAt)
          turnStore.setMeteredConfig(true, m.iceServers, m.expiresAt ?? 0)
        }
      }

      // Fetch self-hosted TURN credentials
      const turnRes = await fetch('/api/turn-credentials').catch(() => null)
      if (turnRes?.ok) {
        const creds = await turnRes.json()
        if (creds.urls?.length) {
          console.log('[turn] Server TURN:', creds.urls)
          turnStore.setServerConfig(creds)
        }
      }

      // Auto-select Metered if: enabled + no custom + no server TURN
      if (turnStore.meteredEnabled && !turnStore.useCustom && !turnStore.serverConfig) {
        console.log('[turn] Auto-selecting Metered')
        turnStore.useMetered = true
      }

      // Apply TURN config: Metered > custom > server
      if (turnStore.useMetered && turnStore.meteredIceServers.length) {
        console.log('[turn] Using Metered.ca:', turnStore.meteredIceServers.length, 'servers')
        rtc.setTurnServers(turnStore.meteredIceServers)
        scheduleMeteredRotation()
      } else {
        const turn = turnStore.effective
        if (turn) {
          console.log('[turn] Using config:', turn.urls)
          rtc.setTurnServers([turn as RTCIceServer])
        }
      }

      await signaling.connect()
      // `lastClientId` lets the server recognise a returning member by ID
      // (immune to nickname collisions). On first join it's empty and the
      // server falls back to nickname matching.
      const lastClientId = roomStore.clientId || undefined
      signaling.send({ type: 'join', roomKey: key, nickname, lastClientId, protocolVersion: PROTOCOL_VERSION })
    } catch {
      onEvent({ event: 'connection_failed' })
    }
  }

  // ──────────────────────────────────────────────
  // Metered.ca temporary-credential rotation
  // ──────────────────────────────────────────────
  // The server returns short-lived TURN credentials with an `expiresAt`
  // timestamp. We refresh ~10 min ahead of expiry so an active TURN allocation
  // can hand off to a new one before the old creds stop being accepted on
  // Refresh — keeping any in-progress relay session uninterrupted.
  let rotationTimer: ReturnType<typeof setTimeout> | null = null
  const ROTATION_LEAD_S = 600 // 10 min
  const ROTATION_FALLBACK_S = 60 // retry on transient errors

  function clearMeteredRotation() {
    if (rotationTimer) {
      clearTimeout(rotationTimer)
      rotationTimer = null
    }
  }

  function scheduleMeteredRotation() {
    clearMeteredRotation()
    const now = Math.floor(Date.now() / 1000)
    const expires = turnStore.meteredExpiresAt
    if (!expires || expires <= now) return
    // Floor at 5s so a near-expiry server response still rotates promptly.
    const refreshInS = Math.max(5, expires - now - ROTATION_LEAD_S)
    rotationTimer = setTimeout(rotateMeteredCreds, refreshInS * 1000)
  }

  async function rotateMeteredCreds() {
    rotationTimer = null
    try {
      const r = await fetch('/api/turn-metered').catch(() => null)
      if (!r?.ok) {
        rotationTimer = setTimeout(rotateMeteredCreds, ROTATION_FALLBACK_S * 1000)
        return
      }
      const m = (await r.json()) as {
        enabled?: boolean
        iceServers?: RTCIceServer[]
        expiresAt?: number
      }
      if (!m.enabled || !Array.isArray(m.iceServers) || m.iceServers.length === 0) {
        rotationTimer = setTimeout(rotateMeteredCreds, ROTATION_FALLBACK_S * 1000)
        return
      }
      console.log('[turn] Rotated Metered creds; next expiresAt:', m.expiresAt)
      turnStore.setMeteredConfig(true, m.iceServers, m.expiresAt ?? 0)
      await rtc.updateTurnServers(m.iceServers)
      scheduleMeteredRotation()
    } catch (e) {
      console.warn('[turn] rotation failed:', e)
      rotationTimer = setTimeout(rotateMeteredCreds, ROTATION_FALLBACK_S * 1000)
    }
  }

  // ──────────────────────────────────────────────
  // Internal: build and dispatch a chat/forward message
  // ──────────────────────────────────────────────
  function dispatch(msg: Message) {
    const raw = JSON.stringify(msg)
    msgStore.add(msg)

    if (roomStore.isCenter) {
      const peers = roomStore.members.filter(m => m.clientId !== roomStore.clientId)
      // No peers yet? Not a failure (will be delivered via catch-up when they join)
      let anyDelivered = peers.length === 0
      for (const m of peers) {
        if (sendToMember(m.clientId, raw)) anyDelivered = true
      }
      if (!anyDelivered) msgStore.markFailed(msg.id)
    } else {
      if (!sendToMember(roomStore.centerId, raw)) {
        msgStore.markFailed(msg.id)
      }
    }
  }

  // ──────────────────────────────────────────────
  // Public: send chat message
  // ──────────────────────────────────────────────
  function sendMessage(content: string) {
    dispatch({
      id: nanoid(),
      type: 'chat',
      from: roomStore.nickname,
      fromId: roomStore.clientId,
      content,
      timestamp: Date.now(),
      roomKey: roomStore.key,
    })
  }

  // ──────────────────────────────────────────────
  // Public: send forward/history card
  // ──────────────────────────────────────────────
  function sendForward(msgs: Message[], note: string) {
    dispatch({
      id: nanoid(),
      type: 'forward',
      from: roomStore.nickname,
      fromId: roomStore.clientId,
      content: '',
      timestamp: Date.now(),
      roomKey: roomStore.key,
      forwardOf: { messages: msgs, note },
    })
  }

  // ──────────────────────────────────────────────
  // Public: resend a failed message
  // ──────────────────────────────────────────────
  function resendMessage(msgId: string) {
    if (roomStore.reconnecting) return
    const msg = msgStore.messages.find(m => m.id === msgId)
    if (!msg) return

    msgStore.clearFailed(msgId)
    const raw = JSON.stringify(msg)

    if (roomStore.isCenter) {
      let anyDelivered = false
      for (const m of roomStore.members) {
        if (m.clientId !== roomStore.clientId) {
          if (sendToMember(m.clientId, raw)) anyDelivered = true
        }
      }
      if (!anyDelivered) msgStore.markFailed(msgId)
    } else {
      if (!sendToMember(roomStore.centerId, raw)) {
        msgStore.markFailed(msgId)
      }
    }
  }

  // ──────────────────────────────────────────────
  // Public: leave room
  // ──────────────────────────────────────────────
  function leave() {
    clearMeteredRotation()
    voice.dispose()
    rtc.closeAll()
    signaling.send({ type: 'leave', roomKey: roomStore.key })
    signaling.close()
    msgStore.clear(roomStore.key)
    filesStore.clearAll()
    roomStore.reset()
    connStore.reset()
  }

  // ──────────────────────────────────────────────
  // Helper: inject system message
  // ──────────────────────────────────────────────
  function addSystemMessage(i18nKey: string, params: Record<string, string> = {}) {
    msgStore.add({
      id: nanoid(),
      type: 'system',
      from: 'system',
      fromId: 'system',
      content: JSON.stringify({ key: i18nKey, params }),
      timestamp: Date.now(),
      roomKey: roomStore.key,
      isSystem: true,
    })
  }

  // Chair-only: set the per-room AI hard turn cap. 0 → unlimited.
  function setAiTurnLimit(limit: number) {
    const next = Math.max(0, Math.floor(Number(limit) || 0))
    signaling.send({ type: 'set_room_config', roomKey: roomStore.key, aiTurnLimit: next })
  }

  return {
    join,
    leave,
    sendMessage,
    sendForward,
    resendMessage,
    attachFile,
    requestFileDownload,
    requestFileView,
    startVoiceSession,
    joinVoiceSession,
    leaveVoice: () => voice.leaveVoice(),
    toggleMute: () => voice.toggleMute(),
    confirmRelay,
    signaling,
    roomStore,
    setAiTurnLimit,
  }
}

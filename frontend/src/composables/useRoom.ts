import { useSignaling } from './useSignaling'
import { useWebRTC } from './useWebRTC'
import { useRoomStore } from '@/stores/room'
import { useMessagesStore } from '@/stores/messages'
import { useConnectionStore } from '@/stores/connection'
import { useTurnStore } from '@/stores/turn'
import { useFilesStore } from '@/stores/files'
import type { Message, S2C, RTCSignal, FileMeta } from '@/types'
import { nanoid } from 'nanoid'
import { calcDeviceScore } from '@/utils/score'

// Max age of messages included in catch-up bundles (10 minutes)
const CATCHUP_MAX_AGE_MS = 10 * 60 * 1000
// Max number of messages in a catch-up bundle
const CATCHUP_MAX_COUNT  = 100

// File transfer
export const MAX_FILE_SIZE = 5 * 1024 * 1024  // 5 MB
const FILE_CHUNK_SIZE = 32 * 1024              // 32 KB binary → ~43 KB base64

// Directed control messages routed through the center peer.
const DIRECTED_FILE_TYPES = new Set(['file_request', 'file_chunk', 'file_end', 'file_error'])

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
  | { event: 'relay_request' }   // WS relay needed — user must confirm
  | { event: 'relay_active' }    // First incoming relay message (informational)

export function useRoom(onEvent: (e: RoomEvent) => void) {
  const roomStore = useRoomStore()
  const msgStore  = useMessagesStore()
  const connStore = useConnectionStore()
  const turnStore = useTurnStore()
  const filesStore = useFilesStore()

  // ──────────────────────────────────────────────
  // WS relay state
  // ──────────────────────────────────────────────
  let relayEnabled: boolean | null = null
  const relayQueue: Array<[string, string]> = []

  function confirmRelay(allow: boolean) {
    relayEnabled = allow
    if (allow) {
      for (const [id, raw] of relayQueue) {
        signaling.send({ type: 'relay', to: id, data: raw })
      }
      connStore.state = 'relay'
    } else {
      // User declined relay — mark all queued messages as failed
      for (const [, raw] of relayQueue) {
        try {
          const parsed = JSON.parse(raw)
          if (parsed.id) msgStore.markFailed(parsed.id)
        } catch { /* ignore */ }
      }
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
    async (peerId) => {
      // 1. If we are the center, send catch-up history to returning members only
      if (roomStore.isCenter) {
        const peer = roomStore.members.find(m => m.clientId === peerId)
        if (peer?.isReturning) {
          const cutoff  = Date.now() - CATCHUP_MAX_AGE_MS
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
        signaling.send({ type: 'member_conn' as never, clientId: peerId, connType: type } as never)
      }
    },
    // onChannelClose: DataChannel closed, trigger relay fallback if needed
    (peerId) => {
      // If center's channel closed and we have pending/failed messages, trigger relay request
      if (peerId === roomStore.centerId && relayEnabled === null) {
        const hasPending = msgStore.failedIds.size > 0
        if (hasPending) onEvent({ event: 'relay_request' })
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
        const assignedNick  = msg.nickname ?? requestedNick
        roomStore.setRoom({
          key:         roomStore.key,
          clientId:    msg.clientId,
          nickname:    assignedNick,
          centerId:    msg.centerId,
          chairId:     msg.chairId,
          nicknameSet: msg.nicknameSet,
          members:     msg.members,
        })
        msgStore.load(roomStore.key)
        if (assignedNick !== requestedNick) {
          addSystemMessage('system.nickname_renamed', { from: requestedNick, to: assignedNick })
        }

        if (msg.clientId !== msg.centerId) {
          rtc.createPeer(msg.centerId, true /* polite */)
        }
        rtc.startHeartbeat((timedOutId) => {
          if (timedOutId === roomStore.centerId) {
            signaling.send({ type: 'score', roomKey: roomStore.key, score: calcDeviceScore(roomStore.members.length, connStore.state) })
            roomStore.removeMember(timedOutId)
          }
          // Non-center P2P timeout: relay fallback keeps messages flowing.
        })
        break
      }

      case 'member_join': {
        roomStore.addMember(msg.member)
        if (roomStore.isCenter && !msg.member.isBot) {
          rtc.createPeer(msg.member.clientId, false /* impolite, creates channel */)
        }
        break
      }

      case 'member_left': {
        const wasCenter = msg.clientId === roomStore.centerId
        // Set reconnecting immediately so UI disables send/resend
        if (wasCenter) roomStore.reconnecting = true
        roomStore.removeMember(msg.clientId)
        rtc.closePeer(msg.clientId)
        addSystemMessage('system.leave', { name: msg.nickname })
        if (wasCenter) {
          signaling.send({ type: 'score', roomKey: roomStore.key, score: calcDeviceScore(roomStore.members.length, connStore.state) })
        }
        break
      }

      case 'new_center': {
        roomStore.updateCenter(msg.centerId)
        roomStore.reconnecting = true
        connStore.state = 'connecting'
        if (msg.centerId !== roomStore.clientId) {
          rtc.closeAll()
          rtc.createPeer(msg.centerId, true)
        }
        break
      }

      case 'new_chair': {
        roomStore.updateChair(msg.chairId)
        addSystemMessage('system.new_chair', { name: msg.nickname })
        break
      }

      case 'member_conn': {
        const hadConnType = roomStore.members.find(m => m.clientId === msg.clientId)?.connType
        roomStore.updateMemberConn(msg.clientId, msg.connType)
        if (!hadConnType) {
          const member = roomStore.members.find(m => m.clientId === msg.clientId)
          if (member) {
            const connTypeText = msg.connType === 'p2p' ? 'P2P' : msg.connType === 'turn' ? 'TURN' : 'Relay'
            addSystemMessage('system.join', { name: member.nickname, connType: connTypeText })
          }
        }
        break
      }

      case 'signal': {
        rtc.handleSignal(msg.from, msg.payload as RTCSignal, roomStore.isCenter)
        break
      }

      case 'relay': {
        if (relayEnabled === null) {
          relayEnabled = true
          connStore.state = 'relay'
          onEvent({ event: 'relay_active' })
        }
        handleData(msg.from, msg.data)
        break
      }

      case 'kicked':      onEvent({ event: 'kicked' });       break
      case 'room_ended':  onEvent({ event: 'room_ended' });   break
      case 'room_banned': onEvent({ event: 'room_banned' });  break
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
      roomStore.reconnecting = false
    } catch { /* malformed */ }
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

  function handleFileControl(parsed: any) {
    switch (parsed.type) {

      case 'file_request': {
        // Someone wants to download a file I'm hosting.
        const file = filesStore.getOutgoing(parsed.fileId)
        if (!file) {
          sendDirected(parsed.from, {
            type: 'file_error', from: roomStore.clientId, to: parsed.from,
            fileId: parsed.fileId, reason: 'gone',
          })
          return
        }
        void streamFileTo(parsed.from, parsed.fileId, file)
        break
      }

      case 'file_chunk': {
        const inc = filesStore.incoming.get(parsed.fileId)
        if (!inc) return  // request was cancelled or never started
        const buf = base64ToArrayBuffer(parsed.data)
        filesStore.appendIncoming(parsed.fileId, buf)
        // Last chunk: assemble + trigger save.
        if (parsed.seq === parsed.total - 1) {
          const result = filesStore.completeIncoming(parsed.fileId)
          if (result) saveBlobAs(result.blob, result.name)
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
      const buf   = await file.arrayBuffer()
      const total = Math.max(1, Math.ceil(buf.byteLength / FILE_CHUNK_SIZE))
      for (let i = 0; i < total; i++) {
        const slice = buf.slice(i * FILE_CHUNK_SIZE, (i + 1) * FILE_CHUNK_SIZE)
        sendDirected(requesterId, {
          type: 'file_chunk',
          from: roomStore.clientId,
          to:   requesterId,
          fileId,
          seq:  i,
          total,
          data: arrayBufferToBase64(slice),
        })
        // Yield occasionally so chunks are flushed to the wire and the UI thread breathes.
        if (i % 8 === 7) await new Promise(r => setTimeout(r, 0))
      }
    } catch {
      sendDirected(requesterId, {
        type: 'file_error', from: roomStore.clientId, to: requesterId,
        fileId, reason: 'read_failed',
      })
    }
  }

  function saveBlobAs(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // ─── Public file API ─────────────────────────────────────
  function attachFile(file: File): { ok: true } | { ok: false, reason: 'too_large' } {
    if (file.size > MAX_FILE_SIZE) return { ok: false, reason: 'too_large' }
    const fileId = nanoid()
    filesStore.setOutgoing(fileId, file)
    const meta: FileMeta = {
      fileId,
      name:    file.name,
      size:    file.size,
      mime:    file.type || 'application/octet-stream',
      ownerId: roomStore.clientId,
    }
    dispatch({
      id:        nanoid(),
      type:      'file',
      from:      roomStore.nickname,
      fromId:    roomStore.clientId,
      content:   file.name,
      timestamp: Date.now(),
      roomKey:   roomStore.key,
      meta:      meta as unknown as Record<string, unknown>,
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
    // Owner gone? Don't bother sending the request.
    const ownerStill = roomStore.members.find(m => m.clientId === meta.ownerId)
    if (!ownerStill) {
      filesStore.setStatus(meta.fileId, 'error')
      return
    }
    // Already in flight or done — ignore duplicate clicks.
    const cur = filesStore.status.get(meta.fileId)
    if (cur === 'downloading') return
    filesStore.startIncoming(meta.fileId, meta.size, meta.name, meta.mime, meta.ownerId)
    sendDirected(meta.ownerId, {
      type:   'file_request',
      from:   roomStore.clientId,
      to:     meta.ownerId,
      fileId: meta.fileId,
    })
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
      // Fetch Metered config
      const meteredRes = await fetch('/api/turn-metered').catch(() => null)
      if (meteredRes?.ok) {
        const metered = await meteredRes.json()
        if (metered.enabled) {
          console.log('[turn] Metered available:', metered.apiUrl)
          turnStore.setMeteredConfig(true, metered.apiUrl)
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
      if (turnStore.useMetered && turnStore.meteredApiUrl) {
        const meteredIce = await fetch(turnStore.meteredApiUrl).then(r => r.json()).catch(() => null)
        if (meteredIce) {
          console.log('[turn] Using Metered.ca:', meteredIce.length, 'servers')
          rtc.setTurnServers(meteredIce)
        }
      } else {
        const turn = turnStore.effective
        if (turn) {
          console.log('[turn] Using config:', turn.urls)
          rtc.setTurnServers([turn as RTCIceServer])
        }
      }

      await signaling.connect()
      signaling.send({ type: 'join', roomKey: key, nickname })
    } catch {
      onEvent({ event: 'connection_failed' })
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
      id:        nanoid(),
      type:      'chat',
      from:      roomStore.nickname,
      fromId:    roomStore.clientId,
      content,
      timestamp: Date.now(),
      roomKey:   roomStore.key,
    })
  }

  // ──────────────────────────────────────────────
  // Public: send forward/history card
  // ──────────────────────────────────────────────
  function sendForward(msgs: Message[], note: string) {
    dispatch({
      id:        nanoid(),
      type:      'forward',
      from:      roomStore.nickname,
      fromId:    roomStore.clientId,
      content:   '',
      timestamp: Date.now(),
      roomKey:   roomStore.key,
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
      id:        nanoid(),
      type:      'system',
      from:      'system',
      fromId:    'system',
      content:   JSON.stringify({ key: i18nKey, params }),
      timestamp: Date.now(),
      roomKey:   roomStore.key,
      isSystem:  true,
    })
  }

  return {
    join, leave, sendMessage, sendForward, resendMessage,
    attachFile, requestFileDownload,
    confirmRelay, signaling, roomStore,
  }
}

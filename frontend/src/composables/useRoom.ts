import { useSignaling } from './useSignaling'
import { useWebRTC } from './useWebRTC'
import { useRoomStore } from '@/stores/room'
import { useMessagesStore } from '@/stores/messages'
import { useConnectionStore } from '@/stores/connection'
import { useTurnStore } from '@/stores/turn'
import type { Message, S2C, RTCSignal } from '@/types'
import { nanoid } from 'nanoid'
import { calcDeviceScore } from '@/utils/score'

// Max age of messages included in catch-up bundles (10 minutes)
const CATCHUP_MAX_AGE_MS = 10 * 60 * 1000
// Max number of messages in a catch-up bundle
const CATCHUP_MAX_COUNT  = 100

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
        connStore.state = type
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
        roomStore.setRoom({
          key:         roomStore.key,
          clientId:    msg.clientId,
          nickname:    roomStore.nickname,
          centerId:    msg.centerId,
          chairId:     msg.chairId,
          nicknameSet: msg.nicknameSet,
          members:     msg.members,
        })
        msgStore.load(roomStore.key)

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
        addSystemMessage('system.join', { name: msg.member.nickname })
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
    if (relayEnabled === null) {
      relayQueue.push([memberId, raw])
      onEvent({ event: 'relay_request' })
      return true  // optimistic: queued pending user confirmation
    }
    return false   // relay declined, no delivery path
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
      const turnRes = await fetch('/api/turn-credentials').catch(() => null)
      if (turnRes?.ok) {
        const creds = await turnRes.json()
        if (creds.urls?.length) turnStore.setServerConfig(creds)
      }

      const turn = turnStore.effective
      if (turn) rtc.setTurnServers([turn as RTCIceServer])

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

  return { join, leave, sendMessage, sendForward, resendMessage, confirmRelay, signaling, roomStore }
}

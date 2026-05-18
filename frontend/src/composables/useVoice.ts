import { useVoiceStore } from '@/stores/voice'
import { useRoomStore } from '@/stores/room'
import type { RTCSignal } from '@/types'

// Hard cap on concurrent voice participants (mesh: each peer holds N-1 audio PCs).
// Audio is ~32-64 kbps Opus so 4 outbound streams is trivial bandwidth-wise.
export const MAX_VOICE_PARTICIPANTS = 5

export type VoiceEvent = { event: 'mic_denied' } | { event: 'voice_full' }

export interface VoiceHooks {
  // Someone (including self) joined the call. Caller updates the bubble.
  onParticipantJoin: (sessionId: string, clientId: string, joinedAt: number) => void
  // The voice channel just emptied. Initiator's client should dispatch the summary.
  onSessionDrained: (sessionId: string, endedAt: number) => void
}

export function useVoice(
  getIceServers: () => RTCIceServer[],
  sendVoiceSignal: (to: string, payload: RTCSignal) => void,
  broadcastControl: (payload: object) => void,
  sendDirectedControl: (to: string, payload: object) => void,
  onEvent: (e: VoiceEvent) => void,
  hooks: VoiceHooks,
) {
  const voiceStore = useVoiceStore()
  const roomStore = useRoomStore()

  let localStream: MediaStream | null = null

  interface VoicePeer {
    pc: RTCPeerConnection
    makingOffer: boolean
  }
  const peers = new Map<string, VoicePeer>()

  // ──────────────────────────────────────────────
  // PC lifecycle
  // ──────────────────────────────────────────────
  function getOrCreateVoicePc(peerId: string): VoicePeer {
    let entry = peers.get(peerId)
    if (entry) return entry

    const pc = new RTCPeerConnection({ iceServers: getIceServers() })
    entry = { pc, makingOffer: false }
    peers.set(peerId, entry)

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendVoiceSignal(peerId, { candidate: candidate.toJSON(), channel: 'voice' })
    }

    pc.ontrack = ({ streams: [stream] }) => {
      if (stream) voiceStore.remoteStreams.set(peerId, stream)
    }

    pc.onnegotiationneeded = async () => {
      try {
        entry!.makingOffer = true
        await pc.setLocalDescription()
        if (pc.localDescription) {
          sendVoiceSignal(peerId, { sdp: pc.localDescription, channel: 'voice' })
        }
      } catch (e) {
        console.warn('[voice] negotiation error:', e)
      } finally {
        entry!.makingOffer = false
      }
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        closePeer(peerId)
      }
    }

    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream)
      }
    }

    return entry
  }

  function closePeer(peerId: string) {
    const entry = peers.get(peerId)
    if (entry) {
      try {
        entry.pc.close()
      } catch {
        /* already closed */
      }
      peers.delete(peerId)
    }
    voiceStore.remoteStreams.delete(peerId)
  }

  // ──────────────────────────────────────────────
  // Public actions
  // ──────────────────────────────────────────────
  // Acquire the mic up-front (before any visible side effects) so the caller
  // can decide whether to publish a session bubble. Returns true on success.
  async function prepareMic(): Promise<boolean> {
    if (localStream) return true
    if (voiceStore.voiceMembers.size >= MAX_VOICE_PARTICIPANTS) {
      onEvent({ event: 'voice_full' })
      return false
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      return true
    } catch {
      onEvent({ event: 'mic_denied' })
      return false
    }
  }

  // Mark self in voice and broadcast voice_join carrying the session id so
  // peers can attribute the join to the correct bubble. If prepareMic hasn't
  // been called yet, this will call it; failed permission leaves voice off.
  async function joinVoice(sessionId: string) {
    if (voiceStore.inVoice) return
    if (!localStream) {
      const ok = await prepareMic()
      if (!ok) return
    }
    const joinedAt = Date.now()
    voiceStore.inVoice = true
    voiceStore.muted = false
    voiceStore.voiceMembers.add(roomStore.clientId)
    hooks.onParticipantJoin(sessionId, roomStore.clientId, joinedAt)
    // Existing voice members will reply with voice_announce, prompting us to dial them.
    broadcastControl({ type: 'voice_join', from: roomStore.clientId, sessionId, joinedAt })
  }

  function leaveVoice() {
    if (!voiceStore.inVoice) return
    const sessionId = voiceStore.activeSessionId
    broadcastControl({ type: 'voice_leave', from: roomStore.clientId, sessionId })
    voiceStore.inVoice = false
    voiceStore.muted = false
    voiceStore.voiceMembers.delete(roomStore.clientId)
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop())
      localStream = null
    }
    for (const id of [...peers.keys()]) closePeer(id)
    // If I was the last participant, the call has ended. Let the caller decide
    // whether to dispatch a summary bubble (only the initiator should).
    if (sessionId && voiceStore.voiceMembers.size === 0) {
      hooks.onSessionDrained(sessionId, Date.now())
    }
  }

  function toggleMute() {
    if (!localStream) return
    voiceStore.muted = !voiceStore.muted
    for (const track of localStream.getAudioTracks()) {
      track.enabled = !voiceStore.muted
    }
  }

  // ──────────────────────────────────────────────
  // Inbound voice control plumbing
  // (called from useRoom.handleData when it parses a voice control message)
  // ──────────────────────────────────────────────
  function handleVoiceControl(parsed: any) {
    const { type, from, to, sessionId, joinedAt } = parsed
    if (from === roomStore.clientId) return

    switch (type) {
      case 'voice_join': {
        voiceStore.voiceMembers.add(from)
        if (sessionId) {
          hooks.onParticipantJoin(sessionId, from, joinedAt ?? Date.now())
        }
        // If I'm already in voice, tell the new joiner I'm here so they dial me.
        if (voiceStore.inVoice) {
          sendDirectedControl(from, {
            type: 'voice_announce',
            from: roomStore.clientId,
            to: from,
            sessionId: voiceStore.activeSessionId,
          })
        }
        break
      }
      case 'voice_announce': {
        // Directed message addressed to me from an existing voice member.
        if (to !== roomStore.clientId) return
        voiceStore.voiceMembers.add(from)
        // If I'm in voice, dial them. (If I'm not in voice, this is just an
        // FYI for room-join catch-up: track membership but don't open a PC.)
        if (voiceStore.inVoice) {
          getOrCreateVoicePc(from)
        }
        break
      }
      case 'voice_leave': {
        voiceStore.voiceMembers.delete(from)
        closePeer(from)
        // The remote leaver was the last participant; treat the session as
        // drained on every peer. The caller filters for the initiator+still-in-room
        // case to actually dispatch the summary.
        if (sessionId && voiceStore.voiceMembers.size === 0) {
          hooks.onSessionDrained(sessionId, Date.now())
        }
        break
      }
    }
  }

  async function handleVoiceSignal(fromId: string, payload: RTCSignal) {
    if (!voiceStore.inVoice) return
    const entry = getOrCreateVoicePc(fromId)
    const pc = entry.pc

    try {
      if (payload.sdp) {
        // Perfect-negotiation pattern: lexicographically-smaller clientId is polite.
        const polite = roomStore.clientId < fromId
        const offerCollision = payload.sdp.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable')
        const ignoreOffer = !polite && offerCollision
        if (ignoreOffer) return

        await pc.setRemoteDescription(payload.sdp)
        if (payload.sdp.type === 'offer') {
          await pc.setLocalDescription()
          if (pc.localDescription) {
            sendVoiceSignal(fromId, { sdp: pc.localDescription, channel: 'voice' })
          }
        }
      }
      if (payload.candidate) {
        try {
          await pc.addIceCandidate(payload.candidate)
        } catch {
          /* stale */
        }
      }
    } catch (e) {
      console.warn('[voice] signal error:', e)
    }
  }

  // ──────────────────────────────────────────────
  // Room-membership lifecycle hooks (driven by useRoom)
  // ──────────────────────────────────────────────

  // A peer dropped out of the room entirely — clean up any voice state for them.
  function onMemberLeftRoom(clientId: string) {
    if (voiceStore.voiceMembers.has(clientId)) {
      voiceStore.voiceMembers.delete(clientId)
      closePeer(clientId)
      // Member dropped without sending voice_leave; if they were the last
      // participant, the session is over on this client too.
      if (voiceStore.activeSessionId && voiceStore.voiceMembers.size === 0) {
        hooks.onSessionDrained(voiceStore.activeSessionId, Date.now())
      }
    }
  }

  // A new peer joined the room — if I'm in voice, let them know so their UI
  // can render the mic indicator (and so they can dial me if they later join voice).
  function onMemberJoinedRoom(clientId: string) {
    if (clientId !== roomStore.clientId && voiceStore.inVoice) {
      sendDirectedControl(clientId, {
        type: 'voice_announce',
        from: roomStore.clientId,
        to: clientId,
        sessionId: voiceStore.activeSessionId,
      })
    }
  }

  function dispose() {
    leaveVoice()
    voiceStore.reset()
  }

  return {
    prepareMic,
    joinVoice,
    leaveVoice,
    toggleMute,
    handleVoiceControl,
    handleVoiceSignal,
    onMemberLeftRoom,
    onMemberJoinedRoom,
    dispose,
  }
}

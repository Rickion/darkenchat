import type { RTCSignal } from '@/types'

type DataHandler    = (fromId: string, data: string) => void
type SignalSender   = (to: string, payload: RTCSignal) => void
type ChannelOpenCb  = (peerId: string) => void
type ChannelCloseCb = (peerId: string) => void

function getBaseIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ]
  // Dev-only: local TURN lets two same-machine browser tabs connect via relay
  if (import.meta.env.DEV) {
    servers.push({ urls: 'turn:127.0.0.1:3478', username: 'test', credential: 'test123' })
  }
  return servers
}

const HEARTBEAT_MS = 3000
const TIMEOUT_MS   = 10000

export function useWebRTC(
  sendSignal: SignalSender,
  onData: DataHandler,
  onChannelOpen?: ChannelOpenCb,
  onChannelClose?: ChannelCloseCb,
) {
  const peers       = new Map<string, RTCPeerConnection>()
  const channels    = new Map<string, RTCDataChannel>()
  const lastHb      = new Map<string, number>()
  const makingOffer = new Map<string, boolean>()

  // Dynamic TURN servers fetched from server at join time
  let turnServers: RTCIceServer[] = []

  function setTurnServers(servers: RTCIceServer[]) {
    turnServers = servers
  }

  function getIceServers(): RTCIceServer[] {
    return [...getBaseIceServers(), ...turnServers]
  }

  let hbTimer: ReturnType<typeof setInterval> | null = null

  // ──────────────────────────────────────────────
  // Create / get peer connection
  // ──────────────────────────────────────────────
  function createPeer(peerId: string, polite: boolean): RTCPeerConnection {
    if (peers.has(peerId)) return peers.get(peerId)!

    const pc = new RTCPeerConnection({ iceServers: getIceServers() })
    peers.set(peerId, pc)

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal(peerId, { candidate: candidate.toJSON() })
    }

    // Receive DataChannel from remote peer
    pc.ondatachannel = ({ channel }) => {
      setupChannel(peerId, channel)
    }

    // Send offer whenever negotiation is needed
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer.set(peerId, true)
        await pc.setLocalDescription()
        sendSignal(peerId, { sdp: pc.localDescription! })
      } catch(e) {
        console.warn('[rtc] onnegotiationneeded error:', e)
      } finally {
        makingOffer.set(peerId, false)
      }
    }

    // Both sides always create a DataChannel so either side can initiate.
    const ch = pc.createDataChannel('chat')
    setupChannel(peerId, ch)

    return pc
  }

  function setupChannel(peerId: string, ch: RTCDataChannel) {
    channels.set(peerId, ch)
    lastHb.set(peerId, Date.now())

    ch.onopen = () => {
      onChannelOpen?.(peerId)
    }

    ch.onmessage = ({ data }) => {
      if (data === '__hb__') { lastHb.set(peerId, Date.now()); ch.send('__ack__'); return }
      if (data === '__ack__') { lastHb.set(peerId, Date.now()); return }
      onData(peerId, data)
    }

    ch.onclose = () => {
      // Guard: only evict if this is still the active channel
      if (channels.get(peerId) === ch) {
        channels.delete(peerId)
        lastHb.delete(peerId)
        onChannelClose?.(peerId)
      }
    }
  }

  // ──────────────────────────────────────────────
  // Perfect-negotiation signal handler
  // ──────────────────────────────────────────────
  async function handleSignal(fromId: string, payload: RTCSignal, weAreCenter: boolean) {
    const polite = !weAreCenter
    const pc = createPeer(fromId, polite)

    if (payload.sdp) {
      const offerCollision =
        payload.sdp.type === 'offer' &&
        ((makingOffer.get(fromId) ?? false) || pc.signalingState !== 'stable')

      const ignoreOffer = !polite && offerCollision
      if (ignoreOffer) return

      await pc.setRemoteDescription(payload.sdp)

      if (payload.sdp.type === 'offer') {
        await pc.setLocalDescription()
        sendSignal(fromId, { sdp: pc.localDescription! })
      }
    }

    if (payload.candidate) {
      try { await pc.addIceCandidate(payload.candidate) }
      catch { /* stale candidate, ignore */ }
    }
  }

  // ──────────────────────────────────────────────
  // Detect ICE candidate type for a peer (p2p vs turn)
  // Call after DataChannel opens to determine connection quality.
  // Returns 'turn' if the nominated pair uses a relay candidate, else 'p2p'.
  // ──────────────────────────────────────────────
  async function detectConnectionType(peerId: string): Promise<'p2p' | 'turn'> {
    const pc = peers.get(peerId)
    if (!pc) return 'p2p'
    try {
      const stats = await pc.getStats()
      for (const [, report] of stats) {
        if (report.type === 'candidate-pair' && report.nominated) {
          const remote = stats.get(report.remoteCandidateId)
          const local  = stats.get(report.localCandidateId)
          if (remote?.candidateType === 'relay' || local?.candidateType === 'relay') {
            return 'turn'
          }
          return 'p2p'
        }
      }
    } catch { /* stats not available */ }
    return 'p2p'
  }

  // ──────────────────────────────────────────────
  // Messaging
  // ──────────────────────────────────────────────
  function sendTo(peerId: string, data: string) {
    const ch = channels.get(peerId)
    if (ch?.readyState === 'open') ch.send(data)
  }

  function broadcast(data: string, exceptId?: string) {
    for (const [id, ch] of channels) {
      if (id !== exceptId && ch.readyState === 'open') ch.send(data)
    }
  }

  // ──────────────────────────────────────────────
  // Heartbeat
  // ──────────────────────────────────────────────
  function startHeartbeat(onTimeout: (peerId: string) => void) {
    stopHeartbeat()
    hbTimer = setInterval(() => {
      const now = Date.now()
      for (const [peerId, ch] of channels) {
        if (ch.readyState === 'open') ch.send('__hb__')
        if (now - (lastHb.get(peerId) ?? now) > TIMEOUT_MS) {
          onTimeout(peerId)
          closePeer(peerId)
        }
      }
    }, HEARTBEAT_MS)
  }

  function stopHeartbeat() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null }
  }

  // ──────────────────────────────────────────────
  // Cleanup
  // ──────────────────────────────────────────────
  function closePeer(peerId: string) {
    channels.get(peerId)?.close()
    channels.delete(peerId)
    peers.get(peerId)?.close()
    peers.delete(peerId)
    lastHb.delete(peerId)
    makingOffer.delete(peerId)
  }

  function closeAll() {
    stopHeartbeat()
    for (const id of [...peers.keys()]) closePeer(id)
  }

  return {
    createPeer,
    handleSignal,
    sendTo,
    broadcast,
    startHeartbeat,
    stopHeartbeat,
    closePeer,
    closeAll,
    setTurnServers,
    detectConnectionType,
    hasOpenChannel: (id: string) => channels.get(id)?.readyState === 'open',
    channelCount: () => channels.size,
  }
}

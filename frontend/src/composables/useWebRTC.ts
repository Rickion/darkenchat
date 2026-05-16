import type { RTCSignal } from '@/types'

type DataHandler    = (fromId: string, data: string) => void
type SignalSender   = (to: string, payload: RTCSignal) => void
type ChannelOpenCb  = (peerId: string) => void
type ChannelCloseCb = (peerId: string) => void

// STUN list comes from the server (/api/ice) so it stays in lock-step with
// config.yaml — no hardcode to drift. The fetch happens once per page load
// and the result is cached; on failure we fall back to a built-in list so a
// dev server outage doesn't break local development.
const FALLBACK_STUN: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]
let baseIceCache: RTCIceServer[] | null = null
let baseIcePromise: Promise<RTCIceServer[]> | null = null

export async function loadBaseIceServers(): Promise<RTCIceServer[]> {
  if (baseIceCache) return baseIceCache
  if (!baseIcePromise) {
    baseIcePromise = fetch('/api/ice')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j: { iceServers?: RTCIceServer[] }) => (j.iceServers?.length ? j.iceServers : FALLBACK_STUN))
      .catch(e => { console.warn('[ice] /api/ice failed, using fallback:', e); return FALLBACK_STUN })
      .then(servers => {
        const out = [...servers]
        if (import.meta.env.DEV) {
          out.push({ urls: 'turn:127.0.0.1:3478', username: 'test', credential: 'test123' })
        }
        baseIceCache = out
        return out
      })
  }
  return baseIcePromise
}

function getBaseIceServers(): RTCIceServer[] {
  // Synchronous accessor for code paths that need an immediate value. If the
  // async fetch hasn't completed yet, return the fallback rather than blocking
  // RTCPeerConnection creation; `updateTurnServers` will refresh once the real
  // list arrives.
  if (baseIceCache) return baseIceCache
  void loadBaseIceServers()
  const out = [...FALLBACK_STUN]
  if (import.meta.env.DEV) {
    out.push({ urls: 'turn:127.0.0.1:3478', username: 'test', credential: 'test123' })
  }
  return out
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

  // Hot-swap TURN credentials on every live RTCPeerConnection.
  //
  // `setConfiguration` updates the iceServers list without disrupting an
  // already-connected DataChannel — future ICE operations pick up the new
  // creds. For peers currently routing through TURN (relay candidates),
  // we ALSO call `restartIce()` so a fresh ICE exchange happens before the
  // old TURN allocation expires; perfect-negotiation handles offer glare
  // if both sides happen to restart simultaneously.
  async function updateTurnServers(servers: RTCIceServer[]) {
    turnServers = servers
    const next = getIceServers()
    for (const [peerId, pc] of peers) {
      if (pc.connectionState === 'closed') continue
      try { pc.setConfiguration({ iceServers: next }) }
      catch (e) { console.warn('[rtc] setConfiguration failed for', peerId, e) }
      try {
        if (await detectConnectionType(peerId) === 'turn') {
          pc.restartIce()
        }
      } catch { /* ignore */ }
    }
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
    // Evict synchronously and fire onChannelClose ourselves. The natural
    // ch.onclose handler bails out via its `channels.get(peerId) === ch`
    // guard once the map entry is gone, so without an explicit call here
    // the room layer never learns the channel died — which is why a
    // heartbeat-detected timeout used to leave the UI showing "P2P
    // connected" until the user tried to send something.
    const ch = channels.get(peerId)
    if (ch) {
      try { ch.close() } catch { /* ignore */ }
      channels.delete(peerId)
      lastHb.delete(peerId)
      onChannelClose?.(peerId)
    }
    peers.get(peerId)?.close()
    peers.delete(peerId)
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
    updateTurnServers,
    detectConnectionType,
    getIceServers,
    hasOpenChannel: (id: string) => channels.get(id)?.readyState === 'open',
    channelCount: () => channels.size,
  }
}

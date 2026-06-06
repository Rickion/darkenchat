/**
 * WebRTC adapter for Node.js using @roamhq/wrtc.
 * Isolates the native dependency so it can be swapped later.
 *
 * The @roamhq/wrtc package ships a prebuilt native binary (wrtc.node). On hosts
 * whose glibc/ABI is older than the binary was built against, loading it throws
 * at require time (e.g. `GLIBC_2.xx not found`). A static `import` of such a
 * module would crash the whole MCP process before any tool runs — taking down
 * the WS-relay transport too, even though relay needs no WebRTC at all.
 *
 * So we load it defensively with createRequire + try/catch. When it fails we
 * export nulls plus `webrtcAvailable = false`, and room.ts degrades to WSS
 * relay-only (messages routed through the signaling server). When it loads we
 * behave exactly as before — P2P/TURN stays the preferred transport.
 */

import { createRequire } from 'module'

const require = createRequire(import.meta.url)

let wrtc: any = null
let loadError: string | null = null
try {
  wrtc = require('@roamhq/wrtc')
} catch (e) {
  loadError = e instanceof Error ? e.message : String(e)
}

export const webrtcAvailable: boolean = !!wrtc?.RTCPeerConnection
export const webrtcLoadError: string | null = loadError

// Typed as the non-null constructors so call sites in room.ts stay clean; the
// runtime value is null when webrtcAvailable is false, but every use is guarded
// by that flag (initPeer / handleSignal bail out before touching these).
export const RTCPeerConnection = (wrtc?.RTCPeerConnection ?? null) as typeof globalThis.RTCPeerConnection
export const RTCSessionDescription = (wrtc?.RTCSessionDescription ?? null) as typeof globalThis.RTCSessionDescription
export const RTCIceCandidate = (wrtc?.RTCIceCandidate ?? null) as typeof globalThis.RTCIceCandidate

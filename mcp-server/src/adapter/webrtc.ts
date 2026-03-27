/**
 * WebRTC adapter for Node.js using @roamhq/wrtc.
 * Isolates the native dependency so it can be swapped later.
 */

import wrtc from '@roamhq/wrtc'

export const RTCPeerConnection: typeof globalThis.RTCPeerConnection = wrtc.RTCPeerConnection
export const RTCSessionDescription: typeof globalThis.RTCSessionDescription = wrtc.RTCSessionDescription
export const RTCIceCandidate: typeof globalThis.RTCIceCandidate = wrtc.RTCIceCandidate

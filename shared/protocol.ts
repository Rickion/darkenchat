// Signaling protocol shared between the browser, MCP server, and signaling
// server. Anything that goes over the WebSocket lives here so the type
// constraint is enforced on both ends of the wire.
//
// Bump PROTOCOL_VERSION on any breaking change to message shapes. Clients
// send it on `join`; the server rejects mismatches with `protocol_version_mismatch`
// so a stale client gets a clear "please upgrade" error instead of silently
// drifting into an incompatible state. Non-breaking additions (new optional
// fields, new message types old peers can ignore) do NOT require a bump.
export const PROTOCOL_VERSION = 1

export interface MemberInfo {
  clientId: string
  nickname: string
  joinedAt: number
  isBot?: boolean
  isReturning?: boolean
  connType?: 'p2p' | 'turn' | 'relay'
}

export interface RTCSignal {
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
  // When set, this signal belongs to the voice (audio-only) peer-connection
  // plane. Otherwise it's the chat DataChannel plane.
  channel?: 'voice'
}

// ─── Client → Server ────────────────────────────────────────
export type C2S =
  | { type: 'join';            roomKey: string; nickname: string; isBot?: boolean; lastClientId?: string; protocolVersion?: number }
  | { type: 'leave';           roomKey: string }
  | { type: 'signal';          roomKey: string; to: string; payload: RTCSignal }
  | { type: 'score';           roomKey: string; score: number }
  | { type: 'relay';           to: string; data: string }
  | { type: 'member_conn';     clientId: string; connType: 'p2p' | 'turn' | 'relay' }
  | { type: 'heartbeat' }
  | { type: 'kick';            roomKey: string; targetId: string }
  | { type: 'end_room';        roomKey: string }
  | { type: 'set_room_config'; roomKey: string; aiTurnLimit: number }

// ─── Server → Client ────────────────────────────────────────
export type S2C =
  | { type: 'joined';      clientId: string; nickname: string; centerId: string; chairId: string; members: MemberInfo[]; nicknameSet: string; isReturning?: boolean; aiTurnLimit?: number }
  | { type: 'member_join'; member: MemberInfo }
  | { type: 'member_left'; clientId: string; nickname: string }
  | { type: 'member_conn'; clientId: string; connType: 'p2p' | 'turn' | 'relay' }
  | { type: 'new_center';  centerId: string }
  | { type: 'new_chair';   chairId: string; nickname: string }
  | { type: 'signal';      from: string; payload: RTCSignal }
  | { type: 'relay';       from: string; data: string }
  | { type: 'kicked' }
  | { type: 'room_ended' }
  | { type: 'room_banned' }
  | { type: 'room_config'; aiTurnLimit: number; byClientId: string }
  | { type: 'error';       code: string }
  | { type: 'ack' }

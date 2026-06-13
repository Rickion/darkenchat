// Signaling protocol shared between the browser, MCP server, and signaling
// server. Anything that goes over the WebSocket lives here so the type
// constraint is enforced on both ends of the wire.
//
// PROTOCOL_VERSION policy:
//   • Every client MUST send `protocolVersion: PROTOCOL_VERSION` on `join`.
//     The server enforces strict equality — missing field or different value
//     is rejected with `protocol_version_mismatch` and the connection is
//     refused before any room state is touched.
//   • BUMP when you make a BREAKING change to wire formats — anything that
//     would make a v(n-1) client misinterpret or fail to parse a v(n) server
//     payload (or vice-versa). Examples that need a bump:
//        - renaming, removing, or changing the type of an existing field
//        - removing a message `type` that clients depend on
//        - changing the semantics of a code (e.g. what `room_ended` means)
//        - changing how `kicked` is dispatched (broadcast vs targeted)
//   • DO NOT BUMP for purely additive changes that old clients ignore safely:
//        - adding a new optional field with a sensible "absent" default
//        - adding a new message `type` (old clients just don't handle it)
//        - server-internal changes that don't touch the wire
//   • Bump = single digit increment (1 → 2 → 3 …). No semver here — every
//     breaking change is the next integer. Cross-deploy upgrade ordering:
//     deploy server first, then clients. Mid-deploy, mismatched clients get
//     a clean "please upgrade" error instead of silent drift.
export const PROTOCOL_VERSION = 2

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
  | { type: 'join';            roomKey: string; nickname: string; protocolVersion: number; isBot?: boolean; lastClientId?: string }
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

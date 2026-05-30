import type { WebSocket } from '@fastify/websocket'

// Wire-format types are shared with the browser; see shared/protocol.ts.
export type { C2S, S2C, MemberInfo, RTCSignal } from './_shared/protocol.js'
export { PROTOCOL_VERSION } from './_shared/protocol.js'

export interface Member {
  clientId: string
  nickname: string
  joinedAt: number
  isBot: boolean
  ws: WebSocket
  // Wall-clock timestamp of the last heartbeat (or join). Used by the
  // background sweep to evict members whose socket is silently dead.
  lastSeen: number
}

export interface Room {
  key: string
  centerId: string
  chairId: string
  members: Map<string, Member>
  createdAt: number
  banned: boolean
  nicknameSet: string
  // nickname -> { clientId, leftAt }. Lets a reconnecting member reclaim
  // their previous identity by sending the old clientId back on join.
  recentLeft: Map<string, { clientId: string; leftAt: number }>
  // Per-room AI hard turn cap. Set by the chair; 0 means "no limit".
  // When a bot's MCP-side send count reaches this, the MCP refuses further
  // send_message calls and instructs the bot to leave.
  aiTurnLimit: number
  // Pending bots-only dissolve. When the last human drops *unexpectedly*
  // (socket close / heartbeat sweep, not an explicit leave) we don't dissolve
  // the room immediately — we hold it for a grace window so the human can
  // reconnect (via lastClientId) and reclaim their place/center. A human
  // (re)joining clears this; the timer firing re-checks and dissolves only if
  // still bots-only.
  dissolveTimer?: ReturnType<typeof setTimeout>
}

export interface SwitchLog {
  ip: string
  timestamp: number
  toKey: string
  action: 'probe' | 'join' | 'create'
  blocked: boolean
}

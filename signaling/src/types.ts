import type { WebSocket } from '@fastify/websocket'

export interface Member {
  clientId: string
  nickname: string
  joinedAt: number
  isBot: boolean
  ws: WebSocket
}

export interface Room {
  key: string
  centerId: string
  chairId: string
  members: Map<string, Member>
  createdAt: number
  banned: boolean
  nicknameSet: string
  recentLeft: Map<string, number>  // nickname -> timestamp (5min TTL)
}

export interface SwitchLog {
  ip: string
  timestamp: number
  toKey: string
  action: 'probe' | 'join' | 'create'
  blocked: boolean
}

export type C2S =
  | { type: 'join';        roomKey: string; nickname: string; isBot?: boolean; lastClientId?: string }
  | { type: 'leave';       roomKey: string }
  | { type: 'signal';      roomKey: string; to: string; payload: unknown }
  | { type: 'score';       roomKey: string; score: number }
  | { type: 'relay';       to: string; data: string }
  | { type: 'member_conn'; clientId: string; connType: 'p2p' | 'turn' | 'relay' }
  | { type: 'heartbeat' }
  | { type: 'kick';        roomKey: string; targetId: string }
  | { type: 'end_room';    roomKey: string }

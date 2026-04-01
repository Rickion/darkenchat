export type MessageType =
  | 'chat' | 'system' | 'forward' | 'heartbeat' | 'ack'
  | 'poll' | 'canvas' | 'survey' | 'voice'

export interface ForwardPayload {
  messages: Message[]
  note?: string
}

export interface Message {
  id: string
  type: MessageType
  from: string
  fromId: string
  content: string
  timestamp: number
  roomKey: string
  isSystem?: boolean
  forwardOf?: ForwardPayload
  isBot?: boolean
  meta?: Record<string, unknown>
}

export interface MemberInfo {
  clientId: string
  nickname: string
  joinedAt: number
  isBot?: boolean
  isReturning?: boolean
  connType?: 'p2p' | 'turn' | 'relay'
}

// Signaling protocol ─ Client → Server
export type C2S =
  | { type: 'join';      roomKey: string; nickname: string; isBot?: boolean }
  | { type: 'leave';     roomKey: string }
  | { type: 'signal';    roomKey: string; to: string; payload: RTCSignal }
  | { type: 'score';     roomKey: string; score: number }
  | { type: 'relay';     to: string; data: string }
  | { type: 'heartbeat' }

// Signaling protocol ─ Server → Client
export type S2C =
  | { type: 'joined';      clientId: string; centerId: string; chairId: string; members: MemberInfo[]; nicknameSet: string; isReturning?: boolean }
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
  | { type: 'error';       code: string }

export interface RTCSignal {
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

export interface SwitchLog {
  ip: string
  timestamp: number
  toKey: string
  action: 'probe' | 'join' | 'create'
  blocked: boolean
}

// Wire-level protocol types live in shared/ so the signaling server uses the
// same definitions. Anything below is browser-only.
export type { C2S, S2C, MemberInfo, RTCSignal } from '@/_shared/protocol'

export type MessageType =
  | 'chat' | 'system' | 'forward' | 'file' | 'heartbeat' | 'ack'
  | 'poll' | 'canvas' | 'survey' | 'voice'

export interface FileMeta {
  fileId: string
  name: string
  size: number
  mime: string
  ownerId: string
}

export interface VoiceParticipant {
  clientId: string
  nickname: string
  joinedAt: number
}

export interface VoiceSessionMeta {
  voiceKind: 'session' | 'summary'
  sessionId: string
  initiatorId: string
  initiatorNickname: string
  startedAt: number
  participants: VoiceParticipant[]
  // session: filled in when the call ends
  endedAt?: number
  // summary: convenience pre-computed durationMs
  durationMs?: number
}

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

export interface SwitchLog {
  ip: string
  timestamp: number
  toKey: string
  action: 'probe' | 'join' | 'create'
  blocked: boolean
}

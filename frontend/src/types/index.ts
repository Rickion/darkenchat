// Wire-level protocol types live in shared/ so the signaling server uses the
// same definitions. Anything below is browser-only.
export type { C2S, S2C, MemberInfo, RTCSignal } from '@/_shared/protocol'
export { PROTOCOL_VERSION } from '@/_shared/protocol'

export type MessageType =
  | 'chat'
  | 'system'
  | 'forward'
  | 'file'
  | 'heartbeat'
  | 'ack'
  | 'poll'
  | 'canvas'
  | 'survey'
  | 'voice'

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

// Structured expert-panel stance an AI member attaches to a chat message
// (via the MCP send_message tool's `stance` parameter). Humans never set it;
// the browser only renders it. `agreeWith`/`disagreeWith` are clientIds.
export interface MessageStance {
  position: string
  agreeWith?: string[]
  disagreeWith?: string[]
}

// A reply-to reference attached to an outgoing message. `messageId` points at
// the quoted message; `mediaId` is the quoted message's fileId when it was a
// media/file message (so an AI can fetch_media that exact attachment by id).
// `fromNick` + `preview` are denormalised so the quote badge can render without
// the source message still being in the local store.
export interface MessageQuote {
  messageId: string
  mediaId?: string
  fromNick: string
  preview: string
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
  stance?: MessageStance
  quote?: MessageQuote
}

export interface SwitchLog {
  ip: string
  timestamp: number
  toKey: string
  action: 'probe' | 'join' | 'create'
  blocked: boolean
}

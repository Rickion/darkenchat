import type { Room, Member, S2C, MemberInfo } from './types.js'
import { SERIES_KEYS } from './nicknames.js'

// In-memory store
export const rooms = new Map<string, Room>()

export function generateKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let key: string
  do {
    key = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  } while (rooms.has(key))
  return key
}

export function getOrCreateRoom(key: string): Room {
  let room = rooms.get(key)
  if (!room) {
    room = {
      key,
      centerId: '',
      chairId: '',
      members: new Map(),
      createdAt: Date.now(),
      banned: false,
      nicknameSet: SERIES_KEYS[Math.floor(Math.random() * SERIES_KEYS.length)],
      recentLeft: new Map(),
      aiTurnLimit: 0,    // 0 → unlimited until the chair sets one
    }
    rooms.set(key, room)
  }
  return room
}

export function addMember(room: Room, member: Member): void {
  room.members.set(member.clientId, member)
  if (!room.centerId) room.centerId = member.clientId
  if (!room.chairId) room.chairId = member.clientId
}

export function removeMember(room: Room, clientId: string): Member | undefined {
  const member = room.members.get(clientId)
  if (!member) return undefined
  room.members.delete(clientId)

  // Track recent departure so a reconnecting member can reclaim their clientId.
  // TTL is enforced by the sweep in index.ts.
  room.recentLeft.set(member.nickname, { clientId: member.clientId, leftAt: Date.now() })

  if (room.members.size === 0) {
    rooms.delete(room.key)
    return member
  }

  // Chair migration: next earliest non-bot member
  if (room.chairId === clientId) {
    const nextChair = [...room.members.values()]
      .filter(m => !m.isBot)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0]
    if (nextChair) room.chairId = nextChair.clientId
  }

  return member
}

export function broadcast(room: Room, payload: S2C, exceptId?: string): void {
  const data = JSON.stringify(payload)
  for (const member of room.members.values()) {
    if (member.clientId !== exceptId) {
      try { member.ws.send(data) } catch { /* closed */ }
    }
  }
}

export function send(member: Member, payload: S2C): void {
  try { member.ws.send(JSON.stringify(payload)) } catch { /* closed */ }
}

export function memberInfo(m: Member): MemberInfo {
  return {
    clientId: m.clientId,
    nickname: m.nickname,
    joinedAt: m.joinedAt,
    isBot: m.isBot || undefined,
  }
}

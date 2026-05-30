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
      aiTurnLimit: 0, // 0 → unlimited until the chair sets one
    }
    rooms.set(key, room)
  }
  return room
}

export function addMember(room: Room, member: Member): void {
  room.members.set(member.clientId, member)
  // A bot must NEVER hold the centerId or chairId slot:
  //   • center — the MCP client deliberately suppresses its own WebRTC offer
  //     (mcp-server room.ts: onnegotiationneeded is a no-op) because it is
  //     always the polite/answering peer; a bot center would never offer and
  //     the DataChannel would never negotiate. The election in election.ts
  //     also filters bots. This `!isBot` guard is the first line of defence.
  //   • chair — the chairperson is the human room admin (kick / end-room).
  // In practice the "no humans, no bot join" rule means the first member is
  // always human anyway; this guard makes the invariant explicit and holds
  // even if that rule is ever relaxed.
  if (!room.centerId && !member.isBot) room.centerId = member.clientId
  if (!room.chairId && !member.isBot) room.chairId = member.clientId
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
    const nextChair = [...room.members.values()].filter(m => !m.isBot).sort((a, b) => a.joinedAt - b.joinedAt)[0]
    if (nextChair) room.chairId = nextChair.clientId
  }

  return member
}

/**
 * If `room` still has members but all of them are bots, broadcast `room_ended`
 * to every remaining bot, delete the room, and return true. Returns false in
 * every other case (room is gone, room is empty, or at least one human is
 * still present).
 *
 * This mirrors the join-time rule that DarkenChat rooms must have a human:
 * once the last human leaves, the bots-only residue is no longer useful and
 * we shut it down so the bots' MCP loops terminate cleanly instead of holding
 * the room open forever.
 *
 * Callers must invoke this AFTER they've broadcast the triggering
 * `member_left` (so clients see the leave event before the room ending) and
 * BEFORE doing any chair-migration work (which is moot once the room is gone).
 */
export function dissolveIfBotsOnly(room: Room): boolean {
  if (!rooms.has(room.key)) return false
  if (room.members.size === 0) return false
  for (const m of room.members.values()) {
    if (!m.isBot) return false
  }
  if (room.dissolveTimer) {
    clearTimeout(room.dissolveTimer)
    room.dissolveTimer = undefined
  }
  broadcast(room, { type: 'room_ended' })
  rooms.delete(room.key)
  return true
}

// Grace window before a bots-only room is torn down after the last human
// drops *unexpectedly*. Gives the human's client time to auto-reconnect (via
// lastClientId) and reclaim its slot — including the centerId, which still
// points at the reused clientId — so the mesh rebuilds with no human-visible
// interruption. Explicit leaves (a deliberate "leave"/"end room") skip this
// and dissolve immediately.
const DISSOLVE_GRACE_MS = 30_000

/**
 * Like {@link dissolveIfBotsOnly}, but deferred. If the room is now bots-only,
 * arm a one-shot grace timer; when it fires we re-check and dissolve only if
 * still bots-only (a human may have reconnected meanwhile). No-op if a human
 * is present or a timer is already armed.
 */
export function scheduleDissolveIfBotsOnly(room: Room): void {
  if (!rooms.has(room.key)) return
  if (room.members.size === 0) return
  for (const m of room.members.values()) {
    if (!m.isBot) return // a human is still here — nothing to schedule
  }
  if (room.dissolveTimer) return // already counting down
  room.dissolveTimer = setTimeout(() => {
    room.dissolveTimer = undefined
    dissolveIfBotsOnly(room)
  }, DISSOLVE_GRACE_MS)
}

/** Cancel a pending grace dissolve (a human (re)joined within the window). */
export function cancelDissolve(room: Room): void {
  if (room.dissolveTimer) {
    clearTimeout(room.dissolveTimer)
    room.dissolveTimer = undefined
  }
}

/**
 * Broadcast a `new_chair` event ONLY when the chair actually changed.
 *
 * Callers capture `prevChairId` before `removeMember` (which may migrate the
 * chair to the next-earliest human) and pass it here afterwards. If the chair
 * is unchanged we stay silent — without this guard, every non-chair member
 * leaving used to emit a redundant "<nick> is now the chairperson" system
 * message naming the *same* unchanged chair, which spammed the chat history
 * (especially with flaky bots churning leave/join). If the chair slot points
 * at nobody (room mid-dissolve) we also skip.
 */
export function announceChairChange(room: Room, prevChairId: string): void {
  if (room.chairId === prevChairId) return
  const newChair = room.members.get(room.chairId)
  if (!newChair) return
  broadcast(room, { type: 'new_chair', chairId: newChair.clientId, nickname: newChair.nickname })
}

export function broadcast(room: Room, payload: S2C, exceptId?: string): void {
  const data = JSON.stringify(payload)
  for (const member of room.members.values()) {
    if (member.clientId !== exceptId) {
      try {
        member.ws.send(data)
      } catch {
        /* closed */
      }
    }
  }
}

export function send(member: Member, payload: S2C): void {
  try {
    member.ws.send(JSON.stringify(payload))
  } catch {
    /* closed */
  }
}

export function memberInfo(m: Member): MemberInfo {
  return {
    clientId: m.clientId,
    nickname: m.nickname,
    joinedAt: m.joinedAt,
    isBot: m.isBot || undefined,
  }
}

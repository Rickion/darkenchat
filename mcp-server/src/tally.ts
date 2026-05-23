/**
 * Position / agree / disagree tallying for AI expert-panel discussions.
 *
 * Each AI attaches a structured `stance` to its chat messages via the
 * send_message tool's `stance` parameter:
 *
 *   stance: {
 *     position: "Use Redis for the cache layer",
 *     agreeWith:    ["cid_bob", "cid_charlie"],   // clientIds, NOT @nicknames
 *     disagreeWith: ["cid_dan"],
 *   }
 *
 * This module groups each bot's *latest* stance by normalised POSITION text
 * and computes per-AI agreement pressure. There is NO regex and NO free-text
 * header parsing — the stance is a typed field on the message, so it is
 * schema-validated at the tool boundary and immune to the "forgot the @",
 * "wrote nickname not @nickname", "host never injected the protocol" class
 * of failures that the old five-line-header format suffered.
 *
 * Output is consumed by:
 *   - the `tally_positions` MCP tool (so each AI can decide whether to yield)
 *   - the auto-ROUND_COMPLETE detector inside RoomClient
 */

import type { IncomingMessage, RoomMember } from './room.js'

export interface Stance {
  positionNorm: string
  examplePosition: string
  supporters: Array<{ clientId: string; nickname: string }>
}

export interface Tally {
  totalAiMembers: number
  majorityThreshold: number // ceil(N / 2)        — used by the yield rule
  consensusThreshold: number // ceil(N * 0.75)     — used by auto-ROUND_COMPLETE
  stances: Stance[] // sorted desc by supporters.length
  // Per-AI pressure: how many *other* AIs name them in agreeWith / disagreeWith.
  pressureFor: Record<string, number> // by clientId
  pressureAgainst: Record<string, number> // by clientId
}

/** Normalise a POSITION string for grouping (case / whitespace / trailing punctuation). */
function normalisePosition(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?)"'\]>]+$/, '')
    .trim()
}

/**
 * Compute the room-wide tally. Walks `history` newest-first so each bot
 * contributes only its *latest* stance-bearing message.
 */
export function computeTally(history: IncomingMessage[], members: RoomMember[]): Tally {
  const bots = members.filter(m => m.isBot)
  const total = bots.length
  const botById = new Map(bots.map(m => [m.clientId, m]))

  // Each bot's latest message that carries a stance.
  const latest = new Map<string, NonNullable<IncomingMessage['stance']>>()
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    if (msg.isSystem) continue
    if (!msg.fromId || !botById.has(msg.fromId)) continue
    if (latest.has(msg.fromId)) continue
    if (!msg.stance || !msg.stance.position.trim()) continue
    latest.set(msg.fromId, msg.stance)
  }

  // Group by normalised POSITION.
  const groups = new Map<string, { example: string; supporters: RoomMember[] }>()
  for (const [clientId, stance] of latest) {
    const norm = normalisePosition(stance.position)
    if (!norm) continue
    const g = groups.get(norm) ?? { example: stance.position, supporters: [] }
    const member = botById.get(clientId)
    if (member) g.supporters.push(member)
    groups.set(norm, g)
  }

  // Per-AI pressure. agreeWith / disagreeWith are already clientIds — no
  // nickname lookup, no @-token extraction. Each voter contributes at most
  // once per target, and only bot targets count.
  const pressureFor: Record<string, number> = {}
  const pressureAgainst: Record<string, number> = {}
  for (const b of bots) {
    pressureFor[b.clientId] = 0
    pressureAgainst[b.clientId] = 0
  }
  for (const [voterId, stance] of latest) {
    const seenFor = new Set<string>()
    const seenAgainst = new Set<string>()
    for (const tid of stance.agreeWith ?? []) {
      if (botById.has(tid) && tid !== voterId && !seenFor.has(tid)) {
        pressureFor[tid] = (pressureFor[tid] ?? 0) + 1
        seenFor.add(tid)
      }
    }
    for (const tid of stance.disagreeWith ?? []) {
      if (botById.has(tid) && tid !== voterId && !seenAgainst.has(tid)) {
        pressureAgainst[tid] = (pressureAgainst[tid] ?? 0) + 1
        seenAgainst.add(tid)
      }
    }
  }

  const stances: Stance[] = [...groups.entries()]
    .map(([positionNorm, g]) => ({
      positionNorm,
      examplePosition: g.example,
      supporters: g.supporters.map(m => ({ clientId: m.clientId, nickname: m.nickname })),
    }))
    .sort((a, b) => b.supporters.length - a.supporters.length)

  return {
    totalAiMembers: total,
    majorityThreshold: Math.max(1, Math.ceil(total / 2)),
    consensusThreshold: Math.max(1, Math.ceil(total * 0.75)),
    stances,
    pressureFor,
    pressureAgainst,
  }
}

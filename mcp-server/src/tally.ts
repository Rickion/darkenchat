/**
 * Position/agree/disagree tallying for AI expert-panel discussions.
 *
 * Each AI is asked (via its role prompt) to start every chat message with a
 * fixed-field header:
 *
 *   ROUND: 2
 *   POSITION: Use Redis for cache layer
 *   AGREE_WITH: @Bob, @Charlie
 *   DISAGREE_WITH: @Dan
 *   REASON: ...
 *
 * This module parses those headers, groups latest stances by normalised
 * POSITION text, and computes per-AI agreement pressure. Output is consumed
 * by:
 *   - the `tally_positions` MCP tool (so each AI can decide whether to yield)
 *   - the auto-CONSENSUS detector inside RoomClient
 */

import type { IncomingMessage, RoomMember } from './room.js'

export interface StructuredFields {
  round?: number
  position?: string
  positionNorm?: string
  agreeNames: string[]
  disagreeNames: string[]
}

export interface Stance {
  positionNorm: string
  examplePosition: string
  supporters: Array<{ clientId: string; nickname: string }>
}

export interface Tally {
  totalAiMembers: number
  majorityThreshold: number // ceil(N / 2)        — used by yield rule
  consensusThreshold: number // ceil(N * 0.75)     — used by auto-CONSENSUS
  currentRound: number // max ROUND seen in any AI's latest message
  stances: Stance[] // sorted desc by supporters.length
  // Per-AI pressure: how many *other* AIs name them in AGREE_WITH / DISAGREE_WITH
  pressureFor: Record<string, number> // by clientId
  pressureAgainst: Record<string, number> // by clientId
}

const EMPTY_LINE_RE = /^\s*$/

/** Normalise a POSITION line for grouping. */
function normalisePosition(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?)"'\]>]+$/, '')
    .trim()
}

/** Pull `@Name` tokens out of an AGREE_WITH / DISAGREE_WITH line. */
function extractNames(s: string): string[] {
  if (!s || /^\s*none\s*$/i.test(s)) return []
  // Accept ASCII identifiers + CJK; the room nickname generator stays in that
  // set, but explicit @-tokens from the room may contain `-` or `_`.
  const re = /@([A-Za-z0-9_\-一-鿿]+)/g
  return [...s.matchAll(re)].map(m => m[1])
}

/** Parse a message body and return structured fields, or null if no POSITION. */
export function parseStructured(content: string): StructuredFields | null {
  if (!content) return null
  let round: number | undefined
  let position: string | undefined
  let agreeNames: string[] = []
  let disagreeNames: string[] = []

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (EMPTY_LINE_RE.test(line)) continue
    const r = line.match(/^ROUND\s*:\s*(\d+)/i)
    if (r) {
      round = parseInt(r[1], 10)
      continue
    }
    const p = line.match(/^POSITION\s*:\s*(.+)$/i)
    if (p) {
      position = p[1].trim()
      continue
    }
    const a = line.match(/^AGREE_WITH\s*:\s*(.+)$/i)
    if (a) {
      agreeNames = extractNames(a[1])
      continue
    }
    const d = line.match(/^DISAGREE_WITH\s*:\s*(.+)$/i)
    if (d) {
      disagreeNames = extractNames(d[1])
      continue
    }
    // First non-header line ends the header block.
    if (position !== undefined) break
  }

  if (!position) return null
  return {
    round,
    position,
    positionNorm: normalisePosition(position),
    agreeNames,
    disagreeNames,
  }
}

/**
 * Compute the room-wide tally. Walks `history` newest-first so each bot
 * contributes its *latest* structured message.
 */
export function computeTally(history: IncomingMessage[], members: RoomMember[]): Tally {
  const bots = members.filter(m => m.isBot)
  const total = bots.length
  const botById = new Map(bots.map(m => [m.clientId, m]))
  const nickToId = new Map<string, string>()
  for (const m of bots) nickToId.set(m.nickname.toLowerCase(), m.clientId)

  // Each bot's latest structured message
  const latest = new Map<string, StructuredFields>()
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    if (msg.isSystem) continue
    if (!msg.fromId || !botById.has(msg.fromId)) continue
    if (latest.has(msg.fromId)) continue
    const fields = parseStructured(msg.content)
    if (!fields) continue
    latest.set(msg.fromId, fields)
  }

  // Group by normalised POSITION
  const groups = new Map<string, { example: string; supporters: RoomMember[] }>()
  for (const [clientId, fields] of latest) {
    if (!fields.positionNorm || !fields.position) continue
    const g = groups.get(fields.positionNorm) ?? { example: fields.position, supporters: [] }
    const member = botById.get(clientId)
    if (member) g.supporters.push(member)
    groups.set(fields.positionNorm, g)
  }

  // Compute pressure (each voter contributes once per target)
  const pressureFor: Record<string, number> = {}
  const pressureAgainst: Record<string, number> = {}
  for (const b of bots) {
    pressureFor[b.clientId] = 0
    pressureAgainst[b.clientId] = 0
  }

  for (const [voterId, fields] of latest) {
    const seenFor = new Set<string>(),
      seenAgainst = new Set<string>()
    for (const name of fields.agreeNames) {
      const tid = nickToId.get(name.toLowerCase())
      if (tid && tid !== voterId && !seenFor.has(tid)) {
        pressureFor[tid] = (pressureFor[tid] ?? 0) + 1
        seenFor.add(tid)
      }
    }
    for (const name of fields.disagreeNames) {
      const tid = nickToId.get(name.toLowerCase())
      if (tid && tid !== voterId && !seenAgainst.has(tid)) {
        pressureAgainst[tid] = (pressureAgainst[tid] ?? 0) + 1
        seenAgainst.add(tid)
      }
    }
  }

  let currentRound = 0
  for (const f of latest.values()) if (typeof f.round === 'number') currentRound = Math.max(currentRound, f.round)

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
    currentRound,
    stances,
    pressureFor,
    pressureAgainst,
  }
}

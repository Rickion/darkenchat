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
 * CONSENSUS IS JUDGED ON THE AGREEMENT GRAPH, NOT ON POSITION TEXT.
 * An earlier version grouped stances by normalised POSITION text, so two AIs
 * that agreed in substance but phrased their position differently fell into
 * different groups and never reached `consensusThreshold` — which pushed AIs
 * into transcribing each other's exact wording just to "register" agreement.
 * That coupling was the bug. Now we cluster by `agreeWith` (clientId) edges
 * using union-find: each `agreeWith` link unions two bots, `disagreeWith`
 * marks a cluster as CONTESTED (disqualified from consensus), and the largest
 * non-contested cluster is what consensus is measured against. Position TEXT
 * is used only as a *display label* for a cluster (the chair's / earliest
 * member's wording becomes the cluster's single topic title), never for the
 * judgement itself.
 *
 * Output is consumed by:
 *   - the `tally_positions` MCP tool (so each AI can decide whether to yield)
 *   - the auto-ROUND_COMPLETE detector inside RoomClient
 */

import type { IncomingMessage, RoomMember } from './room.js'

// One agreement cluster — a set of bots transitively linked by `agreeWith`.
// `label` is the cluster's single topic title (chair / earliest member's
// position wording); supporters are folded under it. `contested` is true when
// the cluster contains an internal `disagreeWith` edge, which disqualifies it
// from counting toward consensus.
export interface Stance {
  rootId: string // representative clientId (union-find root), stable cluster key
  label: string // unique topic title = chair/earliest supporter's position text
  positionNorm: string // normalised label — used by the ROUND_COMPLETE throttle
  examplePosition: string // alias of `label`, kept for existing consumers
  supporters: Array<{ clientId: string; nickname: string }>
  contested: boolean
}

export interface Tally {
  totalAiMembers: number
  majorityThreshold: number // ceil(N / 2)        — used by the yield rule
  consensusThreshold: number // ceil(N * 0.75)     — used by auto-ROUND_COMPLETE
  // Agreement clusters, sorted: non-contested first, then by size desc. So
  // stances[0] is the largest agreeing cluster, and consensus = its size
  // reaching consensusThreshold (when it is not contested).
  stances: Stance[]
  // Per-AI pressure: how many *other* AIs name them in agreeWith / disagreeWith.
  pressureFor: Record<string, number> // by clientId
  pressureAgainst: Record<string, number> // by clientId
}

/** Normalise a POSITION string (case / whitespace / trailing punctuation) — label key only. */
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

  // ── Cluster by agreement graph (union-find over agreeWith edges) ──────────
  // Nodes = bots that posted a latest stance. Each agreeWith link unions the
  // voter with its target; only links between two stance-bearing bots count.
  const parent = new Map<string, string>()
  for (const id of latest.keys()) parent.set(id, id)
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    // Path compression.
    let cur = x
    while (parent.get(cur) !== r) {
      const next = parent.get(cur)!
      parent.set(cur, r)
      cur = next
    }
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const [voterId, stance] of latest) {
    for (const tid of stance.agreeWith ?? []) {
      if (latest.has(tid) && tid !== voterId) union(voterId, tid)
    }
  }

  // Collect disagree edges between two stance-bearing bots; a cluster that
  // contains such an edge internally is CONTESTED (cannot count as consensus).
  const contestedRoots = new Set<string>()
  for (const [voterId, stance] of latest) {
    for (const tid of stance.disagreeWith ?? []) {
      if (latest.has(tid) && tid !== voterId && find(voterId) === find(tid)) {
        contestedRoots.add(find(voterId))
      }
    }
  }

  // Group members by cluster root.
  const clusters = new Map<string, string[]>()
  for (const id of latest.keys()) {
    const r = find(id)
    const arr = clusters.get(r)
    if (arr) arr.push(id)
    else clusters.set(r, [id])
  }

  // Cluster label = the position wording of its chair / earliest-joined member
  // (ties → smallest clientId), so a cluster has one stable, unique title and
  // all supporters fold under it regardless of how each phrased their stance.
  const joinedAtOf = (id: string) => botById.get(id)?.joinedAt ?? 0
  const stances: Stance[] = [...clusters.entries()]
    .map(([root, ids]) => {
      const repId = ids.slice().sort((a, b) => {
        const ja = joinedAtOf(a)
        const jb = joinedAtOf(b)
        if (ja !== jb) return ja - jb
        return a < b ? -1 : 1
      })[0]
      const label = latest.get(repId)!.position
      return {
        rootId: root,
        label,
        positionNorm: normalisePosition(label),
        examplePosition: label,
        supporters: ids.map(id => {
          const m = botById.get(id)!
          return { clientId: m.clientId, nickname: m.nickname }
        }),
        contested: contestedRoots.has(root),
      }
    })
    .sort((a, b) => {
      // Non-contested clusters rank first, then by size desc.
      if (a.contested !== b.contested) return a.contested ? 1 : -1
      return b.supporters.length - a.supporters.length
    })

  return {
    totalAiMembers: total,
    majorityThreshold: Math.max(1, Math.ceil(total / 2)),
    consensusThreshold: Math.max(1, Math.ceil(total * 0.75)),
    stances,
    pressureFor,
    pressureAgainst,
  }
}

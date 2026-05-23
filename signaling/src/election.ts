import type { Room } from './types.js'
import { rooms, broadcast } from './rooms.js'

// peerId → score (only populated during election)
const electionScores = new Map<string, { room: Room; score: number }>()

/**
 * Called when a client reports its election score.
 * When all non-bot, non-failed members have reported, elect winner.
 *
 * ⚠️ INVARIANT: the centre node is ALWAYS a human (non-bot). The candidate
 * filter below (`!m.isBot`) is load-bearing — it is relied upon by the MCP
 * client, whose `onnegotiationneeded` handler is a deliberate no-op (the bot
 * is always the polite/answering WebRTC peer and never sends an offer). A bot
 * promoted to centre would never offer, so no DataChannel would ever
 * negotiate. If you ever want AI-as-centre, you MUST first restore the bot's
 * offer capability in `mcp-server/src/room.ts` — see the comment there.
 */
export function handleScore(roomKey: string, clientId: string, score: number): void {
  const room = rooms.get(roomKey)
  if (!room) return

  electionScores.set(clientId, { room, score })

  // Check if all expected members have reported
  const nonBotMembers = [...room.members.values()].filter(m => !m.isBot)
  const reported = nonBotMembers.filter(m => electionScores.has(m.clientId))

  if (reported.length < nonBotMembers.length) return // still waiting

  // Elect highest scorer
  let best = reported[0]
  for (const m of reported) {
    const s = electionScores.get(m.clientId)?.score ?? 0
    if (s > (electionScores.get(best.clientId)?.score ?? 0)) best = m
  }

  // Clear scores
  for (const m of reported) electionScores.delete(m.clientId)

  if (best.clientId === room.centerId) return // no change

  room.centerId = best.clientId
  broadcast(room, { type: 'new_center', centerId: best.clientId })
}

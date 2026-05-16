import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { RoomClient, isServerAllowed } from './room.js'

// Reminder handed back on join — many hosts otherwise long-poll once, hit the
// timeout, and stop. The room connection lives in this MCP process and stays
// alive regardless; the AI just has to keep asking.
const STAY_IN_ROOM_INSTRUCTIONS =
  'You are now IN the room and must STAY until the task is done. ' +
  'Immediately enter a loop: call wait_for_mention again and again. A timeout ' +
  '(timedOut:true, empty messages) is NOT a signal to stop — it just means ' +
  'nothing happened yet, so call wait_for_mention again. Only stop the loop ' +
  'when roomStatus becomes terminal (kicked/room_ended/disconnected), when you ' +
  'see a CONSENSUS: system message, or when the human task is complete — then ' +
  'call leave_room.'

// One client per room (keyed by roomKey). The client now owns its own history
// buffer, so we no longer maintain a parallel messageStores map here.
const clients = new Map<string, RoomClient>()

export function registerTools(server: McpServer) {

  // ── join_room ───────────────────────────────────────────
  server.tool(
    'join_room',
    'Join a DarkenChat room as an AI member. IMPORTANT: joining is not a one-shot action — once joined you MUST stay and keep long-polling with wait_for_mention in a loop until the task is done (see the `instructions` field in the result). Returns the session including the *server-assigned* nickname (may differ from requested due to dedup), the current member list (keep those clientIds — you need them to @mention people), and `isChair`: true when you are the panel chairperson (by default the first AI to enter the room — the chair coordinates the discussion and produces the final summary).',
    {
      serverUrl: z.string().describe('WebSocket signaling server URL, e.g. wss://example.com/ws. With no custom TURN configured (env DARKENCHAT_TURN_URLS) this MCP is locked to one domain (default chat.darken.cc).'),
      roomKey:   z.string().describe('4-character room key (case-insensitive)'),
      nickname:  z.string().optional().describe('Requested display name (default: "AI"). Server may suffix it if taken.'),
    },
    async ({ serverUrl, roomKey, nickname = 'AI' }) => {
      const key = roomKey.toUpperCase()

      if (clients.has(key)) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Already joined this room' }) }] }
      }

      // Domain lock: without custom TURN env the AI can only reach rooms on the
      // default domain (it has no working ICE credentials for any other).
      const allowed = isServerAllowed(serverUrl)
      if (!allowed.ok) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: allowed.reason }) }] }
      }

      const client = new RoomClient()

      try {
        const session = await client.join(serverUrl, key, nickname)
        clients.set(key, client)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success:      true,
              clientId:     session.clientId,
              nickname:     session.nickname,
              nicknameSet:  session.nicknameSet,
              roomKey:      session.roomKey,
              members:      session.members,
              transport:    client.transportInUse(),
              isChair:      client.isChair(),
              turnCount:    client.turnInfo(),
              instructions: STAY_IN_ROOM_INSTRUCTIONS,
            }),
          }],
        }
      } catch (err: any) {
        clients.delete(key)
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: err.message ?? String(err) }) }] }
      }
    },
  )

  // ── send_message ────────────────────────────────────────
  server.tool(
    'send_message',
    'Send a chat message. To @mention members pass `mentions: [{clientId, nickname}]` — server rewrites matching `@nickname` occurrences in `content` to mention chips. Without `mentions`, any `@Nick` matching a current member is auto-converted. To address everyone, pass `{clientId: "ALL", nickname: "All"}` (or "所有人"); to address every AI only, pass `{clientId: "ALL_AI", nickname: "AllAI"}` (or "所有AI") — or simply write `@All` / `@所有人` / `@AllAI` / `@所有AI` in `content` and it will be auto-converted to the right chip. There is no hard *AI-level* send cap: instead the AI keeps counting its own turns, and once `turnCount.count` reaches `turnCount.convergeAt` (default 12, env DARKENCHAT_CONVERGE_TURNS) the result carries a `convergeNotice` — an MCP-local reminder (not a chat message) to start converging. The **chairperson** of the room (any human) MAY set a per-room hard cap via the UI; when present (`turnCount.roomLimit > 0`) this tool hard-refuses with `room_turn_limit_reached` once `count >= roomLimit` — call leave_room immediately. In multi-AI panels every AI should @-mention the other AIs by name, and the AI chairperson (see join_room `isChair`) gives the final summary. For expert-panel discussions the first lines of `content` must follow ROUND/POSITION/AGREE_WITH/DISAGREE_WITH/REASON — see your role prompt and use `tally_positions` to check whether you must yield first.',
    {
      roomKey: z.string(),
      content: z.string().describe('Message text. Newlines preserved as paragraph breaks. Use `@Nickname` to reference a member, or `@All` / `@所有人` to address everyone.'),
      mentions: z
        .array(z.object({
          clientId: z.string().describe('Target member clientId (from join_room or get_messages). Use the sentinel "ALL" to address every member at once.'),
          nickname: z.string().describe('Target member nickname (must match `@Nickname` substring in content). For the ALL sentinel, pass the alias you used in content (e.g. "All" or "所有人").'),
        }))
        .optional()
        .describe('Optional explicit mention list. Overrides auto-detection.'),
    },
    async ({ roomKey, content, mentions }) => {
      const client = clients.get(roomKey.toUpperCase())
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not in this room' }) }] }
      }
      const result = client.sendMessage(content, mentions)
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(
            result.ok
              ? {
                  success:   true,
                  transport: result.transport,
                  messageId: result.messageId,
                  timestamp: result.timestamp,
                  turnCount: { count: result.turnCount, convergeAt: result.convergeAt },
                  ...(result.convergeNotice ? { convergeNotice: result.convergeNotice } : {}),
                }
              : { success: false, error: result.error, turnCount: client.turnInfo() },
          ),
        }],
      }
    },
  )

  // ── get_messages ────────────────────────────────────────
  server.tool(
    'get_messages',
    'Retrieve recent messages. Each message includes `mentionedMe` (true when a chip targets your clientId, or when an @everyone chip — clientId "ALL" — was used) and `mentions: [{clientId, nickname}]`. `roomStatus` flags kicked/room_ended/disconnected so you can stop polling. Prefer `wait_for_mention` for the steady-state loop and use this only to scan history.',
    {
      roomKey: z.string(),
      limit:   z.number().optional().describe('Max messages to return (default: 20)'),
      since:   z.number().optional().describe('Unix ms timestamp — return messages after this time'),
      onlyMentions: z.boolean().optional().describe('When true, return only messages where mentionedMe is true.'),
    },
    async ({ roomKey, limit = 20, since, onlyMentions }) => {
      const key = roomKey.toUpperCase()
      const client = clients.get(key)
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not in this room' }) }] }
      }
      let messages = client.getMessages(limit, since)
      if (onlyMentions) messages = messages.filter(m => m.mentionedMe)
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success:    true,
            roomStatus: client.getStatus(),
            transport:  client.transportInUse(),
            turnCount:  client.turnInfo(),
            messages,
          }),
        }],
      }
    },
  )

  // ── wait_for_mention ────────────────────────────────────
  server.tool(
    'wait_for_mention',
    'Long-poll: block until a message @mentioning you arrives, a system event fires (kicked / room_ended / member_join / new_center / CONSENSUS / …), or the timeout elapses. THIS IS YOUR STEADY STATE — after join_room you MUST call this in a loop and keep calling it. A result with `timedOut: true` and an empty `messages` array does NOT mean you are done or that the room is idle for good; it only means nothing happened during this wait window — immediately call wait_for_mention again. The room connection is held open by the MCP process the whole time; stopping the loop on a timeout silently abandons the room. The ONLY reasons to break the loop: roomStatus turns terminal (kicked/room_ended/disconnected), a CONSENSUS: system message arrives, or the human task is complete — then call leave_room. Pass `since` (timestamp of your last seen message) to avoid re-processing backlog.',
    {
      roomKey:       z.string(),
      timeoutMs:     z.number().int().min(1_000).max(300_000).optional().describe('Max wait time in milliseconds. Default 30000, hard cap 300000. Set this below your host MCP tool-call timeout (Claude Code defaults around 60s; raise MCP_TIMEOUT if you need longer waits).'),
      since:         z.number().optional().describe('Unix-ms timestamp. Only messages with timestamp > since are returned. Pass the timestamp of the last message you handled to avoid duplicates.'),
      includeSystem: z.boolean().optional().describe('When true (default), system events (kicked/room_ended/member_join/new_center/CONSENSUS) also wake the call. Set false to wait strictly for chat mentions.'),
    },
    async ({ roomKey, timeoutMs = 30_000, since, includeSystem = true }) => {
      const key = roomKey.toUpperCase()
      const client = clients.get(key)
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not in this room' }) }] }
      }
      const messages = await client.waitForMention(timeoutMs, since, includeSystem)
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success:    true,
            roomStatus: client.getStatus(),
            transport:  client.transportInUse(),
            timedOut:   messages.length === 0,
            messages,
          }),
        }],
      }
    },
  )

  // ── tally_positions ─────────────────────────────────────
  server.tool(
    'tally_positions',
    'Parse the ROUND/POSITION/AGREE_WITH/DISAGREE_WITH headers from each AI\'s latest structured message and return: stances grouped by normalised POSITION (with supporters), per-AI agree/disagree pressure, current round, majority + consensus thresholds. Call this BEFORE composing every message: if `myStance.shouldYield` is true (pressureAgainst >= majorityThreshold) you must change POSITION this round rather than restating. Auto-CONSENSUS fires server-side when any stance reaches `consensusThreshold` — you will then see a system message starting with `CONSENSUS:` and should call leave_room.',
    { roomKey: z.string() },
    async ({ roomKey }) => {
      const key = roomKey.toUpperCase()
      const client = clients.get(key)
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not in this room' }) }] }
      }
      const tally = client.computeTally()
      const session = client.getSession()
      if (!tally || !session) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not yet joined' }) }] }
      }
      const myId = session.clientId
      const pressureFor     = tally.pressureFor[myId]     ?? 0
      const pressureAgainst = tally.pressureAgainst[myId] ?? 0
      const myStance: { position?: string; round: number; pressureFor: number; pressureAgainst: number; shouldYield: boolean } = {
        round:           tally.currentRound,
        pressureFor,
        pressureAgainst,
        shouldYield:     pressureAgainst >= tally.majorityThreshold,
      }
      for (const s of tally.stances) {
        if (s.supporters.some(sup => sup.clientId === myId)) {
          myStance.position = s.examplePosition
          break
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success:            true,
            currentRound:       tally.currentRound,
            totalAiMembers:     tally.totalAiMembers,
            majorityThreshold:  tally.majorityThreshold,
            consensusThreshold: tally.consensusThreshold,
            stances:            tally.stances,
            myStance,
          }),
        }],
      }
    },
  )

  // ── leave_room ──────────────────────────────────────────
  server.tool(
    'leave_room',
    'Leave a DarkenChat room and tear down all transports.',
    {
      roomKey: z.string(),
    },
    async ({ roomKey }) => {
      const key = roomKey.toUpperCase()
      const client = clients.get(key)
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not in this room' }) }] }
      }
      client.leave()
      clients.delete(key)
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] }
    },
  )
}

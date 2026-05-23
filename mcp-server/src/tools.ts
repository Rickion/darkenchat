import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { RoomClient, isServerAllowed, dlog } from './room.js'

// The authoritative, must-obey rule list, returned in the `instructions`
// field of every successful join_room call.
//
// WHY IT LIVES HERE (not only in the agent-guide resource): a tool result is
// delivered through a channel every MCP host surfaces to the model. MCP
// *resources* are an optional pull — many hosts never fetch them. Any rule an
// AI must obey therefore lives in this constant, in the AI's context the
// moment it joins. The darkenchat://agent-guide resource only *explains* these
// rules; if the two ever drift, this list is authoritative.
const AGENT_RULES = [
  'You are now IN the room. The following are the BINDING rules for your entire stay — obey them. (The darkenchat://agent-guide resource only explains them in more depth; this list is authoritative.)',
  '',
  '1. STAY AND LOOP. join_room is NOT a one-shot action. Immediately call wait_for_mention, and keep calling it in a loop — this is your steady state. Stopping the loop silently abandons the room.',
  '2. KEEPALIVE IS NOT AN EVENT. A wait_for_mention result of {keepalive:true} is a transport-level frame — you were never woken; the MCP just had to settle the RPC before the host timeout. Call wait_for_mention again with the same arguments. Never mention keepalive in chat; never read it as "nothing is happening".',
  '3. LEAVE ONLY on (a) a terminal roomStatus — kicked / room_ended / room_banned / disconnected — or (b) an explicit "please leave" from a human in the room. Nothing else is an exit signal.',
  '4. ROUND_COMPLETE IS NOT AN EXIT. A "ROUND_COMPLETE:" system message means this round of discussion converged — acknowledge briefly (e.g. send "Confirmed, no further comments") and KEEP POLLING. The room stays open for the next topic.',
  '5. NO GREETINGS / FAREWELLS. The server broadcasts join/leave system events automatically. Do not send "Hi everyone" / "Goodbye" chat messages.',
  '6. REPLY ONLY when a message has mentionedMe:true, or a human directly asks you. Do not answer messages that are not aimed at you.',
  '7. EXPERT PANELS: pass send_message\'s optional `stance` object (position + agreeWith/disagreeWith as clientId ARRAYS — not @nicknames). Put no header in `content`. Call tally_positions before composing; if myStance.shouldYield is true you must change your position.',
  '8. CHAIR HANDOVER: if you receive a system message starting "You have been promoted to AI panel chairperson", take over chair duties from that point — coordinate the panel and write the round summary — even if your join_room result said isChair:false.',
  '9. HARD TURN CAP: if send_message returns `room_turn_limit_reached`, or you see a "ROOM_LIMIT_REACHED:" system message, stop sending and call leave_room.',
  '10. PRIVACY: this is a no-log, ephemeral environment. Do not store or repeat room messages anywhere outside the room.',
].join('\n')

// One client per room (keyed by roomKey). The client now owns its own history
// buffer, so we no longer maintain a parallel messageStores map here.
const clients = new Map<string, RoomClient>()

// ── Idle watchdog ───────────────────────────────────────────────────
// An MCP process staying alive is NOT proof the AI is still engaged. Some
// hosts (observed: opencode, openclaw) call a tool once and never loop —
// the AI has effectively left, but the WebSocket heartbeat keeps ticking
// so the signaling server still lists the bot as present. That makes the
// member list lie.
//
// The only honest signal of "the AI is alive" is the AI *calling tools*.
// A healthy bot loops wait_for_mention, so a tool call starts at least
// every `timeoutMs`. We record the start of every tool call; if nothing
// has called in (last wait timeout + grace), the AI abandoned the loop —
// we leave the room so membership reflects reality.
let lastToolCallAt = Date.now()
let lastWaitTimeoutMs = 30_000
const WATCHDOG_GRACE_MS = 60_000
const WATCHDOG_TICK_MS = 15_000

// Called at the top of every tool handler to refresh the activity clock.
function markToolCall() {
  lastToolCallAt = Date.now()
}

setInterval(() => {
  if (clients.size === 0) return
  const idleFor = Date.now() - lastToolCallAt
  const threshold = lastWaitTimeoutMs + WATCHDOG_GRACE_MS
  // While a wait_for_mention is in flight the last tool call started < its
  // own timeout ago, so `idleFor` stays small — the watchdog only trips
  // once the host has genuinely stopped calling tools.
  if (idleFor <= threshold) return
  dlog(
    `idle watchdog FIRED — no tool call for ${idleFor}ms (threshold ${threshold}ms = ` +
      `lastWaitTimeoutMs ${lastWaitTimeoutMs} + grace ${WATCHDOG_GRACE_MS}). Leaving ${clients.size} room(s).`,
  )
  for (const [key, client] of clients) {
    client.leave()
    clients.delete(key)
  }
}, WATCHDOG_TICK_MS).unref?.()

export function registerTools(server: McpServer) {
  // ── join_room ───────────────────────────────────────────
  server.tool(
    'join_room',
    'Join a DarkenChat room as an AI member. IMPORTANT: joining is not a one-shot action — once joined you MUST stay and keep long-polling with wait_for_mention in a loop until the task is done (see the `instructions` field in the result). Returns the session including the *server-assigned* nickname (may differ from requested due to dedup), the current member list (keep those clientIds — you need them to @mention people), and `isChair`: true when you are the panel chairperson (by default the first AI to enter the room — the chair coordinates the discussion and produces the final summary). REQUIRES at least one human member already in the room — the signaling server rejects bots that try to join an empty room or a bots-only room with `no_humans_in_room`. If you get that error, do NOT retry on a loop; report the situation back to the user so they can enter the room first.',
    {
      serverUrl: z
        .string()
        .describe(
          'WebSocket signaling server URL, e.g. wss://example.com/ws. With no custom TURN configured (env DARKENCHAT_TURN_URLS) this MCP is locked to one domain (default chat.darken.cc).',
        ),
      roomKey: z.string().describe('4-character room key (case-insensitive)'),
      nickname: z
        .string()
        .optional()
        .describe('Requested display name (default: "AI"). Server may suffix it if taken.'),
    },
    async ({ serverUrl, roomKey, nickname = 'AI' }) => {
      markToolCall()
      const key = roomKey.toUpperCase()

      if (clients.has(key)) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ success: false, error: 'Already joined this room' }) },
          ],
        }
      }

      // Domain lock: without custom TURN env the AI can only reach rooms on the
      // default domain (it has no working ICE credentials for any other).
      const allowed = isServerAllowed(serverUrl)
      if (!allowed.ok) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: allowed.reason }) }] }
      }

      const client = new RoomClient()

      dlog(`join_room ENTER room=${key} nickname=${nickname} server=${serverUrl}`)
      try {
        const session = await client.join(serverUrl, key, nickname)
        clients.set(key, client)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                clientId: session.clientId,
                nickname: session.nickname,
                nicknameSet: session.nicknameSet,
                roomKey: session.roomKey,
                members: session.members,
                transport: client.transportInUse(),
                isChair: client.isChair(),
                turnCount: client.turnInfo(),
                instructions: AGENT_RULES,
              }),
            },
          ],
        }
      } catch (err: any) {
        clients.delete(key)
        dlog(`join_room FAILED room=${key}: ${err?.message ?? String(err)}`)
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ success: false, error: err.message ?? String(err) }) },
          ],
        }
      }
    },
  )

  // ── send_message ────────────────────────────────────────
  server.tool(
    'send_message',
    'Send a chat message. To @mention members pass `mentions: [{clientId, nickname}]` — server rewrites matching `@nickname` occurrences in `content` to mention chips. Without `mentions`, any `@Nick` matching a current member is auto-converted. To address everyone, pass `{clientId: "ALL", nickname: "All"}` (or "所有人"); to address every AI only, pass `{clientId: "ALL_AI", nickname: "AllAI"}` (or "所有AI") — or simply write `@All` / `@所有人` / `@AllAI` / `@所有AI` in `content` and it will be auto-converted to the right chip. There is no hard *AI-level* send cap: instead the AI keeps counting its own turns, and on every multiple of `turnCount.convergeAt` (default 12, env DARKENCHAT_CONVERGE_TURNS) — i.e. turn 12, 24, 36, … — the result carries a `convergeNotice` — an MCP-local reminder (not a chat message) to start converging. The **chairperson** of the room (any human) MAY set a per-room hard cap via the UI; when present (`turnCount.roomLimit > 0`) this tool hard-refuses with `room_turn_limit_reached` once `count >= roomLimit` — call leave_room immediately. EXPERT-PANEL DISCUSSIONS: pass the optional `stance` object — `position` is your stance this turn (free text), `agreeWith`/`disagreeWith` are arrays of *clientIds* (NOT @nicknames). Put NO header in `content`; just write your prose. The server tallies stances structurally (see `tally_positions`); call `tally_positions` before composing to see if you must yield. @-mention the other AIs by clientId so the discussion stays threaded. The AI chairperson (see join_room `isChair`) writes the round summary when the panel converges — a plain summary, or a short "Confirmed, no further comments" if nothing to add. The server emits the `ROUND_COMPLETE:` system message on its own; you never declare round-completion yourself.',
    {
      roomKey: z.string(),
      content: z
        .string()
        .describe(
          'Message text. Newlines preserved as paragraph breaks. Use `@Nickname` to reference a member, or `@All` / `@所有人` to address everyone.',
        ),
      mentions: z
        .array(
          z.object({
            clientId: z
              .string()
              .describe(
                'Target member clientId (from join_room or get_messages). Use the sentinel "ALL" to address every member at once.',
              ),
            nickname: z
              .string()
              .describe(
                'Target member nickname (must match `@Nickname` substring in content). For the ALL sentinel, pass the alias you used in content (e.g. "All" or "所有人").',
              ),
          }),
        )
        .optional()
        .describe('Optional explicit mention list. Overrides auto-detection.'),
      stance: z
        .object({
          position: z
            .string()
            .describe('Your stance on the current topic this turn, as free text. The server normalises it for grouping.'),
          agreeWith: z
            .array(z.string())
            .optional()
            .describe('clientIds of AIs whose position you agree with (from join_room / get_messages member lists). NOT @nicknames.'),
          disagreeWith: z
            .array(z.string())
            .optional()
            .describe('clientIds of AIs whose position you disagree with. NOT @nicknames.'),
        })
        .optional()
        .describe(
          'Optional structured stance for expert-panel discussions. When present, this message counts toward `tally_positions` and the auto-ROUND_COMPLETE detector. Omit it for ordinary chat. Replaces the old free-text ROUND/POSITION header — do NOT write that header in `content`.',
        ),
    },
    async ({ roomKey, content, mentions, stance }) => {
      markToolCall()
      const client = clients.get(roomKey.toUpperCase())
      if (!client) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not in this room' }) }],
        }
      }
      const result = client.sendMessage(content, mentions, stance)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              result.ok
                ? {
                    success: true,
                    transport: result.transport,
                    messageId: result.messageId,
                    timestamp: result.timestamp,
                    turnCount: { count: result.turnCount, convergeAt: result.convergeAt },
                    ...(result.convergeNotice ? { convergeNotice: result.convergeNotice } : {}),
                  }
                : { success: false, error: result.error, turnCount: client.turnInfo() },
            ),
          },
        ],
      }
    },
  )

  // ── get_messages ────────────────────────────────────────
  server.tool(
    'get_messages',
    'Retrieve recent messages. Each message includes `mentionedMe` (true when a chip targets your clientId, or when an @everyone chip — clientId "ALL" — was used) and `mentions: [{clientId, nickname}]`. `roomStatus` flags kicked/room_ended/disconnected so you can stop polling. Prefer `wait_for_mention` for the steady-state loop and use this only to scan history.',
    {
      roomKey: z.string(),
      limit: z.number().optional().describe('Max messages to return (default: 20)'),
      since: z.number().optional().describe('Unix ms timestamp — return messages after this time'),
      onlyMentions: z.boolean().optional().describe('When true, return only messages where mentionedMe is true.'),
    },
    async ({ roomKey, limit = 20, since, onlyMentions }) => {
      markToolCall()
      const key = roomKey.toUpperCase()
      const client = clients.get(key)
      if (!client) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not in this room' }) }],
        }
      }
      let messages = client.getMessages(limit, since)
      if (onlyMentions) messages = messages.filter(m => m.mentionedMe)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              roomStatus: client.getStatus(),
              transport: client.transportInUse(),
              turnCount: client.turnInfo(),
              messages,
            }),
          },
        ],
      }
    },
  )

  // ── wait_for_mention ────────────────────────────────────
  server.tool(
    'wait_for_mention',
    'Long-poll: block until a message @mentioning you arrives, a system event fires (kicked / room_ended / member_join / new_center / ROUND_COMPLETE / …), or a transport-level keepalive is emitted. THIS IS YOUR STEADY STATE — after join_room you MUST call this in a loop and keep calling it. The room connection is held open by the MCP process the whole time; stopping the loop silently abandons the room. **Possible return shapes:** (a) `{ keepalive: true }` — a TRANSPORT-LEVEL infrastructure frame, NOT a business event. You were never woken; the MCP just had to settle the RPC before the host\'s tool-call timeout. Immediately call wait_for_mention again with the same parameters; do NOT mention keepalive in chat, do NOT interpret it as "nothing is happening", do NOT decide to stay/leave based on it. (b) `{ success: true, roomStatus, transport, messages: [...] }` — REAL data; handle the messages. A `ROUND_COMPLETE:` system message in `messages` means this round of discussion agreed — acknowledge briefly and KEEP POLLING; the room stays open for follow-up. (c) `{ success: true, roomStatus: <terminal>, messages: [] }` — only when roomStatus is kicked/room_ended/room_banned/disconnected; call leave_room. **The ONLY reasons to break the loop:** roomStatus turns terminal OR a human explicitly asks you to leave. **ALWAYS pass `since` = timestamp of the last message you handled** to avoid receiving backlog you\'ve already processed (saves host context tokens).',
    {
      roomKey: z.string(),
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(300_000)
        .optional()
        .describe(
          'Max wait time in milliseconds. Default 30000, hard cap 300000. Set this below your host MCP tool-call timeout (Claude Code defaults around 60s; raise MCP_TIMEOUT if you need longer waits).',
        ),
      since: z
        .number()
        .optional()
        .describe(
          'Unix-ms timestamp. Only messages with timestamp > since are returned. Pass the timestamp of the last message you handled to avoid duplicates.',
        ),
      includeSystem: z
        .boolean()
        .optional()
        .describe(
          'When true (default), system events (kicked/room_ended/member_join/new_center/ROUND_COMPLETE) also wake the call. Set false to wait strictly for chat mentions.',
        ),
    },
    async ({ roomKey, timeoutMs = 30_000, since, includeSystem = true }) => {
      markToolCall()
      // Record the wait window so the idle watchdog scales its threshold to
      // however long this AI's poll cycle actually is.
      lastWaitTimeoutMs = timeoutMs
      const key = roomKey.toUpperCase()
      const client = clients.get(key)
      if (!client) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not in this room' }) }],
        }
      }
      const waitStart = Date.now()
      dlog(`wait_for_mention ENTER room=${key} timeoutMs=${timeoutMs} status=${client.getStatus()}`)
      const messages = await client.waitForMention(timeoutMs, since, includeSystem)

      // Three return shapes — see the tool description above. Empty-and-active
      // is reframed as `{ keepalive: true }` (minimal payload, transport
      // semantics) so the model treats it as TCP-level noise instead of a
      // business "timeout" event. Terminal status with empty messages still
      // surfaces roomStatus so the existing leave-on-terminal rule fires.
      if (messages.length === 0) {
        const status = client.getStatus()
        const isTerminal =
          status === 'kicked' || status === 'room_ended' || status === 'room_banned' || status === 'disconnected'
        dlog(
          `wait_for_mention EXIT room=${key} waited=${Date.now() - waitStart}ms ` +
            `→ ${isTerminal ? `terminal(${status})` : 'keepalive'}`,
        )
        if (isTerminal) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ success: true, roomStatus: status, messages: [] }),
              },
            ],
          }
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ keepalive: true }) }],
        }
      }
      dlog(`wait_for_mention EXIT room=${key} waited=${Date.now() - waitStart}ms → ${messages.length} message(s)`)

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              roomStatus: client.getStatus(),
              transport: client.transportInUse(),
              messages,
            }),
          },
        ],
      }
    },
  )

  // ── tally_positions ─────────────────────────────────────
  server.tool(
    'tally_positions',
    "Tally the structured `stance` from each AI's latest stance-bearing message (see send_message's `stance` parameter — there is no free-text header to parse any more) and return: stances grouped by normalised POSITION (with supporters), per-AI agree/disagree pressure, majority + consensus thresholds. Call this BEFORE composing every panel message: if `myStance.shouldYield` is true (pressureAgainst >= majorityThreshold) you must change your `position` rather than restating. Auto round-completion fires server-side when any stance reaches `consensusThreshold` — you will then see a system message starting with `ROUND_COMPLETE:`. That marks the current converged position as agreed; acknowledge briefly and keep polling for the next topic. (A later convergence on a *different* position re-fires ROUND_COMPLETE — no round numbers involved.) **Do NOT call leave_room on ROUND_COMPLETE** — only leave on terminal roomStatus or explicit human request.",
    { roomKey: z.string() },
    async ({ roomKey }) => {
      markToolCall()
      const key = roomKey.toUpperCase()
      const client = clients.get(key)
      if (!client) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not in this room' }) }],
        }
      }
      const tally = client.computeTally()
      const session = client.getSession()
      if (!tally || !session) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not yet joined' }) }],
        }
      }
      const myId = session.clientId
      const pressureFor = tally.pressureFor[myId] ?? 0
      const pressureAgainst = tally.pressureAgainst[myId] ?? 0
      const myStance: {
        position?: string
        pressureFor: number
        pressureAgainst: number
        shouldYield: boolean
      } = {
        pressureFor,
        pressureAgainst,
        shouldYield: pressureAgainst >= tally.majorityThreshold,
      }
      for (const s of tally.stances) {
        if (s.supporters.some(sup => sup.clientId === myId)) {
          myStance.position = s.examplePosition
          break
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              totalAiMembers: tally.totalAiMembers,
              majorityThreshold: tally.majorityThreshold,
              consensusThreshold: tally.consensusThreshold,
              stances: tally.stances,
              myStance,
            }),
          },
        ],
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
      markToolCall()
      const key = roomKey.toUpperCase()
      const client = clients.get(key)
      if (!client) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not in this room' }) }],
        }
      }
      client.leave()
      clients.delete(key)
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] }
    },
  )
}

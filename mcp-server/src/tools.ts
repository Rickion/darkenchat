import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomClient, isServerAllowed, dlog } from './room.js'

// MIME prefixes the MCP can hand back as an inline content block. Anything else
// (pdf, zip, generic binary) has no inline representation and is returned as a
// temp-file path instead.
function inlineKindFor(mime: string): 'image' | 'audio' | null {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  return null
}

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
  "7. EXPERT PANELS: pass send_message's optional `stance` object (position + agreeWith/disagreeWith as clientId ARRAYS — not @nicknames). Put no header in `content`. Consensus is judged on the AGREEMENT GRAPH, not on matching wording: to agree, list the other AIs' clientIds in `agreeWith` — do NOT copy their exact `position` text. Call tally_positions before composing; if myStance.shouldYield is true you must change your position.",
  '8. CHAIR HANDOVER: if you receive a system message starting "You have been promoted to AI panel chairperson", take over chair duties from that point — coordinate the panel and write the round summary — even if your join_room result said isChair:false.',
  '9. HARD TURN CAP: if send_message returns `room_turn_limit_reached`, or you see a "ROOM_LIMIT_REACHED:" system message, stop sending and call leave_room.',
  '10. STALE-SEND GUARD: if send_message returns `error: "unseen_mentions"`, a new message @-mentioning you arrived after your last read — read the entries in `unseen`, decide whether your reply is still appropriate, and only re-call send_message if it is. The refusal already advances the floor, so the retry will go through; do not loop.',
  '11. PRIVACY: this is a no-log, ephemeral environment. Do not store or repeat room messages anywhere outside the room.',
].join('\n')

// One client per room (keyed by roomKey). The client now owns its own history
// buffer, so we no longer maintain a parallel messageStores map here.
const clients = new Map<string, RoomClient>()

// Leave every joined room and tear down its transports. Called when the host
// closes the stdio pipe (process shutting down): each room gets a real `leave`
// frame, so peers see a normal "X left" event immediately instead of waiting
// for the signaling server's silent-socket sweep.
//
// NOTE: there is deliberately NO idle / "no tool call" watchdog. In the MCP
// pull model the server only sees the AI when it calls a tool; between calls
// the host LLM may be inferring for an arbitrarily long time. No
// time-since-last-call threshold can tell "thinking" apart from "abandoned",
// so any such watchdog inevitably false-kicks AIs mid-inference. Liveness is
// judged solely by the WebSocket heartbeat (RoomClient.startHeartbeat), which
// ticks as long as the process is alive regardless of AI activity.
export function leaveAllRooms() {
  for (const [key, client] of clients) {
    client.leave()
    clients.delete(key)
  }
}

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
    'Send a chat message. To @mention members pass `mentions: [{clientId, nickname}]` — server rewrites matching `@nickname` occurrences in `content` to mention chips. Without `mentions`, any `@Nick` matching a current member is auto-converted. To address everyone, pass `{clientId: "ALL", nickname: "All"}` (or "所有人"); to address every AI only, pass `{clientId: "ALL_AI", nickname: "AllAI"}` (or "所有AI") — or simply write `@All` / `@所有人` / `@AllAI` / `@所有AI` in `content` and it will be auto-converted to the right chip. There is no hard *AI-level* send cap: instead the AI keeps counting its own turns, and on every multiple of `turnCount.convergeAt` (default 12, env DARKENCHAT_CONVERGE_TURNS) — i.e. turn 12, 24, 36, … — the result carries a `convergeNotice` — an MCP-local reminder (not a chat message) to start converging. The **chairperson** of the room (any human) MAY set a per-room hard cap via the UI; when present (`turnCount.roomLimit > 0`) this tool hard-refuses with `room_turn_limit_reached` once `count >= roomLimit` — call leave_room immediately. STALE-SEND GUARD: if a chat message mentioning you arrived after your last get_messages / wait_for_mention return, this tool refuses with `error: "unseen_mentions"` and returns those messages in `unseen`. Read them, decide whether your composed reply is still appropriate (it may now be redundant or off-topic), and only re-call send_message if it is — the second call always goes through because the floor advances on every refusal. EXPERT-PANEL DISCUSSIONS: pass the optional `stance` object — `position` is your stance this turn (free text), `agreeWith`/`disagreeWith` are arrays of *clientIds* (NOT @nicknames). Put NO header in `content`; just write your prose. The server clusters stances by the AGREEMENT GRAPH (your `agreeWith` clientIds), NOT by matching position text — so to agree with someone you list their clientId in `agreeWith` and keep your own wording; you never have to transcribe their exact phrasing. Call `tally_positions` before composing to see your cluster and whether you must yield. @-mention the other AIs by clientId so the discussion stays threaded. The AI chairperson (see join_room `isChair`) writes the round summary when the panel converges — a plain summary, or a short "Confirmed, no further comments" if nothing to add. The server emits the `ROUND_COMPLETE:` system message on its own; you never declare round-completion yourself.',
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
            .describe(
              'Your stance on the current topic this turn, as free text. The server normalises it for grouping.',
            ),
          agreeWith: z
            .array(z.string())
            .optional()
            .describe(
              'clientIds of AIs whose position you agree with (from join_room / get_messages member lists). NOT @nicknames.',
            ),
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
                : {
                    success: false,
                    error: result.error,
                    turnCount: client.turnInfo(),
                    ...(result.unseen ? { unseen: result.unseen } : {}),
                  },
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

  // ── fetch_media ─────────────────────────────────────────
  server.tool(
    'fetch_media',
    'Pull a media attachment (image / audio / file) that was shared in the room, by its `mediaId`. Media messages surfaced by get_messages / wait_for_mention carry a `media` object — its `media.mediaId` is what you pass here (a quoted message may instead expose the id as `quote.mediaId`). The MCP requests the bytes from the member who owns the file and reassembles them. **mode** controls the return shape: `inline` (default) hands the content straight back as an MCP image/audio block so you can see/hear it in-context — USE THIS FOR IMAGES; `file` writes the bytes to a temp file on the host and returns its path (use for large files, non-displayable types like PDF/zip, or when you want to process the file with another tool). Non-image/non-audio types always come back as a file path regardless of mode. CONTEXT COST: an inline image is expensive in tokens — fetch it once, and prefer delegating heavy image analysis to a sub-agent that returns text rather than re-fetching. Fails if the owner has left the room or the media id is unknown.',
    {
      roomKey: z.string(),
      mediaId: z
        .string()
        .describe('The media id to fetch — `media.mediaId` (or `quote.mediaId`) from a message you received.'),
      mode: z
        .enum(['inline', 'file'])
        .optional()
        .describe(
          'inline (default): return the bytes as an MCP image/audio content block. file: write to a host temp file and return the path. Non-image/audio media is always returned as a file path.',
        ),
    },
    async ({ roomKey, mediaId, mode = 'inline' }) => {
      const key = roomKey.toUpperCase()
      const client = clients.get(key)
      if (!client) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not in this room' }) }],
        }
      }
      dlog(`fetch_media ENTER room=${key} mediaId=${mediaId} mode=${mode}`)
      try {
        const { data, name, mime } = await client.fetchMedia(mediaId)
        const inlineKind = inlineKindFor(mime)

        if (mode === 'inline' && inlineKind) {
          dlog(`fetch_media EXIT room=${key} mediaId=${mediaId} → inline ${inlineKind} (${data.length} bytes)`)
          return {
            content: [
              { type: inlineKind as 'image' | 'audio', data: data.toString('base64'), mimeType: mime },
              {
                type: 'text' as const,
                text: JSON.stringify({ success: true, mediaId, name, mime, size: data.length, mode: 'inline' }),
              },
            ],
          }
        }

        // file mode, or a type with no inline representation.
        const safeName = name.replace(/[^\w.\-]+/g, '_').slice(-100) || 'media'
        const path = join(tmpdir(), `darkenchat-${mediaId}-${safeName}`)
        await writeFile(path, data)
        const note =
          mode === 'inline' && !inlineKind
            ? 'Type is not image/audio — returned as a file path instead of an inline block.'
            : undefined
        dlog(`fetch_media EXIT room=${key} mediaId=${mediaId} → file ${path} (${data.length} bytes)`)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                mediaId,
                name,
                mime,
                size: data.length,
                mode: 'file',
                path,
                ...(note ? { note } : {}),
              }),
            },
          ],
        }
      } catch (err: any) {
        dlog(`fetch_media FAILED room=${key} mediaId=${mediaId}: ${err?.message ?? String(err)}`)
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ success: false, error: err?.message ?? String(err) }) },
          ],
        }
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
    "Tally the structured `stance` from each AI's latest stance-bearing message (see send_message's `stance` parameter) and return: agreement CLUSTERS (bots transitively linked by `agreeWith`, each with a single `label` = the chair/earliest member's wording, all `supporters` folded under it, and a `contested` flag when an internal `disagreeWith` disputes it), per-AI agree/disagree pressure, and majority + consensus thresholds. CONSENSUS IS JUDGED ON THE AGREEMENT GRAPH, NOT ON MATCHING POSITION TEXT — to register agreement you put the other AIs' clientIds in your `agreeWith`; you do NOT have to copy their exact wording. Call this BEFORE composing every panel message: if `myStance.shouldYield` is true (pressureAgainst >= majorityThreshold) you must change your `position` rather than restating. Auto round-completion fires server-side when the largest non-contested cluster reaches `consensusThreshold` — you will then see a system message starting with `ROUND_COMPLETE:`. That marks the current converged topic as agreed; acknowledge briefly and keep polling for the next topic. (A later convergence on a *different* topic re-fires ROUND_COMPLETE — no round numbers involved.) **Do NOT call leave_room on ROUND_COMPLETE** — only leave on terminal roomStatus or explicit human request.",
    { roomKey: z.string() },
    async ({ roomKey }) => {
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

  // ── on_stop ─────────────────────────────────────────────
  // NOT for the AI to call — it is the target of the host's "Stop" hook
  // (Claude Code: hooks.json `mcp_tool` type). The hook fires whenever the
  // agent finishes a turn and is about to stop. A HEALTHY bot never truly
  // stops: it loops wait_for_mention, so its turn never ends. When the loop
  // *does* end while we are still in a live room, that is the zombie signal —
  // the AI abandoned the room with the process still alive. We answer by
  // BLOCKING the stop and pushing the AI straight back into its poll loop, so
  // a zombie can never form. The only way the agent is allowed to actually
  // stop is when no room is live any more (room_ended / kicked / left), at
  // which point we tear down any terminal residue and let it go.
  //
  // Wire contract (Claude Code): the host treats this tool's text output like
  // command-hook stdout — if it parses as the decision JSON `{decision:"block",
  // reason}` the stop is blocked and `reason` is fed back to the AI; any other
  // text is shown as plain text and is non-blocking (stop proceeds). MCP
  // disconnected / isError is also non-blocking, so a dead MCP fails open.
  server.tool(
    'on_stop',
    'Host-hook target (not for the AI to call directly). Invoked by the host Stop hook when the agent is about to finish. Returns a block decision that keeps an active room member polling, or allows the stop and cleans up when no room is live.',
    {},
    async () => {
      const live = [...clients.values()].filter(c => c.isActive())
      if (live.length > 0) {
        const keys = live.map(c => c.getSession()?.roomKey).filter(Boolean)
        dlog(`on_stop BLOCK — still in live room(s): ${keys.join(', ')} → resume polling`)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                decision: 'block',
                reason:
                  `You are still an active DarkenChat member in room(s): ${keys.join(', ')}. ` +
                  'Do NOT stop — resume your wait_for_mention loop now (call wait_for_mention again ' +
                  'with the same roomKey). Per the room rules you only stop on a terminal roomStatus ' +
                  '(kicked / room_ended / room_banned / disconnected) or an explicit human request to leave.',
              }),
            },
          ],
        }
      }
      // No live room — clean up any terminal residue and allow the stop.
      const had = clients.size
      leaveAllRooms()
      dlog(`on_stop ALLOW — no live room (cleaned ${had} residual client(s)) → stop proceeds`)
      return {
        content: [{ type: 'text' as const, text: 'darkenchat: no active room, stop allowed' }],
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

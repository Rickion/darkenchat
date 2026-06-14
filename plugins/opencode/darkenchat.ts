// DarkenChat opencode plugin.
//
// PURPOSE — same goal as the Claude Code plugin's Stop hook, but opencode's
// model is different and we cannot reuse the same mechanism:
//
//   • Claude Code exposes a *blocking* `Stop` hook: a `mcp_tool` hook runs
//     INSIDE the darkenchat MCP process and can return {decision:"block"} to
//     refuse the stop and shove the AI back into its wait_for_mention loop.
//   • opencode has NO blocking stop. The `session.idle` event is fire-and-
//     forget — the docs state plugins "cannot block the idle transition"
//     (see opencode issue #16879). Plugin handlers also run in the OPENCODE
//     process, not the MCP process, so they can neither read the MCP's
//     in-memory room state nor call its `on_stop` tool.
//
// So here the equivalent of "block & resume polling" is RE-PROMPT: when a
// session goes idle while it is still in a live DarkenChat room, we inject a
// prompt via client.session.prompt that tells the AI to resume wait_for_mention.
// The AI replies → calls wait_for_mention → goes busy again, so a zombie
// (process alive but no longer polling) cannot persist.
//
// GATING — we must only re-prompt sessions that are actually in a live room,
// never ordinary sessions. We cannot ask the MCP, so we read the session's own
// transcript (client.session.messages) and infer room liveness from the
// darkenchat tool RESULTS recorded there. Two facts forced the current design:
//   • join_room's success result carries NO `roomStatus` (it has clientId /
//     isChair / transport / members / instructions, but no status).
//   • wait_for_mention's steady-state timeout returns `{ keepalive: true }`,
//     also with NO `roomStatus`.
// So a freshly-joined AI that is just quietly long-polling has ZERO `roomStatus`
// anywhere in its transcript. An earlier version keyed liveness solely on
// `roomStatus` and therefore NEVER re-prompted that (very common) case — the AI
// would stop and silently abandon the room. We now treat join/keepalive/active-
// status as POSITIVE liveness evidence and only the terminal markers (terminal
// roomStatus, or a "Not in this room" error) as the kill signal, comparing their
// most-recent positions in document order. All markers are JSON-shaped so they
// match tool RESULTS, never the prose inside tool descriptions / AGENT_RULES.

// Type-only import — erased at runtime, so the plugin still loads even if the
// types package isn't installed in the host.
import type { Plugin } from '@opencode-ai/plugin'

const PLUGIN_VERSION = '0.2.1'

const RESUME_PROMPT =
  'SYSTEM (darkenchat): you went idle but you are still a member of a live DarkenChat ' +
  'room. Do not stop. Resume your steady state now: call wait_for_mention again with the ' +
  'same roomKey and keep looping. Only stop on a terminal roomStatus (kicked / room_ended / ' +
  'room_banned / disconnected) or an explicit human request to leave.'

// JSON-shaped liveness markers. These match the serialised tool RESULTS, not the
// descriptive prose in tool schemas (which also mentions "roomStatus", "kicked",
// "leave_room" etc.), because they require the exact JSON `"key":value` form.
const ALIVE_MARKERS: RegExp[] = [
  /"keepalive"\s*:\s*true/g, // wait_for_mention steady-state timeout
  /"roomStatus"\s*:\s*"(?:connecting|connected)"/g, // active status from get_messages / wait_for_mention
  /"isChair"\s*:\s*(?:true|false)/g, // join_room success signature
]
const DEAD_MARKERS: RegExp[] = [
  /"roomStatus"\s*:\s*"(?:kicked|room_ended|room_banned|disconnected)"/g, // terminal status
  /"error"\s*:\s*"Not in this room"/g, // post-leave / kicked: tool refuses
]

export const DarkenChatPlugin: Plugin = async ({ client }) => {
  // Structured logging. The opencode plugin guide and the SDK disagree on the
  // exact arg shape (flat vs { body }), and a bad shape would throw, so we try
  // both and fall back to stderr. The user explicitly wants visible logs.
  const log = async (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
    const entry = { service: 'darkenchat', level, message }
    try {
      await (client as any).app.log({ body: entry })
    } catch {
      try {
        await (client as any).app.log(entry)
      } catch {
        console.error(`[darkenchat ${new Date().toISOString()}] ${level}: ${message}`)
      }
    }
  }

  // Runs once at startup, before the hooks are returned — a positive "plugin is
  // loaded" signal so we can tell "loaded but never triggered" from "not loaded".
  await log('info', `plugin loaded (v${PLUGIN_VERSION}); listening for session.idle`)

  // Position (index of the last match) of the most recent marker from a set.
  // -1 means the set never matched. Later index = more recent in the transcript.
  const lastIndexOf = (text: string, regexes: RegExp[]): number => {
    let idx = -1
    for (const re of regexes) {
      re.lastIndex = 0
      for (const m of text.matchAll(re)) {
        if (m.index !== undefined && m.index > idx) idx = m.index
      }
    }
    return idx
  }

  // Decide, from a session's transcript, whether it is still in a live room.
  const isInLiveRoom = async (sessionID: string): Promise<boolean> => {
    let res: unknown
    try {
      res = await client.session.messages({ path: { id: sessionID } })
    } catch (err) {
      await log('warn', `messages() failed for ${sessionID}: ${String(err)} → fail-safe: no re-prompt`)
      return false // fail-safe: if we can't tell, don't re-prompt
    }
    const text = JSON.stringify(res ?? '')
    const aliveIdx = lastIndexOf(text, ALIVE_MARKERS)
    const deadIdx = lastIndexOf(text, DEAD_MARKERS)

    if (aliveIdx === -1) {
      // No evidence the session ever joined a darkenchat room.
      await log(
        'debug',
        `${sessionID}: no darkenchat liveness markers in transcript (len=${text.length}) → not a room session; tail=${text.slice(-300)}`,
      )
      return false
    }
    const live = aliveIdx > deadIdx
    await log(
      'info',
      `${sessionID}: liveness check aliveIdx=${aliveIdx} deadIdx=${deadIdx} → ${live ? 'LIVE (re-prompt)' : 'TERMINATED (no re-prompt)'}`,
    )
    return live
  }

  return {
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      // Trace the events we care about so "did session.idle even fire?" is answerable.
      if (event.type === 'session.idle' || event.type === 'session.status') {
        const p = event.properties ?? {}
        await log('debug', `event ${event.type} keys=[${Object.keys(p).join(',')}]`)
      }
      if (event.type !== 'session.idle') return

      // opencode names this sessionID (older builds: sessionId). Accept either.
      const props = event.properties ?? {}
      const sessionID = (props.sessionID ?? props.sessionId ?? props.session_id) as string | undefined
      if (!sessionID) {
        await log('warn', `session.idle without a session id (keys=[${Object.keys(props).join(',')}]); skipping`)
        return
      }

      if (!(await isInLiveRoom(sessionID))) return

      await log('info', `session ${sessionID} idle while in a live room → re-prompting to resume polling`)
      try {
        await client.session.prompt({
          path: { id: sessionID },
          body: { parts: [{ type: 'text', text: RESUME_PROMPT }] },
        })
        await log('info', `re-prompt sent to ${sessionID}`)
      } catch (err) {
        await log('error', `re-prompt failed for ${sessionID}: ${String(err)}`)
      }
    },
  }
}

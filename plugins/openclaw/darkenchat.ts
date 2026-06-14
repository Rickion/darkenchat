// DarkenChat OpenClaw plugin.
//
// PURPOSE — same goal as the Claude Code Stop hook and the opencode re-prompt
// plugin: keep an AI that has joined a live DarkenChat room from going SILENT.
// The darkenchat MCP server is launched by the OpenClaw gateway and persists
// as a single process across turns, so the room connection stays open. The
// failure mode is NOT the process dying — it is the *model* ending its turn
// (compaction / maxTurns / an error / simply deciding to stop) and then nobody
// re-driving `wait_for_mention`. Process alive, member still in the room, but
// mute. OpenClaw has no Claude-style blocking Stop hook to refuse that.
//
// WHY THIS LOOKS DIFFERENT FROM THE OPENCODE PLUGIN — OpenClaw's plugin model
// is not opencode's. Two hard constraints, both verified against the docs
// (docs.openclaw.ai/concepts/agent-loop, /plugins/hooks, /gateway/heartbeat):
//
//   1. A turn is ONLY triggered by an inbound message, a cron job, or the
//      built-in HEARTBEAT. A plugin CANNOT spontaneously wake an idle agent —
//      there is no `client.session.prompt`-style imperative "start a turn" API
//      exposed to plugins. So we cannot push an idle agent the way the opencode
//      plugin does.
//   2. The only ambient driver that fires without external input is the
//      heartbeat (default 30 min; 60 min on Anthropic OAuth accounts).
//
// So the OpenClaw-native equivalent of "block the stop and resume polling" is:
//   • heartbeat_prompt_contribution — runs on every heartbeat turn; when this
//     session is still in a live room we PREPEND an instruction telling the AI
//     to resume `wait_for_mention`. This is the guaranteed recovery path: a
//     muted room member is re-driven within one heartbeat interval, bounded and
//     self-healing. (Lower the heartbeat interval for room agents if you want a
//     tighter window — see README.)
//   • agent_end — when a turn ends while still in a live room, we ALSO queue a
//     next-turn injection with the same instruction, so that whatever fires the
//     *next* turn (heartbeat, inbound message, or cron) immediately re-drives
//     polling instead of waiting for the heartbeat prompt to be composed.
//
// GATING — like the opencode plugin, this code runs in the GATEWAY process, not
// inside the MCP, so it cannot read the MCP's in-memory room state. We infer
// room liveness from the darkenchat tool RESULTS via the after_tool_call hook
// and keep a per-session flag in memory (the gateway is one persistent process,
// so the map survives across turns within its lifetime). The markers are the
// same JSON-shaped signals the opencode plugin uses, so they match serialised
// tool RESULTS, never the descriptive prose in tool schemas.

// Runtime import from the OpenClaw plugin SDK, resolved by the gateway at load
// time (not installed in this repo — tsc reports it missing locally, which is
// expected and benign, same as the opencode plugin's missing-types note).
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_VERSION = "0.1.0";

const RESUME_INSTRUCTION =
  "SYSTEM (darkenchat): you are still a member of a live DarkenChat room but your " +
  "polling loop has stopped. Do not stay idle. Resume your steady state now: call " +
  "wait_for_mention again with the same roomKey and keep looping. Only stop on a " +
  "terminal roomStatus (kicked / room_ended / room_banned / disconnected) or an " +
  "explicit human request to leave.";

// JSON-shaped liveness markers — they match serialised tool RESULTS, not the
// prose in tool descriptions (which also mentions "roomStatus", "kicked",
// "leave_room"), because they require the exact JSON `"key":value` form.
const ALIVE_MARKERS: RegExp[] = [
  /"keepalive"\s*:\s*true/, // wait_for_mention steady-state timeout
  /"roomStatus"\s*:\s*"(?:connecting|connected)"/, // active status from get_messages / wait_for_mention
  /"isChair"\s*:\s*(?:true|false)/, // join_room success signature
];
const DEAD_MARKERS: RegExp[] = [
  /"roomStatus"\s*:\s*"(?:kicked|room_ended|room_banned|disconnected)"/, // terminal status
  /"error"\s*:\s*"Not in this room"/, // post-leave / kicked: tool refuses
];

// Terminal session_end reasons after which we should forget a session entirely.
const TERMINAL_SESSION_REASONS = new Set(["deleted", "shutdown", "restart"]);

export default definePluginEntry({
  id: "darkenchat",
  name: "DarkenChat room keepalive",
  register(api: any) {
    // Per-session room liveness, keyed by sessionId. Lives for the gateway
    // process lifetime; that is exactly the window in which an MCP room can be
    // live, so in-memory is sufficient and avoids depending on the (less
    // documented) registerSessionExtension persistence API.
    const liveSessions = new Set<string>();

    // OpenClaw plugin SDK and docs disagree on the exact log surface, and a bad
    // call would throw inside a hook, so try a couple shapes then fall back to
    // stderr (the gateway captures it).
    const log = (
      level: "info" | "debug" | "warn" | "error",
      message: string,
    ) => {
      const entry = { service: "darkenchat", level, message };
      try {
        if (typeof api.log === "function") return void api.log(entry);
        if (api.logger && typeof api.logger[level] === "function")
          return void api.logger[level](message);
      } catch {
        /* fall through */
      }
      console.error(
        `[darkenchat ${new Date().toISOString()}] ${level}: ${message}`,
      );
    };

    // sessionId can live in a few places depending on hook; accept all.
    const sessionIdOf = (event: any): string | undefined => {
      const ctx = event?.ctx ?? event ?? {};
      return (
        ctx.sessionId ?? ctx.sessionKey ?? event?.sessionId ?? event?.sessionKey
      );
    };

    // Update liveness from any darkenchat tool RESULT. We stringify the whole
    // event and compare the most-recent ALIVE vs DEAD marker, so we do not
    // depend on the exact result field name or the host's MCP tool-naming.
    const updateLivenessFromEvent = (sessionId: string, event: any) => {
      const text = JSON.stringify(event ?? "");
      const alive = ALIVE_MARKERS.some((re) => re.test(text));
      const dead = DEAD_MARKERS.some((re) => re.test(text));
      if (dead) {
        // Terminal signal wins — a "Not in this room" / terminal roomStatus in
        // the same result means we have left.
        if (liveSessions.delete(sessionId))
          log("info", `${sessionId}: terminal marker → room no longer live`);
      } else if (alive) {
        if (!liveSessions.has(sessionId)) {
          liveSessions.add(sessionId);
          log(
            "info",
            `${sessionId}: alive marker → tracking as live DarkenChat room`,
          );
        }
      }
    };

    log(
      "info",
      `plugin loaded (v${PLUGIN_VERSION}); heartbeat-based room keepalive armed`,
    );

    // ── Observe tool results to track room liveness ─────────────────────────
    api.on("after_tool_call", async (event: any) => {
      try {
        const sessionId = sessionIdOf(event);
        if (!sessionId) return;
        updateLivenessFromEvent(sessionId, event);
      } catch (err) {
        log("warn", `after_tool_call handler error: ${String(err)}`);
      }
    });

    // ── Turn ended: queue a resume nudge for whatever fires the next turn ───
    api.on("agent_end", async (event: any) => {
      try {
        const sessionId = sessionIdOf(event);
        if (!sessionId || !liveSessions.has(sessionId)) return;
        // enqueueNextTurnInjection is delivered exactly-once on the next model
        // turn (deduped by idempotencyKey per plugin). It does NOT trigger a
        // turn by itself — the heartbeat does that — but it ensures the next
        // turn, whatever triggers it, resumes polling immediately. Best-effort.
        if (typeof api.enqueueNextTurnInjection === "function") {
          await api.enqueueNextTurnInjection({
            sessionId,
            idempotencyKey: "darkenchat-resume",
            context: RESUME_INSTRUCTION,
            content: RESUME_INSTRUCTION,
          });
          log(
            "info",
            `${sessionId}: turn ended in live room → queued resume injection`,
          );
        }
      } catch (err) {
        log("warn", `agent_end handler error: ${String(err)}`);
      }
    });

    // ── Heartbeat: the guaranteed ambient recovery path ─────────────────────
    // Runs only on heartbeat turns; returns context to prepend. When the
    // session is still in a live room, instruct the AI to resume polling.
    api.on("heartbeat_prompt_contribution", async (event: any) => {
      try {
        const sessionId = sessionIdOf(event);
        if (!sessionId || !liveSessions.has(sessionId)) return;
        log(
          "info",
          `${sessionId}: heartbeat while in live room → injecting resume instruction`,
        );
        return { prependContext: RESUME_INSTRUCTION };
      } catch (err) {
        log(
          "warn",
          `heartbeat_prompt_contribution handler error: ${String(err)}`,
        );
        return;
      }
    });

    // ── Forget sessions that are truly gone ─────────────────────────────────
    api.on("session_end", async (event: any) => {
      try {
        const sessionId = sessionIdOf(event);
        if (!sessionId) return;
        const reason = event?.reason ?? event?.ctx?.reason;
        if (TERMINAL_SESSION_REASONS.has(reason)) {
          if (liveSessions.delete(sessionId))
            log("info", `${sessionId}: session_end (${reason}) → forgotten`);
        }
      } catch (err) {
        log("warn", `session_end handler error: ${String(err)}`);
      }
    });
  },
});

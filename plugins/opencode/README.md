# DarkenChat — opencode plugin

Two pieces, because in opencode the MCP server and the plugin are configured
separately (unlike the Claude Code plugin, which bundles both):

1. **MCP server** — merge the `mcp` block from `opencode.json.example` into your
   opencode config (`./opencode.json` for a project, or
   `~/.config/opencode/opencode.json` globally). It runs the server via
   `npx -y darkenchat@latest`, so nothing needs to be installed globally — npx
   fetches and runs the package (and its prebuilt native deps) on first use.

2. **Plugin** — drop `darkenchat.ts` into the opencode plugin directory:
   - project: `.opencode/plugin/darkenchat.ts`
   - global: `~/.config/opencode/plugin/darkenchat.ts`

   Files there are auto-loaded at startup; no extra registration needed.

## Why a plugin at all

opencode's `session.idle` event is fire-and-forget — it **cannot block** the
agent from stopping (opencode issue #16879), and plugin code runs in the
opencode process, not inside the MCP server. So unlike the Claude Code Stop
hook (which blocks the stop and resumes the loop in-process), this plugin
**re-prompts** an idle session that is still in a live DarkenChat room, telling
the AI to resume its `wait_for_mention` loop. That prevents the zombie state
(process alive, AI no longer polling).

It gates strictly: it reads the session transcript and only re-prompts when the
most recent `roomStatus` is `connecting`/`connected`. Terminal statuses
(`kicked` / `room_ended` / `room_banned` / `disconnected`) or no DarkenChat
activity at all → it does nothing.

## Runtime-verify note

The exact shape of opencode message "parts" isn't a stable documented API, so
room detection scans the serialised transcript for `roomStatus` rather than
binding to a schema. If a future opencode build changes `client.app.log`,
`client.session.messages`, or the `session.idle` payload field name, adjust
`darkenchat.ts` accordingly — the code already tolerates `sessionID` /
`sessionId` / `session_id` and two `app.log` arg shapes.

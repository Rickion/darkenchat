# DarkenChat MCP — Examples

Drop-in artifacts for running an **AI expert-panel discussion** inside a DarkenChat room. A human posts a problem; multiple AI personas (moderator + experts) `@`-mention each other to converge on a single answer, then leave.

## What's here

```
examples/
├── mcp.json.example          ← host config snippet (Claude Desktop / Cursor / Claude Code)
├── prompts/                  ← (reserved) drop your role-prompt .md files here
└── launchers/                ← (reserved) drop host launcher scripts here
```

The role-prompt and launcher subdirectories are intentionally empty in the repo —
they exist as drop-in slots. Author your own role prompts (one per persona) and
launcher scripts following the protocol below; the MCP server, `tally_positions`
and auto-ROUND_COMPLETE work regardless of how many personas you wire up.

## End-to-end flow

```
                 ┌──────────────┐  WSS  ┌───────────────────┐
   Human ──────▶ │  Browser     │ ◀───▶ │ Signaling server  │
                 │  (center)    │       └─────────▲─────────┘
                 └──────┬───────┘                 │
                        │ WebRTC DataChannel      │
                        ▼                         │
        ┌───────────────┴─────────────────┐       │
        │                                 │       │
   ┌────▼─────┐  ┌──────────┐  ┌──────────▼┐  ┌───▼──────┐
   │Moderator │  │ Security │  │Performance│  │   UX     │
   │  MCP     │  │   MCP    │  │    MCP    │  │   MCP    │
   └──────────┘  └──────────┘  └───────────┘  └──────────┘
        ↑              ↑              ↑              ↑
        └──── each persona = one MCP subprocess ─────┘
```

Each persona is a separate MCP subprocess (or separate `npx darkenchat` invocation). All connect to the same room key. Coordination happens entirely through `@`-mentions on the chat plane — no shared state.

## Discussion protocol

The binding rules (summarised below) — point every role prompt at this section:

1. **Greeting** — every persona sends one structured greeting on join.
2. **Parallel response** — the human's question `@`-mentions everyone; each expert wakes via `wait_for_mention` and replies **in parallel** — no serial routing required.
3. **Structured stance.** When a chat message takes a position, pass the
   `send_message` tool's optional `stance` object — do NOT write any header
   into `content`:
   ```jsonc
   stance: {
     position: "Use Redis for the cache layer",   // free text
     agreeWith:    ["<clientId>", "<clientId>"],   // clientIds, NOT @nicknames
     disagreeWith: ["<clientId>"],
   }
   ```
   `content` is just your prose. The server tallies `stance` structurally —
   there is no regex, no free-text header, and `agreeWith`/`disagreeWith`
   reference clientIds so nicknames / dedup suffixes can never break it.
4. **Tally + yield.** Before each reply, every AI calls `tally_positions`. If `myStance.shouldYield` is true (≥majority of peers list you in `disagreeWith`), you **must** change your `position` — either adopt the leading stance or synthesise.
5. **Auto round-completion.** When any normalised `position` reaches `consensusThreshold` supporters (default ⌈75% of AI members⌉), the MCP server itself emits a synthetic system message:
   ```
   ROUND_COMPLETE: panel converged on: <position>. The room stays open. …
   ```
   This wakes every panellist's `wait_for_mention`. **It is NOT a stop-signal** — panellists should acknowledge briefly (e.g. send `"Confirmed, no further comments"`) and keep polling. The room stays open for the next topic. There are no round numbers: to move on, simply discuss a new topic — once the panel converges on a *different* `position`, ROUND_COMPLETE re-fires for that one.
6. **Fail-safes** (no human babysitting required):
   - Convergence reminder (`DARKENCHAT_CONVERGE_TURNS`, default 12). There is **no hard send cap** — on every multiple of this threshold (turn 12, 24, 36, …) the AI's `send_message` result carries a `convergeNotice` nudging it to wrap up. It does not block sending.
   - The human chairperson (or any human in the room) can ask the panel to end explicitly — that's the only termination path beyond `leave_room` on terminal `roomStatus`.

The `ROUND_COMPLETE:` system message is round-end, **not** exit — panellists acknowledge and keep polling. The server emits it on its own; AIs never declare round-completion themselves. If you need a different round-end sentinel (e.g. a domain collision with `ROUND_COMPLETE`), change it in `room.ts:maybeEmitConsensus`.

## Things to tune

- **Bot cap.** Signaling `config.yaml` → `room.max_bot_members` (default 10 in this repo). Must be ≥ your panel size.
- **Convergence reminder.** `DARKENCHAT_CONVERGE_TURNS` env var (default 12). Not a cap — `send_message` returns a `convergeNotice` on every multiple of this value (turn 12, 24, 36, …). Raise it for verbose debates.
- **TURN / domain lock.** With no `DARKENCHAT_TURN_URLS` set, the MCP can only join rooms on `DARKENCHAT_DEFAULT_DOMAIN` (default `chat.darken.cc`). Set `DARKENCHAT_TURN_URLS` (plus optional `DARKENCHAT_TURN_USERNAME` / `DARKENCHAT_TURN_CREDENTIAL`) to join arbitrary signaling servers.
- **Consensus threshold.** `room.ts` → `consensusThreshold` is `ceil(N * 0.75)`. Lower it (e.g. 0.6) if your panel converges slowly, raise it if you want strict unanimity.
- **Tool timeout.** `wait_for_mention` defaults to 30 s, hard cap 300 s. Make sure your host's MCP tool-call timeout (`MCP_TIMEOUT`) is larger than the value you pass.
- **Model choice.** When you write your own headless driver, swap the model per persona — e.g. Opus for moderator, Sonnet for experts.

## Troubleshooting

| Symptom                                          | Likely cause / fix                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot_limit` from `join_room`                     | Raise `room.max_bot_members` in signaling config.                                                                                                       |
| AI responds to messages not addressed to it      | Role prompt isn't gating on `mentionedMe`. Re-emphasise rule 3 in the role file.                                                                        |
| Two experts respond simultaneously and overlap   | Tighten the moderator prompt to `@` one expert at a time, or stagger by sleep.                                                                          |
| Loop never terminates                            | Loops are SUPPOSED to keep running until the human asks them to stop. If a human explicitly says "leave the room" and the AI ignores it, tighten the role prompt to honour that. `ROUND_COMPLETE` is NOT a stop signal.                                                                                                |
| AI leaves the room as soon as `ROUND_COMPLETE:` arrives | Role prompt is treating `ROUND_COMPLETE:` as an exit signal. It's not — it just marks this round's end. Update the prompt to acknowledge + keep polling.                                                                                                  |
| `wait_for_mention` returns a `{ keepalive: true }` frame | Normal — that's a transport-level frame, not a business event. Call `wait_for_mention` again with the same args. (A `{ keepalive: true }` only ever means "nothing happened in this window yet".) |
| AI joins then stops after one `wait_for_mention` | Host treated a `{ keepalive: true }` frame as "done". Re-emphasise: loop on `wait_for_mention`; a keepalive frame means "keep waiting", not "leave".    |
| Replies arrive but no mention chip is rendered   | Pass `mentions: [{clientId, nickname}]` explicitly — auto-detection misses names with spaces or punctuation.                                            |

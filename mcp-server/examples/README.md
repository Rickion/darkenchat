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
and auto-CONSENSUS work regardless of how many personas you wire up.

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
3. **Structured replies.** Every chat message starts with a fixed header:
   ```
   ROUND: <n>
   POSITION: <one-line proposal>
   AGREE_WITH: @A, @B  (or none)
   DISAGREE_WITH: @C   (or none)
   REASON: <≤3 sentences>
   ```
4. **Tally + yield.** Before each reply, every AI calls `tally_positions`. If `myStance.shouldYield` is true (≥majority of peers list you in `DISAGREE_WITH`), you **must** change `POSITION` this round — either adopt the leading stance or synthesise.
5. **Auto-CONSENSUS.** When any normalised `POSITION` reaches `consensusThreshold` supporters (default ⌈75% of AI members⌉), the MCP server itself emits a synthetic system message:
   ```
   CONSENSUS: <position>
   ```
   This wakes every panellist's `wait_for_mention` — all of them call `leave_room`.
6. **Fail-safes** (no human babysitting required):
   - Convergence reminder (`DARKENCHAT_CONVERGE_TURNS`, default 12). There is **no hard send cap** — once an AI's self-counted `turnCount.count` reaches this threshold, every `send_message` result carries a `convergeNotice` nudging it to wrap up. It does not block sending.
   - Same-POSITION repeats are capped at 2 rounds by the role prompt.
   - Moderator / chairperson can manually emit `CONSENSUS:` as best-effort if no auto-convergence happens.

The `CONSENSUS:` token is the only stop-signal. Pick a different sentinel if your domain might collide with that word — change it in your role prompts *and* in `room.ts:maybeEmitConsensus`.

## Things to tune

- **Bot cap.** Signaling `config.yaml` → `room.max_bot_members` (default 10 in this repo). Must be ≥ your panel size.
- **Convergence reminder.** `DARKENCHAT_CONVERGE_TURNS` env var (default 12). Not a cap — just the turn count at which `send_message` starts returning a `convergeNotice`. Raise it for verbose debates.
- **TURN / domain lock.** With no `DARKENCHAT_TURN_URLS` set, the MCP can only join rooms on `DARKENCHAT_DEFAULT_DOMAIN` (default `chat.darken.cc`). Set `DARKENCHAT_TURN_URLS` (plus optional `DARKENCHAT_TURN_USERNAME` / `DARKENCHAT_TURN_CREDENTIAL`) to join arbitrary signaling servers.
- **Consensus threshold.** `room.ts` → `consensusThreshold` is `ceil(N * 0.75)`. Lower it (e.g. 0.6) if your panel converges slowly, raise it if you want strict unanimity.
- **Tool timeout.** `wait_for_mention` defaults to 30 s, hard cap 300 s. Make sure your host's MCP tool-call timeout (`MCP_TIMEOUT`) is larger than the value you pass.
- **Model choice.** When you write your own headless driver, swap the model per persona — e.g. Opus for moderator, Sonnet for experts.

## Troubleshooting

| Symptom                                        | Likely cause / fix                                                                 |
|------------------------------------------------|-------------------------------------------------------------------------------------|
| `bot_limit` from `join_room`                   | Raise `room.max_bot_members` in signaling config.                                   |
| AI responds to messages not addressed to it    | Role prompt isn't gating on `mentionedMe`. Re-emphasise rule 3 in the role file.    |
| Two experts respond simultaneously and overlap | Tighten the moderator prompt to `@` one expert at a time, or stagger by sleep.      |
| Loop never terminates                          | Check `CONSENSUS:` sentinel casing. Add a hard round cap.                           |
| `wait_for_mention` returns *immediately*, empty | `roomStatus` already terminal — call `leave_room` and exit. (Returning empty only *after the full timeout* is normal — just call it again, don't stop.) |
| AI joins then stops after one `wait_for_mention` | Host treated a timeout as "done". Re-emphasise: loop on `wait_for_mention`; `timedOut: true` means "keep waiting", not "leave". |
| Replies arrive but no mention chip is rendered | Pass `mentions: [{clientId, nickname}]` explicitly — auto-detection misses names with spaces or punctuation. |

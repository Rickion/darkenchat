# DarkenChat — Agent Guide

> This document is provided as an MCP Resource at `darkenchat://agent-guide`.
> Read it before joining any room.

## What is DarkenChat?

DarkenChat is a **private, ephemeral, peer-to-peer chat tool**.

- Messages travel **directly between devices** via WebRTC DataChannel.
- **Nothing is stored on servers** — messages vanish when the room closes.
- Rooms are identified by a short **4-character Key** (e.g. `A3F7`).
- You are an equal P2P member — no special privileges.

---

## Quick Start

```
1. join_room   → enter the room, receive member list
2. get_messages → fetch recent messages
3. send_message → reply when asked
4. leave_room  → always leave when done
```

### Example Flow

```jsonc
// 1. Join
join_room({ serverUrl: "wss://chat.darken.cc/ws", roomKey: "A3F7", nickname: "Claude" })
// → { success: true, clientId: "...", members: [...] }

// 2. Check messages
get_messages({ roomKey: "A3F7", limit: 10 })
// → { messages: [{ from, timestamp, content, isSystem }] }

// 3. Reply
send_message({ roomKey: "A3F7", content: "Hello! I'm Claude, an AI assistant." })

// 4. Leave when done
leave_room({ roomKey: "A3F7" })
```

---

## Message Format

- **Sending**: Plain text or Markdown. Newlines are preserved.
- **Receiving**: `content` is **plain text** (HTML stripped). Ready to read directly.
- `isSystem: true` means it's a room event (join/leave/etc.), not a user message.

---

## Behavior Rules

1. **Introduce yourself immediately** after joining — say you are an AI.
2. **Reply only when @mentioned or directly asked** — do not spam.
3. **Leave the room** with `leave_room` when your task is complete.
4. **Never try to become center node or chairperson** — bots are excluded automatically.
5. **Respect privacy** — this is a no-log environment; do not store or repeat private messages outside the room.

---

## Transparency

All room members can see you in the member list with a 🤖 icon.
You **cannot join invisibly**.

---

## Limits

- Max **3 AI members** per room (configurable by server admin).
- Messages over **2 MB** (e.g. large images) may be dropped by peers.
- Rooms are **ephemeral** — when all members leave, history is gone.

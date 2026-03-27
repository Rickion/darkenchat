import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { RoomClient, type IncomingMessage } from './room.js'

// One client per room (keyed by roomKey)
const clients = new Map<string, RoomClient>()
const messageStores = new Map<string, IncomingMessage[]>()

export function registerTools(server: McpServer) {

  // ── join_room ───────────────────────────────────────────
  server.tool(
    'join_room',
    'Join a DarkenChat room as an AI member',
    {
      serverUrl: z.string().describe('WebSocket signaling server URL, e.g. wss://example.com/ws'),
      roomKey:   z.string().describe('4-character room key (case-insensitive)'),
      nickname:  z.string().optional().describe('Display name for the AI (default: "AI")'),
    },
    async ({ serverUrl, roomKey, nickname = 'AI' }) => {
      const key = roomKey.toUpperCase()

      if (clients.has(key)) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Already joined this room' }) }] }
      }

      const client = new RoomClient()
      const store: IncomingMessage[] = []
      messageStores.set(key, store)

      client.onMessage(msg => {
        store.push(msg)
        if (store.length > 500) store.shift()
      })

      try {
        const session = await client.join(serverUrl, key, nickname)
        clients.set(key, client)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              clientId: session.clientId,
              members: session.members,
              nicknameSet: session.roomKey,
            }),
          }],
        }
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: err.message }) }] }
      }
    },
  )

  // ── send_message ────────────────────────────────────────
  server.tool(
    'send_message',
    'Send a message to a DarkenChat room',
    {
      roomKey: z.string(),
      content: z.string().describe('Message text (Markdown supported)'),
    },
    async ({ roomKey, content }) => {
      const client = clients.get(roomKey.toUpperCase())
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not in this room' }) }] }
      }
      const result = client.sendMessage(content)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result ? { success: true, ...result } : { success: false, error: 'Channel not open' }) }] }
    },
  )

  // ── get_messages ────────────────────────────────────────
  server.tool(
    'get_messages',
    'Retrieve recent messages from a DarkenChat room',
    {
      roomKey: z.string(),
      limit:   z.number().optional().describe('Max messages to return (default: 20)'),
      since:   z.number().optional().describe('Unix ms timestamp — return messages after this time'),
    },
    async ({ roomKey, limit = 20, since }) => {
      const client = clients.get(roomKey.toUpperCase())
      const store  = messageStores.get(roomKey.toUpperCase()) ?? []
      if (!client) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not in this room' }) }] }
      }
      const messages = client.getMessages(store, limit, since)
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, messages }) }] }
    },
  )

  // ── leave_room ──────────────────────────────────────────
  server.tool(
    'leave_room',
    'Leave a DarkenChat room',
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
      messageStores.delete(key)
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] }
    },
  )
}

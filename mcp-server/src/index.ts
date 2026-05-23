#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerTools } from './tools.js'
import { registerResources } from './resources.js'

// Belt-and-suspenders: any rejection that slips past a try/catch inside
// the WebSocket / RTC plumbing would otherwise (Node 15+) terminate the
// MCP process and silently drop all six tools from the host's tool list.
// Logging to stderr keeps the host's stdio MCP transport unaffected.
process.on('unhandledRejection', err => {
  console.error('[darkenchat] unhandledRejection:', err)
})
process.on('uncaughtException', err => {
  console.error('[darkenchat] uncaughtException:', err)
})

const server = new McpServer(
  {
    name: 'darkenchat',
    version: '0.1.0',
  },
  {
    // Shown to the model up-front. Leads with the headline capabilities so the
    // AI understands *why* it would use this server, then the survival rule.
    instructions: [
      'DarkenChat MCP — join private, ephemeral, peer-to-peer chat rooms as an AI member.',
      '',
      'Core highlights:',
      '• P2P chat — messages travel directly device-to-device over an encrypted WebRTC',
      '  DataChannel; nothing is stored on servers and the room vanishes when everyone leaves.',
      '• AI group chat — multiple AIs can join the same room and hold a structured',
      '  expert-panel discussion, @-mentioning each other and converging on a round-end,',
      '  with the first AI to enter acting as chairperson and writing the round summary.',
      '• Remote-command the AI on any of your machines — a human in the room can drive an AI',
      '  that is running anywhere (any host, any network) simply by chatting with it.',
      '',
      'Workflow: join_room → LOOP on wait_for_mention (a timeout is NOT a stop signal — call',
      'it again) → send_message when @mentioned. A ROUND_COMPLETE: system message means the',
      "round agreed; acknowledge briefly (e.g. 'Confirmed, no further comments') and keep",
      'polling — the room stays open for the next topic. leave_room ONLY on terminal',
      'roomStatus or an explicit human request.',
      '',
      'IMPORTANT: every successful join_room call returns an `instructions` field — a numbered',
      'list of binding rules. Read and obey it; it is authoritative. The darkenchat://agent-guide',
      'resource is optional deeper reading if your host exposes it.',
    ].join('\n'),
  },
)

registerTools(server)
registerResources(server)

const transport = new StdioServerTransport()
await server.connect(transport)

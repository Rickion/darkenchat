import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerTools } from './tools.js'
import { registerResources } from './resources.js'

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
      '  expert-panel discussion, @-mentioning each other and converging on a consensus,',
      '  with the first AI to enter acting as chairperson and writing the final summary.',
      '• Remote-command the AI on any of your machines — a human in the room can drive an AI',
      '  that is running anywhere (any host, any network) simply by chatting with it.',
      '',
      'Workflow: join_room → LOOP on wait_for_mention (a timeout is NOT a stop signal — call',
      'it again) → send_message when @mentioned → leave_room only when the task is done or',
      'roomStatus turns terminal. Read the darkenchat://agent-guide resource before joining.',
    ].join('\n'),
  },
)

registerTools(server)
registerResources(server)

const transport = new StdioServerTransport()
await server.connect(transport)

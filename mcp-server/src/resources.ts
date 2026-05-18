import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const agentMdPath = resolve(__dir, '../AGENT.md')

export function registerResources(server: McpServer) {
  server.resource(
    'agent-guide',
    'darkenchat://agent-guide',
    { description: 'DarkenChat usage guide for AI agents', mimeType: 'text/markdown' },
    async () => {
      const text = existsSync(agentMdPath) ? readFileSync(agentMdPath, 'utf8') : 'AGENT.md not found'
      return { contents: [{ uri: 'darkenchat://agent-guide', text, mimeType: 'text/markdown' }] }
    },
  )
}

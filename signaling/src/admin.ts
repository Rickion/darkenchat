import type { FastifyInstance } from 'fastify'
import { rooms, broadcast } from './rooms.js'
import { getLogs, getBanList, unbanIP, unbanKey } from './guard.js'

let adminToken = ''

export function setAdminToken(token: string) {
  adminToken = token
}

function authMiddleware(token: string | undefined): boolean {
  return !!token && token === adminToken
}

export async function registerAdminRoutes(app: FastifyInstance) {
  // Auth check
  app.post('/api/admin/auth', async (req, reply) => {
    const { token } = req.body as { token: string }
    if (token === adminToken) return reply.send({ ok: true })
    return reply.status(401).send({ error: 'Invalid token' })
  })

  const guard = async (req: any, reply: any) => {
    if (!authMiddleware(req.headers['x-admin-token'] as string)) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  }

  // Active rooms
  app.get('/api/admin/rooms', { preHandler: guard }, async (_req, reply) => {
    const list = [...rooms.values()].map(r => ({
      key: r.key,
      createdAt: r.createdAt,
      banned: r.banned,
    }))
    return reply.send({ rooms: list })
  })

  // Force dissolve room
  app.delete('/api/admin/rooms/:key', { preHandler: guard }, async (req, reply) => {
    const { key } = req.params as { key: string }
    const room = rooms.get(key.toUpperCase())
    if (!room) return reply.status(404).send({ error: 'Not found' })
    broadcast(room, { type: 'room_ended' })
    rooms.delete(key.toUpperCase())
    return reply.send({ ok: true })
  })

  // Logs
  app.get('/api/admin/logs', { preHandler: guard }, async (_req, reply) => {
    return reply.send({ logs: getLogs() })
  })

  // Ban list
  app.get('/api/admin/bans', { preHandler: guard }, async (_req, reply) => {
    return reply.send({ bans: getBanList() })
  })

  // Unban
  app.delete('/api/admin/bans/:type/:value', { preHandler: guard }, async (req, reply) => {
    const { type, value } = req.params as { type: string; value: string }
    if (type === 'ip') unbanIP(value)
    else if (type === 'key') unbanKey(value)
    return reply.send({ ok: true })
  })
}

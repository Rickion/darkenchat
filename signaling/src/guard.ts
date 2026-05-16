import type { SwitchLog } from './types.js'

// Rolling log buffer
const log: SwitchLog[] = []

// IP probe count within windows: ip → [timestamps]
const ipProbes = new Map<string, number[]>()

// Banned IPs and Keys: set of strings
export const bannedIPs  = new Set<string>()
export const bannedKeys = new Set<string>()

interface RateLimitConfig {
  windowSeconds: number
  maxKeyProbes:  number
  banDurationSeconds: number
  switchLogMaxEntries: number
}

let cfg: RateLimitConfig = {
  windowSeconds: 60, maxKeyProbes: 10, banDurationSeconds: 3600, switchLogMaxEntries: 1000,
}

export function configure(c: RateLimitConfig) {
  cfg = c
}

/**
 * Record a key probe and check rate limit.
 * Returns true if the request should be blocked.
 */
export function checkAndRecord(ip: string, toKey: string, action: SwitchLog['action']): boolean {
  const now = Date.now()
  const windowMs = cfg.windowSeconds * 1000

  // Check bans
  if (bannedIPs.has(ip) || bannedKeys.has(toKey)) {
    pushLog({ ip, timestamp: now, toKey, action, blocked: true })
    return true
  }

  // Sliding window
  const probes = (ipProbes.get(ip) ?? []).filter(t => now - t < windowMs)
  probes.push(now)
  ipProbes.set(ip, probes)

  if (probes.length > cfg.maxKeyProbes) {
    bannedIPs.add(ip)
    // Auto-unban after duration
    setTimeout(() => bannedIPs.delete(ip), cfg.banDurationSeconds * 1000)
    pushLog({ ip, timestamp: now, toKey, action, blocked: true })
    return true
  }

  pushLog({ ip, timestamp: now, toKey, action, blocked: false })
  return false
}

function pushLog(entry: SwitchLog) {
  if (log.length >= cfg.switchLogMaxEntries) log.shift()
  log.push(entry)
}

export function getLogs(): SwitchLog[]  { return [...log].reverse() }
export function getBanList() {
  return [
    ...[...bannedIPs].map(v => ({ type: 'ip', value: v })),
    ...[...bannedKeys].map(v => ({ type: 'key', value: v })),
  ]
}
export function unbanIP(ip: string)   { bannedIPs.delete(ip) }
export function unbanKey(key: string) { bannedKeys.delete(key) }

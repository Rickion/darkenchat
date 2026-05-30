import { ref, onUnmounted } from 'vue'
import type { C2S, S2C } from '@/types'

type MessageHandler = (msg: S2C) => void
// Fired after the control channel reopens following an *unexpected* drop (not
// the very first connect). The room layer uses this to re-`join` with its
// lastClientId so the server recognises a returning member and the data mesh
// rebuilds.
type ReconnectHandler = () => void

const proto = location.protocol === 'https:' ? 'wss' : 'ws'
const WS_URL = import.meta.env.VITE_WS_URL ?? `${proto}://${location.host}/ws`
const HEARTBEAT_MS = 3000
// How long the socket may go without a server `ack` before we treat it as
// dead. A single 3s blip (mobile tab throttling, a GC pause, proxy buffering)
// used to trip this instantly and pop "Connection lost. Please refresh."; ~4
// missed beats is the same tolerance the MCP client (10s) and the server-side
// sweep (10s) use, so transient jitter no longer kills an otherwise-fine link.
const HEARTBEAT_TIMEOUT_MS = 12_000

// Backoff schedule for reconnecting the *signaling control channel* (NOT a
// data-transport tier — chat data still prefers P2P→TURN→relay). We retry
// indefinitely so a server blip or restart self-heals without the user having
// to refresh. Delay doubles 1s→2s→4s→8s and then holds, plus jitter to avoid a
// thundering herd when the server comes back and every client reconnects at
// once. `disconnected` flips on once we've been retrying past the escalation
// threshold so the UI can switch from "reconnecting" to "disconnected".
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 8000
const RECONNECT_JITTER_MS = 300
// After this many consecutive failed attempts the UI escalates from
// "reconnecting" to "disconnected" (members hidden). We keep retrying.
const DISCONNECT_ESCALATE_AFTER = 4

// Visible, timestamped diagnostics (console.debug is hidden at default log
// levels). Prefix matches the MCP server's `dlog` so browser + bot logs read
// the same way when correlating a disconnect.
function slog(...args: unknown[]): void {
  console.warn(`[darkenchat ${new Date().toISOString()}] signaling:`, ...args)
}

export function useSignaling(onMessage: MessageHandler, onReconnected?: ReconnectHandler) {
  const ws = ref<WebSocket | null>(null)
  const connected = ref(false)
  // Transient: the control channel dropped and we're actively retrying.
  const reconnecting = ref(false)
  // Escalated: we've been retrying long enough that member state is no longer
  // trustworthy. Still retrying underneath.
  const disconnected = ref(false)
  let hbTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempts = 0
  let lastAckTime = 0
  // Set by close() so an intentional teardown (user leaving) doesn't trigger
  // the reconnect loop.
  let manualClose = false
  // Resolve/reject for the initial connect() promise; no-ops once settled.
  let settleConnect: { resolve: () => void; reject: (e: Error) => void } | null = null

  function clearHeartbeat() {
    if (hbTimer) clearInterval(hbTimer)
    hbTimer = null
  }

  function clearReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  function startHeartbeat(socket: WebSocket) {
    clearHeartbeat()
    // Single self-checking heartbeat loop: before each beat, verify the server
    // has ack'd within the tolerance window. Closing the socket here lands in
    // `onclose`, which drives the reconnect loop.
    hbTimer = setInterval(() => {
      const ackAge = Date.now() - lastAckTime
      if (ackAge > HEARTBEAT_TIMEOUT_MS) {
        slog(`heartbeat timeout — no ack for ${ackAge}ms (limit ${HEARTBEAT_TIMEOUT_MS}ms); closing socket`)
        clearHeartbeat()
        socket.close()
        return
      }
      send({ type: 'heartbeat' })
    }, HEARTBEAT_MS)
  }

  function scheduleReconnect() {
    if (manualClose) return
    reconnecting.value = true
    if (reconnectAttempts >= DISCONNECT_ESCALATE_AFTER) disconnected.value = true
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts)
    const delay = backoff + Math.floor(Math.random() * RECONNECT_JITTER_MS)
    reconnectAttempts++
    slog(`scheduling reconnect attempt ${reconnectAttempts} in ${delay}ms`)
    clearReconnect()
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      openSocket()
    }, delay)
  }

  function openSocket(): WebSocket {
    const wasReconnecting = reconnecting.value
    const socket = new WebSocket(WS_URL)
    ws.value = socket

    socket.onopen = () => {
      connected.value = true
      reconnecting.value = false
      disconnected.value = false
      reconnectAttempts = 0
      lastAckTime = Date.now()
      startHeartbeat(socket)
      settleConnect?.resolve()
      settleConnect = null
      // Only fire the rejoin path on a *reconnect*, not the first connect
      // (the room layer sends the initial join itself).
      if (wasReconnecting) {
        slog('control channel reopened — rejoining')
        onReconnected?.()
      }
    }

    socket.onmessage = e => {
      try {
        const msg: S2C = JSON.parse(e.data)
        if (msg.type === 'ack') {
          lastAckTime = Date.now()
        }
        onMessage(msg)
      } catch {
        /* malformed frame */
      }
    }

    socket.onerror = () => {
      // Surface only the *initial* connect failure to the caller; reconnect
      // attempts swallow errors and let onclose drive the retry loop.
      settleConnect?.reject(new Error('WebSocket error'))
      settleConnect = null
    }

    socket.onclose = ev => {
      slog(`WS closed — code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean}`)
      connected.value = false
      clearHeartbeat()
      if (!manualClose) scheduleReconnect()
    }

    return socket
  }

  function connect(): Promise<void> {
    manualClose = false
    reconnectAttempts = 0
    return new Promise((resolve, reject) => {
      settleConnect = {
        resolve: () => resolve(),
        reject: e => reject(e),
      }
      openSocket()
    })
  }

  function send(msg: C2S) {
    if (ws.value?.readyState === WebSocket.OPEN) {
      ws.value.send(JSON.stringify(msg))
    }
  }

  function close() {
    manualClose = true
    clearReconnect()
    clearHeartbeat()
    reconnecting.value = false
    disconnected.value = false
    settleConnect = null
    ws.value?.close()
    ws.value = null
  }

  onUnmounted(close)

  return { connected, reconnecting, disconnected, connect, send, close }
}

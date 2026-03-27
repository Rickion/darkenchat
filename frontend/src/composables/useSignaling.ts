import { ref, onUnmounted } from 'vue'
import type { C2S, S2C } from '@/types'

type MessageHandler = (msg: S2C) => void

const proto = location.protocol === 'https:' ? 'wss' : 'ws'
const WS_URL = import.meta.env.VITE_WS_URL ?? `${proto}://${location.host}/ws`
const HEARTBEAT_MS = 3000

export function useSignaling(onMessage: MessageHandler) {
  const ws = ref<WebSocket | null>(null)
  const connected = ref(false)
  let hbTimer: ReturnType<typeof setInterval> | null = null

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(WS_URL)
      ws.value = socket

      socket.onopen = () => {
        connected.value = true
        hbTimer = setInterval(() => send({ type: 'heartbeat' }), HEARTBEAT_MS)
        resolve()
      }

      socket.onmessage = (e) => {
        try {
          const msg: S2C = JSON.parse(e.data)
          onMessage(msg)
        } catch { /* malformed frame */ }
      }

      socket.onerror = () => reject(new Error('WebSocket error'))

      socket.onclose = () => {
        connected.value = false
        clearInterval(hbTimer!)
        hbTimer = null
      }
    })
  }

  function send(msg: C2S) {
    if (ws.value?.readyState === WebSocket.OPEN) {
      ws.value.send(JSON.stringify(msg))
    }
  }

  function close() {
    clearInterval(hbTimer!)
    hbTimer = null
    ws.value?.close()
    ws.value = null
  }

  onUnmounted(close)

  return { connected, connect, send, close }
}

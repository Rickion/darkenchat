import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import type { Message } from '@/types'

const SESSION_KEY_PREFIX = 'dc_messages_'

function loadFromSession(roomKey: string): Message[] {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY_PREFIX + roomKey)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveToSession(roomKey: string, messages: Message[]) {
  try {
    sessionStorage.setItem(SESSION_KEY_PREFIX + roomKey, JSON.stringify(messages))
  } catch {
    /* quota exceeded – ignore */
  }
}

export const useMessagesStore = defineStore('messages', () => {
  const messages = ref<Message[]>([])
  const currentRoomKey = ref('')

  // Local-only delivery metadata — NOT serialised/transmitted.
  // failedIds: own messages that couldn't be delivered (show resend button).
  // catchupIds: messages received as catch-up history (blink animation on arrival).
  const failedIds = reactive(new Set<string>())
  const catchupIds = reactive(new Set<string>())

  function load(roomKey: string) {
    currentRoomKey.value = roomKey
    messages.value = loadFromSession(roomKey)
  }

  function add(msg: Message) {
    // heartbeat / ack are not stored
    if (msg.type === 'heartbeat' || msg.type === 'ack') return
    // Deduplicate by id (catch-up bundles may include messages already in store)
    if (messages.value.some(m => m.id === msg.id)) return
    messages.value.push(msg)
    if (currentRoomKey.value) {
      saveToSession(currentRoomKey.value, messages.value)
    }
  }

  // Mutate a message in place. Used for voice-session bubbles whose participant
  // list grows as new joiners arrive and that flips to "ended" when the call wraps.
  function update(id: string, patcher: (m: Message) => void) {
    const msg = messages.value.find(m => m.id === id)
    if (!msg) return
    patcher(msg)
    if (currentRoomKey.value) {
      saveToSession(currentRoomKey.value, messages.value)
    }
  }

  function markFailed(id: string) {
    failedIds.add(id)
  }

  function clearFailed(id: string) {
    failedIds.delete(id)
  }

  /** Mark a message as received via catch-up; the flash animation is CSS-driven (3 s). */
  function markCatchup(id: string) {
    catchupIds.add(id)
  }

  function clear(roomKey?: string) {
    messages.value = []
    failedIds.clear()
    catchupIds.clear()
    const k = roomKey ?? currentRoomKey.value
    if (k) sessionStorage.removeItem(SESSION_KEY_PREFIX + k)
    currentRoomKey.value = ''
  }

  return {
    messages,
    currentRoomKey,
    failedIds,
    catchupIds,
    load,
    add,
    update,
    markFailed,
    clearFailed,
    markCatchup,
    clear,
  }
})

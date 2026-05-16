import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'

export const useVoiceStore = defineStore('voice', () => {
  // Whether *this* user is currently in the voice channel.
  const inVoice = ref(false)
  const muted   = ref(false)
  // clientIds of every member currently in voice (includes self when inVoice).
  // Used both for UI rendering and to enforce the participant cap.
  const voiceMembers   = reactive(new Set<string>())
  // peerId -> their incoming MediaStream. Keys are *other* members; not self.
  const remoteStreams  = reactive(new Map<string, MediaStream>())

  // Active voice-session bookkeeping. A "session" begins when someone first
  // initiates voice; it ends when voiceMembers drains back to 0. The session id
  // ties the in-progress message bubble to the running call (so newcomers'
  // "join" button knows which call to jump into) and the eventual summary
  // bubble to its session.
  const activeSessionId        = ref<string | null>(null)
  const activeSessionInitiator = ref<string | null>(null)
  const activeSessionStartedAt = ref<number | null>(null)

  function reset() {
    inVoice.value = false
    muted.value = false
    voiceMembers.clear()
    remoteStreams.clear()
    activeSessionId.value = null
    activeSessionInitiator.value = null
    activeSessionStartedAt.value = null
  }

  return {
    inVoice, muted, voiceMembers, remoteStreams,
    activeSessionId, activeSessionInitiator, activeSessionStartedAt,
    reset,
  }
})

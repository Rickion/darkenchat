import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

const LS_KEY = 'dc_turn_custom'

interface ServerTurnConfig {
  urls: string[]
  username: string
  credential: string
}

export const useTurnStore = defineStore('turn', () => {
  // ── Server-provided config (fetched from /api/turn-credentials on join) ──
  // null means server has no TURN configured.
  const serverConfig = ref<ServerTurnConfig | null>(null)

  // Convenience: first URL from server (shown as placeholder / default label)
  const serverUrl = computed(() => serverConfig.value?.urls[0] ?? '')

  // ── User's custom override (persisted to localStorage) ──────────────────
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null') ?? {}

  // Pre-fill custom URL from localStorage on startup
  const customUrl        = ref<string>(saved.url        ?? '')
  const customUsername   = ref<string>(saved.username   ?? '')
  const customCredential = ref<string>(saved.credential ?? '')
  // true = use custom instead of server default
  const useCustom        = ref<boolean>(saved.useCustom ?? false)

  watch([customUrl, customUsername, customCredential, useCustom], () => {
    localStorage.setItem(LS_KEY, JSON.stringify({
      url:        customUrl.value,
      username:   customUsername.value,
      credential: customCredential.value,
      useCustom:  useCustom.value,
    }))
  })

  // ── Effective config (what useWebRTC actually uses) ──────────────────────
  // Returns an RTCIceServer-compatible object, or null if no TURN available.
  const effective = computed<{ urls: string[]; username?: string; credential?: string } | null>(() => {
    if (useCustom.value && customUrl.value.trim()) {
      return {
        urls:       customUrl.value.split(',').map(s => s.trim()).filter(Boolean),
        username:   customUsername.value || undefined,
        credential: customCredential.value || undefined,
      }
    }
    // Use server config (may be null if server has no TURN)
    return serverConfig.value
      ? { urls: serverConfig.value.urls, username: serverConfig.value.username, credential: serverConfig.value.credential }
      : null
  })

  /** Called by useRoom after fetching /api/turn-credentials */
  function setServerConfig(config: ServerTurnConfig) {
    serverConfig.value = config
    // Pre-fill customUrl with server URL on first visit (so user can see/edit the default)
    if (!customUrl.value && config.urls.length > 0) {
      customUrl.value = config.urls[0]
    }
  }

  function reset() {
    serverConfig.value = null
  }

  return {
    serverConfig, serverUrl,
    customUrl, customUsername, customCredential, useCustom,
    effective,
    setServerConfig, reset,
  }
})

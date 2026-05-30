import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

// p2p/turn/relay are data-plane transport tiers; connecting/failed describe
// the data-plane handshake. reconnecting/disconnected describe the *signaling
// control channel* being re-established (transient) or down long enough that
// member state is untrustworthy — these override the transport icon in the UI.
export type ConnState = 'connecting' | 'p2p' | 'turn' | 'relay' | 'failed' | 'reconnecting' | 'disconnected'

const ICONS: Record<ConnState, string> = {
  connecting: 'mdi-dots-horizontal-circle-outline',
  p2p: 'mdi-lan-connect',
  turn: 'mdi-shield-lock-outline',
  relay: 'mdi-server-network',
  failed: 'mdi-alert-circle-outline',
  reconnecting: 'mdi-lan-pending',
  disconnected: 'mdi-lan-disconnect',
}

const COLORS: Record<ConnState, string> = {
  connecting: 'grey',
  p2p: '#4CAF50',
  turn: '#FFC107',
  relay: '#FF7043',
  failed: '#F44336',
  reconnecting: '#FFC107',
  disconnected: '#F44336',
}

export const useConnectionStore = defineStore('connection', () => {
  const state = ref<ConnState>('connecting')

  // Technical mode: toggles detail level in all connection-related UI text.
  // Persisted to localStorage.
  const techMode = ref(localStorage.getItem('dc_tech_mode') === '1')
  watch(techMode, v => localStorage.setItem('dc_tech_mode', v ? '1' : '0'))

  const icon = computed<string>(() => ICONS[state.value])
  const color = computed<string>(() => COLORS[state.value])

  function iconFor(s: ConnState): string {
    return ICONS[s]
  }
  function colorFor(s: ConnState): string {
    return COLORS[s]
  }

  function reset() {
    state.value = 'connecting'
  }

  return { state, techMode, icon, color, iconFor, colorFor, reset }
})

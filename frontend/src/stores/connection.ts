import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

export type ConnState = 'connecting' | 'p2p' | 'turn' | 'relay' | 'failed'

export const useConnectionStore = defineStore('connection', () => {
  const state = ref<ConnState>('connecting')

  // Technical mode: toggles detail level in all connection-related UI text.
  // Persisted to localStorage.
  const techMode = ref(localStorage.getItem('dc_tech_mode') === '1')
  watch(techMode, (v) => localStorage.setItem('dc_tech_mode', v ? '1' : '0'))

  const icon = computed<string>(() => ({
    connecting: 'mdi-dots-horizontal-circle-outline',
    p2p:        'mdi-lan-connect',
    turn:       'mdi-shield-lock-outline',
    relay:      'mdi-server-network',
    failed:     'mdi-alert-circle-outline',
  }[state.value]))

  const color = computed<string>(() => ({
    connecting: 'grey',
    p2p:        '#4CAF50',
    turn:       '#FFC107',
    relay:      '#FF7043',
    failed:     '#F44336',
  }[state.value]))

  function reset() {
    state.value = 'connecting'
  }

  return { state, techMode, icon, color, reset }
})

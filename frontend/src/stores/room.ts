import { defineStore } from 'pinia'
import { ref, watch, computed } from 'vue'
import type { MemberInfo } from '@/types'

const NICK_SESSION_KEY = 'dc_pending_nick'

export const useRoomStore = defineStore('room', () => {
  // Persisted to sessionStorage so it survives page refresh
  const pendingNickname = ref(sessionStorage.getItem(NICK_SESSION_KEY) ?? '')
  watch(pendingNickname, (v) => {
    if (v) sessionStorage.setItem(NICK_SESSION_KEY, v)
    else sessionStorage.removeItem(NICK_SESSION_KEY)
  })

  const key = ref('')
  const clientId = ref('')
  const nickname = ref('')
  const centerId = ref('')
  const chairId = ref('')
  const nicknameSet = ref('nato')
  const members = ref<MemberInfo[]>([])
  const connected = ref(false)
  const reconnecting = ref(false)

  const isChair = computed(() => clientId.value === chairId.value)
  const isCenter = computed(() => clientId.value === centerId.value)
  const chairMember = computed(() => members.value.find((m: MemberInfo) => m.clientId === chairId.value))
  const usedNicknames = computed(() => members.value.map((m: MemberInfo) => m.nickname))

  function setRoom(payload: {
    key: string
    clientId: string
    nickname: string
    centerId: string
    chairId: string
    nicknameSet: string
    members: MemberInfo[]
  }) {
    key.value = payload.key
    clientId.value = payload.clientId
    nickname.value = payload.nickname
    centerId.value = payload.centerId
    chairId.value = payload.chairId
    nicknameSet.value = payload.nicknameSet
    members.value = payload.members
    connected.value = true
    reconnecting.value = false
  }

  function addMember(member: MemberInfo) {
    if (!members.value.find((m: MemberInfo) => m.clientId === member.clientId)) {
      members.value.push(member)
    }
  }

  function removeMember(clientId: string) {
    members.value = members.value.filter((m: MemberInfo) => m.clientId !== clientId)
  }

  function updateCenter(newCenterId: string) {
    centerId.value = newCenterId
  }

  function updateChair(newChairId: string) {
    chairId.value = newChairId
  }

  function updateMemberConn(clientId: string, connType: 'p2p' | 'turn' | 'relay') {
    const member = members.value.find(m => m.clientId === clientId)
    if (member) member.connType = connType
  }

  function reset() {
    key.value = ''
    clientId.value = ''
    nickname.value = ''
    centerId.value = ''
    chairId.value = ''
    nicknameSet.value = 'nato'
    members.value = []
    connected.value = false
    reconnecting.value = false
  }

  return {
    pendingNickname,
    key, clientId, nickname, centerId, chairId,
    nicknameSet, members, connected, reconnecting,
    isChair, isCenter, chairMember, usedNicknames,
    setRoom, addMember, removeMember, updateCenter, updateChair, updateMemberConn, reset,
  }
})

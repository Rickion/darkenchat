<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { MemberInfo } from '@/types'

const { t } = useI18n()

defineProps<{
  members: MemberInfo[]
  chairId: string
  clientId: string
  isChair: boolean
}>()

const emit = defineEmits<{
  kick: [member: MemberInfo]
}>()
</script>

<template>
  <div class="member-list">
    <div
      v-for="m in members"
      :key="m.clientId"
      class="member-item"
    >
      <!-- Chair crown -->
      <v-icon v-if="m.clientId === chairId" size="15" color="warning" title="Chairperson" class="badge-icon">mdi-crown</v-icon>
      <!-- Bot badge -->
      <v-icon v-else-if="m.isBot" size="15" color="secondary" class="badge-icon">mdi-robot</v-icon>
      <!-- Online dot -->
      <span v-else class="dot online" />

      <span class="member-name" :class="{ 'text-primary': m.clientId === clientId }">
        {{ m.nickname }}
        <span v-if="m.clientId === clientId" style="font-size:0.7em;color:var(--dc-gray)"> (you)</span>
      </span>

      <!-- Connection type icon -->
      <v-icon
        v-if="m.connType"
        :icon="m.connType === 'p2p' ? 'mdi-lan-connect' : m.connType === 'turn' ? 'mdi-shield-lock-outline' : 'mdi-server-network'"
        :color="m.connType === 'p2p' ? '#4CAF50' : m.connType === 'turn' ? '#FFC107' : '#FF7043'"
        size="14"
        class="conn-icon"
      />

      <!-- Chair kick button -->
      <v-btn
        v-if="isChair && m.clientId !== clientId && !m.isBot"
        icon="mdi-account-remove"
        size="x-small"
        variant="text"
        color="error"
        class="kick-btn"
        :title="t('chair.kick_confirm', { name: m.nickname })"
        @click.stop="emit('kick', m)"
      />
    </div>
  </div>
</template>

<style scoped>
.member-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 4px;
  overflow-y: auto;
  flex: 1;
}
.member-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  transition: background 0.15s;
  min-height: 36px;
}
.member-item:hover { background: #2e2e2e; }
.badge-icon { flex-shrink: 0; }
.dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.online { background: var(--dc-teal); }
.member-name {
  flex: 1;
  font-size: 0.88rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conn-icon { flex-shrink: 0; opacity: 0.8; }
.kick-btn { opacity: 0; transition: opacity 0.15s; margin-left: auto; }
.member-item:hover .kick-btn { opacity: 1; }
</style>

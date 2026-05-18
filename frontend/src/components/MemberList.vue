<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MemberInfo } from '@/types'
import { useVoiceStore } from '@/stores/voice'
import { useMessagesStore } from '@/stores/messages'
import { useRoomStore } from '@/stores/room'

const { t } = useI18n()
const voiceStore = useVoiceStore()
const msgStore = useMessagesStore()
const roomStore = useRoomStore()

const props = defineProps<{
  members: MemberInfo[]
  chairId: string
  clientId: string
  isChair: boolean
}>()

const emit = defineEmits<{
  kick: [member: MemberInfo]
  'open-room-config': []
}>()

// Split the member list so humans stack above the divider and AIs below.
// Within each group we preserve the server-provided order (join order).
const humans = computed(() => props.members.filter(m => !m.isBot))
const bots = computed(() => props.members.filter(m => m.isBot))

// Live per-bot chat message count, derived from the local message store.
// `msgStore.add` dedupes by id, so this is stable across catch-up bundles.
function botSentCount(botId: string): number {
  return msgStore.messages.filter(m => m.fromId === botId && m.type === 'chat').length
}

function isOverLimit(botId: string): boolean {
  return roomStore.aiTurnLimit > 0 && botSentCount(botId) >= roomStore.aiTurnLimit
}

function botTooltip(botId: string): string {
  return t('room_config.turn_count_tooltip', {
    sent: botSentCount(botId),
    limit: roomStore.aiTurnLimit > 0 ? String(roomStore.aiTurnLimit) : '∞',
  })
}
</script>

<template>
  <div class="member-list">
    <!-- Humans (top) -->
    <div v-for="m in humans" :key="m.clientId" class="member-item">
      <!-- Chair crown -->
      <v-icon v-if="m.clientId === chairId" size="15" color="warning" :title="t('room.chairperson')" class="badge-icon">
        mdi-crown
      </v-icon>
      <!-- Online dot -->
      <span v-else class="dot online" />

      <span class="member-name" :class="{ 'text-primary': m.clientId === clientId }">
        {{ m.nickname }}
        <span v-if="m.clientId === clientId" class="you-suffix">({{ t('room.you_suffix') }})</span>
      </span>

      <!-- Voice channel indicator -->
      <v-icon
        v-if="voiceStore.voiceMembers.has(m.clientId)"
        size="13"
        color="success"
        class="voice-icon"
        :title="t('room.in_voice_channel')">
        mdi-microphone
      </v-icon>

      <!-- Connection type icon -->
      <v-tooltip v-if="m.connType" location="top">
        <template #activator="{ props: tp }">
          <v-icon
            v-bind="tp"
            :icon="
              m.connType === 'p2p'
                ? 'mdi-lan-connect'
                : m.connType === 'turn'
                  ? 'mdi-shield-lock-outline'
                  : 'mdi-server-network'
            "
            :color="m.connType === 'p2p' ? '#4CAF50' : m.connType === 'turn' ? '#FFC107' : '#FF7043'"
            size="14"
            class="conn-icon" />
        </template>
        {{ t('conn.' + m.connType) }}
      </v-tooltip>

      <!-- Chair kick button -->
      <v-btn
        v-if="isChair && m.clientId !== clientId && !m.isBot"
        icon="mdi-account-remove"
        size="x-small"
        variant="text"
        color="error"
        class="kick-btn"
        :title="t('chair.kick_member')"
        @click.stop="emit('kick', m)" />
    </div>

    <!-- Divider (only shown when at least one AI is in the room) -->
    <div v-if="bots.length > 0" class="member-divider">
      <span class="divider-line" />
      <span class="divider-label">{{ t('room_config.divider_ai') }}</span>
      <v-tooltip :text="t('room_config.gear_tooltip')" location="top">
        <template #activator="{ props: tp }">
          <v-btn
            v-bind="tp"
            icon="mdi-cog-outline"
            size="x-small"
            variant="text"
            class="divider-gear"
            @click.stop="emit('open-room-config')" />
        </template>
      </v-tooltip>
      <span class="divider-line" />
    </div>

    <!-- AIs (bottom) -->
    <div v-for="m in bots" :key="m.clientId" class="member-item">
      <v-icon
        size="15"
        :color="m.clientId === chairId ? 'warning' : 'secondary'"
        class="badge-icon"
        :title="m.clientId === chairId ? t('room.chairperson') : ''">
        {{ m.clientId === chairId ? 'mdi-crown' : 'mdi-robot' }}
      </v-icon>

      <span class="member-name">{{ m.nickname }}</span>

      <!-- (sent/limit) counter — clickable, opens the room AI config dialog.
           "∞" icon when limit is 0 (unlimited). Red when count ≥ limit. -->
      <v-tooltip :text="botTooltip(m.clientId)" location="top">
        <template #activator="{ props: tp }">
          <span
            v-bind="tp"
            class="ai-count"
            :class="{ over: isOverLimit(m.clientId) }"
            @click.stop="emit('open-room-config')">
            {{ `(${botSentCount(m.clientId)}/${roomStore.aiTurnLimit > 0 ? roomStore.aiTurnLimit : '∞'})` }}
          </span>
        </template>
      </v-tooltip>

      <!-- Connection type icon -->
      <v-tooltip v-if="m.connType" location="top">
        <template #activator="{ props: tp }">
          <v-icon
            v-bind="tp"
            :icon="
              m.connType === 'p2p'
                ? 'mdi-lan-connect'
                : m.connType === 'turn'
                  ? 'mdi-shield-lock-outline'
                  : 'mdi-server-network'
            "
            :color="m.connType === 'p2p' ? '#4CAF50' : m.connType === 'turn' ? '#FFC107' : '#FF7043'"
            size="14"
            class="conn-icon" />
        </template>
        {{ t('conn.' + m.connType) }}
      </v-tooltip>
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
.member-item:hover {
  background: #2e2e2e;
}
.badge-icon {
  flex-shrink: 0;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.online {
  background: var(--dc-teal);
}
.member-name {
  flex: 1;
  font-size: 0.88rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.you-suffix {
  font-size: 0.7em;
  color: var(--dc-gray);
  margin-left: 4px;
}
.conn-icon {
  flex-shrink: 0;
  opacity: 0.8;
}
.voice-icon {
  flex-shrink: 0;
}
.kick-btn {
  opacity: 0;
  transition: opacity 0.15s;
  margin-left: auto;
}
.member-item:hover .kick-btn {
  opacity: 1;
}

/* Humans-vs-AI divider */
.member-divider {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 6px 4px;
  margin-top: 4px;
}
.divider-line {
  flex: 1;
  height: 1px;
  background: #3a3a3a;
}
.divider-label {
  flex-shrink: 0;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--dc-gray);
}
.divider-gear {
  flex-shrink: 0;
}

/* Per-bot (sent/limit) counter pill */
.ai-count {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 1px;
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
  color: var(--dc-gray);
  cursor: pointer;
  user-select: none;
  padding: 1px 4px;
  border-radius: 4px;
  transition:
    background 0.15s,
    color 0.15s;
}
.ai-count:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--dc-text);
}
.ai-count.over {
  color: #ef5350;
  font-weight: 600;
}
</style>

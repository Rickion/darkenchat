<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { Message } from '@/types'

const { t } = useI18n()

const props = defineProps<{
  message: Message
  clientId: string
  selectMode?: boolean
  selected?: boolean
  failed?: boolean       // own message — delivery failed
  catchup?: boolean      // received as catch-up history (blink 3 s)
  reconnecting?: boolean // network is down — disable resend
}>()

const emit = defineEmits<{
  toggle: [id: string]
  resend: [id: string]
}>()

const expanded = ref(false)

const time    = computed(() => dayjs(props.message.timestamp).format('HH:mm'))
const isMine  = computed(() => props.message.fromId === props.clientId)

const systemText = computed(() => {
  if (!props.message.isSystem) return ''
  try {
    const { key, params } = JSON.parse(props.message.content)
    return t(key, params)
  } catch {
    return props.message.content
  }
})
</script>

<template>
  <!-- System message -->
  <div v-if="message.isSystem" class="sys-msg">
    {{ systemText }} · {{ time }}
  </div>

  <!-- Forward card -->
  <div v-else-if="message.type === 'forward'" class="forward-card" :class="{ 'catchup-flash': catchup }">
    <div class="forward-header" @click="expanded = !expanded">
      <span>📎 {{ t('forward.title', { name: message.from, count: message.forwardOf?.messages.length ?? 0 }) }}</span>
      <v-icon size="small">{{ expanded ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
    </div>
    <Transition name="accordion">
      <div v-if="expanded" class="forward-body">
        <div v-if="message.forwardOf?.note" class="forward-note">{{ message.forwardOf.note }}</div>
        <div
          v-for="m in message.forwardOf?.messages"
          :key="m.id"
          class="forward-msg"
        >
          <span class="fwd-from">{{ m.isSystem ? '[System]' : m.from }}</span>
          <span class="fwd-time">{{ dayjs(m.timestamp).format('HH:mm') }}</span>
          <span class="fwd-content" v-html="m.content" />
        </div>
      </div>
    </Transition>
  </div>

  <!-- Chat message -->
  <div
    v-else
    class="chat-msg"
    :class="{
      mine: isMine,
      'select-mode': selectMode,
      'catchup-flash': catchup,
    }"
    @click="selectMode && emit('toggle', message.id)"
  >
    <v-checkbox
      v-if="selectMode"
      :model-value="selected"
      hide-details
      density="compact"
      class="select-cb"
      @click.stop
      @update:model-value="emit('toggle', message.id)"
    />
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-from" :class="{ 'text-primary': isMine }">
          {{ message.from }}
          <span v-if="message.isBot">🤖</span>
        </span>
        <span class="msg-time">{{ time }}</span>

        <!-- Failed delivery indicator (own messages only) -->
        <template v-if="failed && isMine">
          <v-tooltip
            :text="reconnecting ? t('msg.resend_disabled') : t('msg.resend')"
            location="top"
          >
            <template #activator="{ props: tp }">
              <v-btn
                icon="mdi-alert-circle-outline"
                size="x-small"
                variant="text"
                :color="reconnecting ? 'grey' : 'error'"
                :style="{ opacity: reconnecting ? 0.5 : 1 }"
                v-bind="tp"
                @click.stop="!reconnecting && emit('resend', message.id)"
              />
            </template>
          </v-tooltip>
        </template>
      </div>
      <div class="msg-content" v-html="message.content" />
    </div>
  </div>
</template>

<style scoped>
.chat-msg {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 10px;
  transition: background 0.1s;
  cursor: default;
}
.chat-msg.select-mode { cursor: pointer; }
.chat-msg.select-mode:hover { background: #2a2a2a; }
.msg-body { flex: 1; min-width: 0; }
.msg-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
}
.msg-from { font-size: 0.83rem; font-weight: 600; }
.msg-time { font-size: 0.72rem; color: var(--dc-gray); }
.msg-content {
  font-size: 0.92rem;
  line-height: 1.55;
  word-break: break-word;
}
.msg-content :deep(strong) { color: var(--dc-text); }
.msg-content :deep(a) { color: var(--dc-blue); }
.msg-content :deep(img) { max-width: min(400px, 100%); border-radius: 8px; }

/* ── Catch-up flash: blinks gold for 3 s on arrival ── */
@keyframes catchup-flash {
  0%         { background: transparent; }
  10%, 40%   { background: rgba(201, 168, 76, 0.22); }
  70%, 100%  { background: transparent; }
}
.catchup-flash {
  animation: catchup-flash 3s ease-out 1;
}

/* Forward card */
.forward-card {
  background: var(--dc-panel);
  border: 1px solid #333;
  border-radius: 12px;
  margin: 4px 0;
  overflow: hidden;
}
.forward-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  cursor: pointer;
  font-size: 0.87rem;
  color: var(--dc-blue);
  user-select: none;
}
.forward-header:hover { background: #2a2a2a; }
.forward-body { padding: 0 14px 12px; }
.forward-note {
  font-size: 0.8rem;
  color: var(--dc-gray);
  margin-bottom: 8px;
  padding: 6px 0;
  border-bottom: 1px solid #333;
}
.forward-msg {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 3px 0;
  font-size: 0.83rem;
}
.fwd-from { font-weight: 600; flex-shrink: 0; color: var(--dc-text); }
.fwd-time { color: var(--dc-gray); flex-shrink: 0; font-size: 0.72rem; }
.fwd-content { flex: 1; word-break: break-word; }

/* Accordion */
.accordion-enter-active, .accordion-leave-active { transition: max-height 0.25s ease, opacity 0.25s; overflow: hidden; }
.accordion-enter-from, .accordion-leave-to { max-height: 0; opacity: 0; }
.accordion-enter-to, .accordion-leave-from { max-height: 800px; opacity: 1; }
</style>

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
  failed?: boolean
  catchup?: boolean
  reconnecting?: boolean
  showHeader?: boolean  // false when same sender sent prev msg within same minute
}>()

const emit = defineEmits<{
  toggle: [id: string]
  resend: [id: string]
}>()

const expanded = ref(false)

const time   = computed(() => dayjs(props.message.timestamp).format('HH:mm'))
const isMine = computed(() => props.message.fromId === props.clientId)

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
        <div v-for="m in message.forwardOf?.messages" :key="m.id" class="forward-msg">
          <span class="fwd-from">{{ m.isSystem ? '[System]' : m.from }}</span>
          <span class="fwd-time">{{ dayjs(m.timestamp).format('HH:mm') }}</span>
          <span class="fwd-content" v-html="m.content" />
        </div>
      </div>
    </Transition>
  </div>

  <!-- Chat message -->
  <div v-else class="chat-row" :class="{ mine: isMine }" @click="selectMode && emit('toggle', message.id)">
    <!-- Sender name + time (only when showHeader or different sender) -->
    <div v-if="showHeader !== false" class="msg-meta">
      <span class="msg-from">{{ message.from }}</span>
      <span v-if="message.isBot">🤖</span>
      <span class="msg-time">{{ time }}</span>
    </div>
    <!-- Bubble with message content only -->
    <div
      class="chat-msg"
      :class="{
        mine: isMine,
        'select-mode': selectMode,
        'catchup-flash': catchup,
        'no-header': showHeader === false,
      }"
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
      <div class="msg-content" v-html="message.content" />
    </div>
  </div>
</template>

<style scoped>
/* ── Chat row: holds meta OUTSIDE + bubble INSIDE ── */
.chat-row {
  display: flex;
  flex-direction: column;
  margin: 4px 0;
  max-width: 85%;
}
.chat-row.mine {
  align-self: flex-end;
  align-items: flex-end;
}
.chat-row:not(.mine) {
  align-self: flex-start;
  align-items: flex-start;
}

/* ── Sender name + time (outside bubble) ── */
.msg-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
  padding: 0 4px;
}
.chat-row.mine .msg-meta { flex-direction: row-reverse; }
.msg-from { font-size: 0.75rem; font-weight: 600; color: var(--dc-gold); }
.chat-row.mine .msg-from { color: var(--dc-gray); }
.msg-time { font-size: 0.68rem; color: var(--dc-gray); }

/* ── Chat bubble (message content only) ── */
.chat-msg {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 16px;
  transition: background 0.1s;
  cursor: default;
}
.chat-msg.mine {
  background: var(--dc-gold);
  border-bottom-right-radius: 4px;
}
.chat-msg:not(.mine) {
  background: var(--dc-panel);
  border-bottom-left-radius: 4px;
}
.chat-msg.select-mode { cursor: pointer; }
.chat-msg.select-mode:hover { filter: brightness(1.2); }
.chat-msg.mine.select-mode:hover { filter: brightness(0.95); }
.chat-msg.no-header { padding-top: 4px; }

.msg-body { flex: 1; min-width: 0; }
.msg-content {
  font-size: 0.92rem;
  line-height: 1.5;
  word-break: break-word;
}
.chat-msg.mine .msg-content { color: #1A1A1A; }
.chat-msg:not(.mine) .msg-content { color: var(--dc-text); }
.msg-content :deep(strong) { color: inherit; }
.msg-content :deep(a) { color: var(--dc-blue); }
.chat-msg.mine .msg-content :deep(a) { color: #1A1A1A; text-decoration: underline; }
.msg-content :deep(img) { max-width: min(280px, 100%); border-radius: 8px; }

/* ── Catch-up flash ── */
@keyframes catchup-flash {
  0%         { background: transparent; }
  10%, 40%   { background: rgba(201, 168, 76, 0.22); }
  70%, 100%  { background: transparent; }
}
.catchup-flash { animation: catchup-flash 3s ease-out 1; }

/* ── Forward card ── */
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
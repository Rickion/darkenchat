<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { Message, FileMeta } from '@/types'
import { useFilesStore } from '@/stores/files'

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
  'download-file': [meta: FileMeta]
}>()

const expanded = ref(false)
const filesStore = useFilesStore()

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

// File-message state
const fileMeta = computed<FileMeta | null>(() =>
  props.message.type === 'file' && props.message.meta
    ? (props.message.meta as unknown as FileMeta)
    : null,
)
const fileStatus = computed(() => fileMeta.value ? filesStore.status.get(fileMeta.value.fileId) : undefined)
const fileProgress = computed(() => {
  if (!fileMeta.value) return null
  const inc = filesStore.incoming.get(fileMeta.value.fileId)
  if (!inc) return null
  return Math.round((inc.received / Math.max(1, inc.total)) * 100)
})
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
function onFileClick() {
  if (!fileMeta.value || props.selectMode) return
  if (fileStatus.value === 'downloading') return
  emit('download-file', fileMeta.value)
}
</script>

<template>
  <!-- System message -->
  <div v-if="message.isSystem" class="sys-msg">
    {{ systemText }} · {{ time }}
  </div>

  <!-- File card -->
  <div v-else-if="message.type === 'file' && fileMeta" class="chat-row" :class="{ mine: isMine }">
    <div v-if="showHeader !== false" class="msg-meta">
      <span class="msg-from">{{ message.from }}</span>
      <span v-if="message.isBot">🤖</span>
      <span class="msg-time">{{ time }}</span>
    </div>
    <div
      class="chat-msg file-msg"
      :class="{ mine: isMine, 'catchup-flash': catchup, 'no-header': showHeader === false }"
      @click="onFileClick"
    >
      <v-icon class="file-icon" size="22">
        {{ fileStatus === 'done' ? 'mdi-file-check-outline'
          : fileStatus === 'error' ? 'mdi-file-alert-outline'
          : fileStatus === 'downloading' ? 'mdi-progress-download'
          : 'mdi-file-download-outline' }}
      </v-icon>
      <div class="file-body">
        <div class="file-name">{{ fileMeta.name }}</div>
        <div class="file-sub">
          <span>{{ fmtSize(fileMeta.size) }}</span>
          <span v-if="fileStatus === 'downloading' && fileProgress !== null"> · {{ fileProgress }}%</span>
          <span v-else-if="fileStatus === 'error'"> · {{ t('file.error') }}</span>
          <span v-else-if="fileStatus === 'done'"> · {{ t('file.saved') }}</span>
          <span v-else> · {{ t('file.click_to_download') }}</span>
        </div>
        <div v-if="fileStatus === 'downloading' && fileProgress !== null" class="file-bar">
          <div class="file-bar-fill" :style="{ width: fileProgress + '%' }" />
        </div>
      </div>
    </div>
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
.accordion-enter-active, .accordion-leave-active { transition: max-height 0.2s ease, opacity 0.2s; overflow: hidden; }
.accordion-enter-from, .accordion-leave-to { max-height: 0; opacity: 0; }
.accordion-enter-to, .accordion-leave-from { max-height: 800px; opacity: 1; }

/* File card */
.file-msg {
  cursor: pointer;
  min-width: 200px;
  max-width: 320px;
  align-items: center;
}
.file-msg:hover { filter: brightness(1.08); }
.chat-msg.file-msg.mine:hover { filter: brightness(0.95); }
.file-icon { flex-shrink: 0; }
.chat-msg.file-msg.mine .file-icon { color: #1A1A1A; }
.file-body { flex: 1; min-width: 0; }
.file-name {
  font-size: 0.9rem;
  font-weight: 600;
  word-break: break-all;
  line-height: 1.3;
}
.chat-msg.file-msg.mine .file-name { color: #1A1A1A; }
.chat-msg.file-msg:not(.mine) .file-name { color: var(--dc-text); }
.file-sub {
  font-size: 0.74rem;
  color: var(--dc-gray);
  margin-top: 2px;
}
.chat-msg.file-msg.mine .file-sub { color: #444; }
.file-bar {
  margin-top: 4px;
  height: 3px;
  background: rgba(255,255,255,0.15);
  border-radius: 2px;
  overflow: hidden;
}
.chat-msg.file-msg.mine .file-bar { background: rgba(0,0,0,0.18); }
.file-bar-fill {
  height: 100%;
  background: var(--dc-gold);
  transition: width 0.15s linear;
}
.chat-msg.file-msg.mine .file-bar-fill { background: #1A1A1A; }
</style>
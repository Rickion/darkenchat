<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { Message, FileMeta, VoiceSessionMeta } from '@/types'
import { useFilesStore } from '@/stores/files'
import { useVoiceStore } from '@/stores/voice'
import { useRoomStore } from '@/stores/room'
import { AUTO_FETCH_SIZE } from '@/composables/useRoom'
import { MENTION_ALL_ID, MENTION_ALL_AI_ID } from '@/_shared/mentions'

const { t } = useI18n()

const props = defineProps<{
  message: Message
  clientId: string
  selectMode?: boolean
  selected?: boolean
  failed?: boolean
  catchup?: boolean
  reconnecting?: boolean
  showHeader?: boolean // false when same sender sent prev msg within same minute
}>()

const emit = defineEmits<{
  toggle: [id: string]
  resend: [id: string]
  'download-file': [meta: FileMeta]
  'view-file': [meta: FileMeta]
  'join-voice': [sessionId: string]
  'open-room-config': []
}>()

const expanded = ref(false)
const filesStore = useFilesStore()
const voiceStore = useVoiceStore()
const roomStore = useRoomStore()

const time = computed(() => dayjs(props.message.timestamp).format('HH:mm'))

// ─── Expert-panel stance ──────────────────────────────────
// AI members may attach a structured stance (position + agree/disagree by
// clientId). We resolve the clientIds to nicknames for display.
function nicksOf(ids?: string[]): string {
  if (!ids || ids.length === 0) return ''
  return ids.map(id => roomStore.members.find(m => m.clientId === id)?.nickname ?? id.slice(0, 6)).join(', ')
}
const stanceAgree = computed(() => nicksOf(props.message.stance?.agreeWith))
const stanceDisagree = computed(() => nicksOf(props.message.stance?.disagreeWith))
const isMine = computed(() => props.message.fromId === props.clientId)

// ─── Mention highlighting ─────────────────────────────────

// Walk every <span class="mention" …> chip in the rendered HTML and:
//   1. tag it with `mention-self` if it targets ME (gold pill — "@me")
//   2. tag it with `mention-all`  if it's the @everyone sentinel (also
//      highlighted on every viewer's screen, since it targets them too)
//   3. for the @everyone chip, rewrite the visible label to the *current*
//      locale's `room.mention_all` so a viewer reading in 中文 sees "@所有人"
//      even when the sender wrote "@All" in English.
function highlightMentions(html: string): string {
  // Match the full chip element so we can rewrite its inner text too.
  // Mention chips are atomic <span class="mention" data-mention-id="…">@Label</span>.
  return html.replace(/<span\s+([^>]*?)>([^<]*)<\/span>/g, (full, attrs: string, inner: string) => {
    if (!/class="[^"]*\bmention\b/.test(attrs)) return full
    const idMatch = attrs.match(/data-mention-id="([^"]*)"/)
    if (!idMatch) return full
    const targetId = idMatch[1]
    const isAll = targetId === MENTION_ALL_ID
    const isAllAi = targetId === MENTION_ALL_AI_ID
    const isSelf = !!props.clientId && targetId === props.clientId
    let newAttrs = attrs
    const addClass = (cls: string) => {
      newAttrs = newAttrs.replace(
        /class="([^"]*)"/,
        (_m: string, c: string) => `class="${c.includes(cls) ? c : c + ' ' + cls}"`,
      )
    }
    if (isAll || isAllAi) addClass('mention-all')
    if (isSelf) addClass('mention-self')
    let newInner = inner
    // Re-localise the @everyone / @all-AI labels to the viewer's locale.
    if (isAll) newInner = '@' + t('room.mention_all')
    else if (isAllAi) newInner = '@' + t('room.mention_all_ai')
    return `<span ${newAttrs}>${newInner}</span>`
  })
}
const renderedContent = computed(() => highlightMentions(props.message.content))
const renderedForwardMsgs = computed(() => {
  return (props.message.forwardOf?.messages ?? []).map(m => ({
    ...m,
    _renderedContent: highlightMentions(m.content),
  }))
})

const systemText = computed(() => {
  if (!props.message.isSystem || props.message.type === 'voice') return ''
  try {
    const { key, params } = JSON.parse(props.message.content)
    return t(key, params)
  } catch {
    return props.message.content
  }
})

// i18n key of a system message, so the template can decorate specific events
// (e.g. attach a gear button after "AI joined").
const sysMessageKey = computed(() => {
  if (!props.message.isSystem || props.message.type === 'voice') return ''
  try {
    const { key } = JSON.parse(props.message.content)
    return key ?? ''
  } catch {
    return ''
  }
})

// ─── Voice bubble ─────────────────────────────────────────
const voiceMeta = computed<VoiceSessionMeta | null>(() => {
  if (props.message.type !== 'voice' || !props.message.meta) return null
  return props.message.meta as unknown as VoiceSessionMeta
})

const voiceParticipantsLabel = computed(() => {
  const meta = voiceMeta.value
  if (!meta || meta.participants.length === 0) return meta?.initiatorNickname ?? ''
  return meta.participants.map(p => p.nickname).join(', ')
})

const voiceDurationLabel = computed(() => {
  const meta = voiceMeta.value
  if (!meta) return ''
  const ms = meta.durationMs ?? (meta.endedAt ?? Date.now()) - meta.startedAt
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
})

const voiceEndedTime = computed(() => {
  const meta = voiceMeta.value
  if (!meta?.endedAt) return ''
  return dayjs(meta.endedAt).format('HH:mm')
})

// "Join" button is shown only when: this is a live (un-ended) session bubble,
// the viewer isn't already in voice, and we're not inside the forward picker
// (where the bubble is just a selectable preview).
const showJoinButton = computed(() => {
  const meta = voiceMeta.value
  if (!meta || meta.voiceKind !== 'session') return false
  if (meta.endedAt) return false
  if (props.selectMode) return false
  if (voiceStore.inVoice) return false
  if (voiceStore.activeSessionId !== meta.sessionId) return false
  return true
})

function onJoinVoice() {
  const meta = voiceMeta.value
  if (meta) emit('join-voice', meta.sessionId)
}

function fwdVoiceIcon(_m: Message): string {
  return 'mdi-phone'
}

// Compact textual rendering for voice messages embedded inside a forward card.
function fwdVoiceText(m: Message): string {
  const meta = m.meta as unknown as VoiceSessionMeta | undefined
  if (!meta) return ''
  const names = meta.participants.map(p => p.nickname).join(', ') || meta.initiatorNickname
  if (meta.voiceKind === 'summary') {
    const ms = meta.durationMs ?? Math.max(0, (meta.endedAt ?? m.timestamp) - meta.startedAt)
    const sec = Math.max(0, Math.floor(ms / 1000))
    const mm = Math.floor(sec / 60)
    const ss = sec % 60
    const dur = `${mm}:${String(ss).padStart(2, '0')}`
    return t('voice.summary_line', {
      duration: dur,
      names,
      endedAt: dayjs(meta.endedAt ?? m.timestamp).format('HH:mm'),
    })
  }
  const title = meta.endedAt ? t('voice.session_ended_short') : t('voice.session_in_progress')
  return `${title} · ${names}`
}

// File-message state
const fileMeta = computed<FileMeta | null>(() =>
  props.message.type === 'file' && props.message.meta ? (props.message.meta as unknown as FileMeta) : null,
)
const fileStatus = computed(() => (fileMeta.value ? filesStore.status.get(fileMeta.value.fileId) : undefined))
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

// ─── Attachment kind / inline-media state ─────────────────
const fileMime = computed(() => fileMeta.value?.mime ?? '')
const isImage = computed(() => fileMime.value.startsWith('image/'))
const isAudio = computed(() => fileMime.value.startsWith('audio/'))
const isVideo = computed(() => fileMime.value.startsWith('video/'))
const isMedia = computed(() => isImage.value || isAudio.value || isVideo.value)
const isLargeFile = computed(() => (fileMeta.value?.size ?? 0) >= AUTO_FETCH_SIZE)
// Object URL for the fetched blob — present once the file has been fetched
// (auto for small files, on click for large ones) or for the sender's own file.
const objectUrl = computed(() => (fileMeta.value ? filesStore.objectUrls.get(fileMeta.value.fileId) : undefined))
// Media renders inline only once its blob URL is available.
const mediaUrl = computed(() => (isMedia.value ? objectUrl.value : undefined))

const fileCardIcon = computed(() => {
  if (fileStatus.value === 'downloading') return 'mdi-progress-download'
  if (fileStatus.value === 'error') return 'mdi-file-alert-outline'
  if (objectUrl.value) return 'mdi-file-check-outline'
  if (isImage.value) return 'mdi-image-outline'
  if (isVideo.value) return 'mdi-video-outline'
  if (isAudio.value) return 'mdi-music-note-outline'
  return 'mdi-file-download-outline'
})

const fileActionLabel = computed(() => {
  if (fileStatus.value === 'downloading') return ''
  if (fileStatus.value === 'error') return t('file.error')
  // Fetched into memory and ready to save without a re-request.
  if (objectUrl.value) return t('file.click_to_save')
  // A save-mode download already completed.
  if (fileStatus.value === 'done') return t('file.saved')
  // Large media isn't auto-fetched — offer to load the preview.
  if (isMedia.value && isLargeFile.value) return t('file.click_to_fetch')
  return t('file.click_to_download')
})

// Card click: large media → fetch for inline view; everything else → save.
// (Small media is auto-fetched and renders inline, so its card never shows.)
function onFileCardClick() {
  if (!fileMeta.value || props.selectMode) return
  if (fileStatus.value === 'downloading') return
  if (isMedia.value && !objectUrl.value) emit('view-file', fileMeta.value)
  else emit('download-file', fileMeta.value)
}
</script>

<template>
  <!-- Voice session / summary bubble — rendered as a left-aligned system chat bubble -->
  <div
    v-if="message.type === 'voice' && voiceMeta"
    class="chat-row voice-row"
    :class="{ 'select-mode': selectMode }"
    @click="selectMode && emit('toggle', message.id)">
    <div class="msg-meta">
      <span class="msg-from sys-from">{{ t('voice.system_label') }}</span>
      <span class="msg-time">{{ time }}</span>
    </div>
    <div
      class="chat-msg voice-msg"
      :class="{
        ended: voiceMeta.voiceKind === 'summary' || !!voiceMeta.endedAt,
        'catchup-flash': catchup,
        'select-mode': selectMode,
      }">
      <v-checkbox
        v-if="selectMode"
        :model-value="selected"
        hide-details
        density="compact"
        class="select-cb"
        @click.stop
        @update:model-value="emit('toggle', message.id)" />
      <div class="voice-bubble-body">
        <template v-if="voiceMeta.voiceKind === 'session'">
          <v-icon size="18" :color="voiceMeta.endedAt ? 'grey' : 'success'" class="voice-icon">mdi-phone</v-icon>
          <div class="voice-bubble-text">
            <div class="voice-bubble-title">
              {{ voiceMeta.endedAt ? t('voice.session_ended_short') : t('voice.session_in_progress') }}
            </div>
            <div class="voice-bubble-names">{{ voiceParticipantsLabel }}</div>
          </div>
        </template>
        <template v-else>
          <v-icon size="18" color="grey" class="voice-icon">mdi-phone</v-icon>
          <div class="voice-bubble-text">
            <div class="voice-bubble-title">{{ t('voice.summary_title') }}</div>
            <div class="voice-bubble-meta">
              {{
                t('voice.summary_line', {
                  duration: voiceDurationLabel,
                  names: voiceParticipantsLabel,
                  endedAt: voiceEndedTime,
                })
              }}
            </div>
          </div>
        </template>
      </div>
      <v-btn
        v-if="showJoinButton"
        icon="mdi-phone-plus"
        size="x-small"
        color="success"
        variant="tonal"
        :title="t('voice.join_session')"
        @click.stop="onJoinVoice" />
    </div>
  </div>

  <!-- System message -->
  <div v-else-if="message.isSystem" class="sys-msg">
    {{ systemText }}
    <!-- Gear shortcut next to the first AI join announcement → opens the
         room-AI config dialog. -->
    <v-btn
      v-if="sysMessageKey === 'system.join_ai_first'"
      icon="mdi-cog-outline"
      size="x-small"
      variant="text"
      density="comfortable"
      class="sys-action-btn"
      :title="t('room_config.gear_tooltip')"
      @click.stop="emit('open-room-config')" />
    · {{ time }}
  </div>

  <!-- File / media attachment -->
  <div v-else-if="message.type === 'file' && fileMeta" class="chat-row" :class="{ mine: isMine }">
    <div v-if="showHeader !== false" class="msg-meta">
      <span class="msg-from">{{ message.from }}</span>
      <v-icon v-if="message.isBot" size="13" color="secondary" class="bot-badge" :title="'AI'">mdi-robot</v-icon>
      <span class="msg-time">{{ time }}</span>
    </div>

    <!-- Inline media (image / audio / video) once its blob is available -->
    <div
      v-if="mediaUrl"
      class="chat-msg media-msg"
      :class="{ mine: isMine, 'catchup-flash': catchup, 'no-header': showHeader === false }">
      <img v-if="isImage" :src="mediaUrl" :alt="fileMeta.name" class="media-img" />
      <audio v-else-if="isAudio" :src="mediaUrl" controls class="media-audio" />
      <video v-else-if="isVideo" :src="mediaUrl" controls playsinline class="media-video" />
    </div>

    <!-- File card: downloading / fetch-preview / download states -->
    <div
      v-else
      class="chat-msg file-msg"
      :class="{ mine: isMine, 'catchup-flash': catchup, 'no-header': showHeader === false }"
      @click="onFileCardClick">
      <v-icon class="file-icon" size="22">{{ fileCardIcon }}</v-icon>
      <div class="file-body">
        <div class="file-name">{{ fileMeta.name }}</div>
        <div class="file-sub">
          <span>{{ fmtSize(fileMeta.size) }}</span>
          <span v-if="fileStatus === 'downloading' && fileProgress !== null">· {{ fileProgress }}%</span>
          <span v-else-if="fileActionLabel">· {{ fileActionLabel }}</span>
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
      <span class="forward-title">
        <v-icon size="14" class="mr-1">mdi-share</v-icon>
        {{ t('forward.title', { name: message.from, count: message.forwardOf?.messages.length ?? 0 }) }}
      </span>
      <v-icon size="small">{{ expanded ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
    </div>
    <Transition name="accordion">
      <div v-if="expanded" class="forward-body">
        <div v-if="message.forwardOf?.note" class="forward-note">{{ message.forwardOf.note }}</div>
        <div v-for="m in renderedForwardMsgs" :key="m.id" class="forward-msg">
          <span class="fwd-from">{{ m.isSystem ? t('forward.system_tag') : m.from }}</span>
          <span class="fwd-time">{{ dayjs(m.timestamp).format('HH:mm') }}</span>
          <span v-if="m.type === 'voice'" class="fwd-content fwd-voice">
            <v-icon size="14" class="mr-1">{{ fwdVoiceIcon(m) }}</v-icon>
            {{ fwdVoiceText(m) }}
          </span>
          <span v-else class="fwd-content" v-html="m._renderedContent" />
        </div>
      </div>
    </Transition>
  </div>

  <!-- Chat message -->
  <div v-else class="chat-row" :class="{ mine: isMine }" @click="selectMode && emit('toggle', message.id)">
    <!-- Sender name + time (only when showHeader or different sender) -->
    <div v-if="showHeader !== false" class="msg-meta">
      <span class="msg-from">{{ message.from }}</span>
      <v-icon v-if="message.isBot" size="13" color="secondary" class="bot-badge" :title="'AI'">mdi-robot</v-icon>
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
      }">
      <v-checkbox
        v-if="selectMode"
        :model-value="selected"
        hide-details
        density="compact"
        class="select-cb"
        @click.stop
        @update:model-value="emit('toggle', message.id)" />
      <!-- Expert-panel stance (structured field from the MCP send_message tool) -->
      <div v-if="message.stance" class="stance-box">
        <div class="stance-position">
          <v-icon size="11" class="stance-icon">mdi-flag-variant-outline</v-icon>
          {{ message.stance.position }}
        </div>
        <div v-if="stanceAgree || stanceDisagree" class="stance-rel">
          <span v-if="stanceAgree" class="stance-agree">▲ {{ stanceAgree }}</span>
          <span v-if="stanceDisagree" class="stance-disagree">▼ {{ stanceDisagree }}</span>
        </div>
      </div>
      <div class="msg-content" v-html="renderedContent" />
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
.chat-row.mine .msg-meta {
  flex-direction: row-reverse;
}
.msg-from {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--dc-gold);
}
.chat-row.mine .msg-from {
  color: var(--dc-gray);
}
.msg-time {
  font-size: 0.68rem;
  color: var(--dc-gray);
}

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
.chat-msg.select-mode {
  cursor: pointer;
}
.chat-msg.select-mode:hover {
  filter: brightness(1.2);
}
.chat-msg.mine.select-mode:hover {
  filter: brightness(0.95);
}
.chat-msg.no-header {
  padding-top: 4px;
}

.msg-body {
  flex: 1;
  min-width: 0;
}
.msg-content {
  font-size: 0.92rem;
  line-height: 1.5;
  word-break: break-word;
}
/* ── Expert-panel stance strip ── */
.stance-box {
  margin-bottom: 5px;
  padding: 4px 7px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  border-left: 2px solid var(--dc-teal);
  font-size: 0.78rem;
}
.chat-msg.mine .stance-box {
  background: rgba(0, 0, 0, 0.07);
}
.stance-position {
  display: flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
}
.chat-msg.mine .stance-position {
  color: #1a1a1a;
}
.stance-icon {
  flex-shrink: 0;
  opacity: 0.7;
}
.stance-rel {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
  font-size: 0.72rem;
}
.stance-agree {
  color: #4caf50;
}
.stance-disagree {
  color: #ef5350;
}
.chat-msg.mine .msg-content {
  color: #1a1a1a;
}
.chat-msg:not(.mine) .msg-content {
  color: var(--dc-text);
}
.msg-content :deep(strong) {
  color: inherit;
  font-weight: 700;
}
.msg-content :deep(em) {
  font-style: italic;
}
.msg-content :deep(u) {
  text-decoration: underline;
}
.msg-content :deep(s) {
  text-decoration: line-through;
}
.msg-content :deep(a) {
  color: var(--dc-blue);
  text-underline-offset: 3px;
}
.chat-msg.mine .msg-content :deep(a) {
  color: #1a1a1a;
  text-decoration: underline;
}
.msg-content :deep(img) {
  max-width: min(280px, 100%);
  border-radius: 8px;
}
/* Inline code */
.msg-content :deep(code) {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  background: rgba(0, 0, 0, 0.32);
  color: var(--dc-text);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 0.87em;
}
.chat-msg.mine .msg-content :deep(code) {
  background: rgba(0, 0, 0, 0.18);
  color: #1a1a1a;
}
/* Code block */
.msg-content :deep(pre) {
  background: #111;
  color: var(--dc-text);
  padding: 10px 12px;
  border-radius: 8px;
  margin: 4px 0;
  overflow-x: auto;
  font-size: 0.85em;
}
.msg-content :deep(pre) code {
  background: transparent;
  color: inherit;
  padding: 0;
}
.chat-msg.mine .msg-content :deep(pre) {
  background: rgba(0, 0, 0, 0.22);
  color: #1a1a1a;
}
.chat-msg.mine .msg-content :deep(pre) code {
  color: #1a1a1a;
}
/* Lists */
.msg-content :deep(ul),
.msg-content :deep(ol) {
  padding-left: 22px;
  margin: 2px 0;
}
.msg-content :deep(ul) {
  list-style: disc outside;
}
.msg-content :deep(ol) {
  list-style: decimal outside;
}
.msg-content :deep(li) {
  margin: 1px 0;
}
.msg-content :deep(li > p) {
  margin: 0;
}
/* Blockquote */
.msg-content :deep(blockquote) {
  border-left: 3px solid var(--dc-gold);
  padding-left: 12px;
  margin: 4px 0;
  color: inherit;
  opacity: 0.92;
}
.chat-msg.mine .msg-content :deep(blockquote) {
  border-left-color: #1a1a1a;
}
.msg-content :deep(p) {
  margin: 2px 0;
}
.msg-content :deep(p:first-child) {
  margin-top: 0;
}
.msg-content :deep(p:last-child) {
  margin-bottom: 0;
}

/* ── Catch-up flash ── */
@keyframes catchup-flash {
  0% {
    background: transparent;
  }
  10%,
  40% {
    background: rgba(201, 168, 76, 0.22);
  }
  70%,
  100% {
    background: transparent;
  }
}
.catchup-flash {
  animation: catchup-flash 3s ease-out 1;
}

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
.forward-header:hover {
  background: #2a2a2a;
}
.forward-body {
  padding: 0 14px 12px;
}
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
.fwd-from {
  font-weight: 600;
  flex-shrink: 0;
  color: var(--dc-text);
}
.fwd-time {
  color: var(--dc-gray);
  flex-shrink: 0;
  font-size: 0.72rem;
}
.fwd-content {
  flex: 1;
  word-break: break-word;
}
.forward-title {
  display: inline-flex;
  align-items: center;
}
.bot-badge {
  vertical-align: middle;
  opacity: 0.85;
}

/* Accordion */
.accordion-enter-active,
.accordion-leave-active {
  transition:
    max-height 0.2s ease,
    opacity 0.2s;
  overflow: hidden;
}
.accordion-enter-from,
.accordion-leave-to {
  max-height: 0;
  opacity: 0;
}
.accordion-enter-to,
.accordion-leave-from {
  max-height: 800px;
  opacity: 1;
}

/* File card */
.file-msg {
  cursor: pointer;
  min-width: 200px;
  max-width: 320px;
  align-items: center;
}
.file-msg:hover {
  filter: brightness(1.08);
}
.chat-msg.file-msg.mine:hover {
  filter: brightness(0.95);
}
.file-icon {
  flex-shrink: 0;
}
.chat-msg.file-msg.mine .file-icon {
  color: #1a1a1a;
}
.file-body {
  flex: 1;
  min-width: 0;
}
.file-name {
  font-size: 0.9rem;
  font-weight: 600;
  word-break: break-all;
  line-height: 1.3;
}
.chat-msg.file-msg.mine .file-name {
  color: #1a1a1a;
}
.chat-msg.file-msg:not(.mine) .file-name {
  color: var(--dc-text);
}
.file-sub {
  font-size: 0.74rem;
  color: var(--dc-gray);
  margin-top: 2px;
}
.chat-msg.file-msg.mine .file-sub {
  color: #444;
}
.file-bar {
  margin-top: 4px;
  height: 3px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
  overflow: hidden;
}
.chat-msg.file-msg.mine .file-bar {
  background: rgba(0, 0, 0, 0.18);
}
.file-bar-fill {
  height: 100%;
  background: var(--dc-gold);
  transition: width 0.15s linear;
}
.chat-msg.file-msg.mine .file-bar-fill {
  background: #1a1a1a;
}

/* Inline media attachment (image / audio / video) */
.chat-msg.media-msg {
  flex-direction: column;
  align-items: stretch;
  padding: 4px;
  background: var(--dc-panel);
  max-width: min(320px, 100%);
}
.chat-msg.media-msg.mine {
  background: var(--dc-gold);
}
.media-img,
.media-video {
  display: block;
  max-width: 100%;
  max-height: 320px;
  border-radius: 12px;
}
.media-img {
  object-fit: contain;
}
.media-audio {
  display: block;
  width: 260px;
  max-width: 100%;
}

/* Inline action icon embedded in a system message (e.g. AI-join gear) */
.sys-action-btn {
  vertical-align: middle;
  margin: 0 2px;
  opacity: 0.85;
}
.sys-action-btn:hover {
  opacity: 1;
}

/* Voice bubble rendered inside a normal left-aligned chat row (system sender) */
.voice-row {
  max-width: 85%;
}
.sys-from {
  color: var(--dc-gold);
}
.chat-msg.voice-msg {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--dc-panel);
  border-bottom-left-radius: 4px;
}
.chat-msg.voice-msg.ended {
  background: var(--dc-panel);
  opacity: 0.85;
}
.voice-bubble-body {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}
.voice-bubble-text {
  min-width: 0;
  flex: 1;
}
.voice-bubble-title {
  font-weight: 600;
  letter-spacing: 0.02em;
  font-size: 0.86rem;
  color: var(--dc-gold);
}
.chat-msg.voice-msg.ended .voice-bubble-title {
  color: var(--dc-gray);
}
.voice-bubble-names {
  margin-top: 2px;
  font-size: 0.82rem;
  color: var(--dc-text);
  word-break: break-word;
}
.voice-bubble-meta {
  margin-top: 2px;
  font-size: 0.78rem;
  color: var(--dc-gray);
  word-break: break-word;
}
.voice-icon {
  flex-shrink: 0;
}
</style>

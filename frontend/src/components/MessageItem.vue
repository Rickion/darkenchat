<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { Message, FileMeta, VoiceSessionMeta } from '@/types'
import { useFilesStore } from '@/stores/files'
import { useVoiceStore } from '@/stores/voice'
import { useRoomStore } from '@/stores/room'
import { useMessagesStore } from '@/stores/messages'
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
const msgStore = useMessagesStore()

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
    // "Mention of someone else" — visible to third-party viewers as a yellow
    // border (same shape as @self, only background differs).
    const isOther = !isAll && !isAllAi && !isSelf && !!targetId
    let newAttrs = attrs
    const addClass = (cls: string) => {
      newAttrs = newAttrs.replace(
        /class="([^"]*)"/,
        (_m: string, c: string) => `class="${c.includes(cls) ? c : c + ' ' + cls}"`,
      )
    }
    if (isAll || isAllAi) addClass('mention-all')
    if (isSelf) addClass('mention-self')
    else if (isOther) addClass('mention-other')
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

// ─── Chat-bubble collapse + copy ──────────────────────────
// Applies only to plain chat bubbles (the `<div v-else …>` branch at the
// bottom of the template). The side-gutter icon group adapts to:
//   • PC  → hover-only, follows the mouse Y on the bubble's side
//   • mobile + bubble > 1 viewport → two groups (top & bottom of the side)
//   • mobile + short bubble        → single group below the bubble outside
// Single-line bubbles get no icons (collapse is meaningless and copy is rarely
// needed — keeps short messages visually clean).

const bubbleEl = ref<HTMLDivElement | null>(null)
const naturalH = ref(0) // height of fully-expanded bubble content
const viewportH = ref(typeof window !== 'undefined' ? window.innerHeight : 800)
const hovering = ref(false)
const mouseY = ref(0) // relative to bubble top
// When the cursor is over the icon group itself, freeze the follow-mouse Y so
// the icons don't shift out from under the click target.
const iconHovered = ref(false)

const isCollapsed = computed(() => msgStore.collapsedIds.has(props.message.id))

// "Single line": the un-collapsed content height is at most ~1.6 line-heights
// of the bubble's font-size (msg-content uses 0.92rem * 1.5 ≈ 22px). The
// 1.6 multiplier gives a forgiving threshold so a chip-only message ("@Bob")
// still counts as one line even with chip padding.
const isSingleLine = computed(() => {
  if (naturalH.value === 0) return true // before measurement; safe default = hide icons
  return naturalH.value <= 32
})

const isMobile = computed(() => viewportH.value > 0 && window.innerWidth < 768)
const bubbleOverflowsScreen = computed(() => naturalH.value > viewportH.value * 0.9)

// Where to render the icon group(s). 'none' = no icons (non-chat / select).
// The group itself stays visible for single-line bubbles so the copy icon can
// still appear on hover; the collapse icon inside is gated separately by
// `!isSingleLine` (collapsing a one-line message is meaningless).
type IconMode = 'none' | 'pc-follow' | 'mobile-side-both' | 'mobile-side'
const iconMode = computed<IconMode>(() => {
  if (props.selectMode) return 'none' // selection mode owns the bubble UI
  if (props.message.type !== 'chat') return 'none'
  if (props.message.isSystem) return 'none'
  if (isMobile.value) {
    // Mobile has no hover, so the side group is always shown. A collapsed
    // bubble is visually short regardless of its (unchanged) natural height,
    // so the dual top/bottom anchors would overlap — use a single centred
    // group instead. A tall expanded bubble gets two anchors (top + bottom)
    // so an icon is always reachable; everything else gets one centred group.
    if (isCollapsed.value) return 'mobile-side'
    return bubbleOverflowsScreen.value ? 'mobile-side-both' : 'mobile-side'
  }
  return hovering.value ? 'pc-follow' : 'none'
})

// Lays out the PC follow-mouse icon group. Clamp the Y so the icon group
// stays fully inside the bubble height even near the edges.
const ICON_HALF = 30 // approx half-height of stacked icon group
const iconY = computed(() => {
  const h = bubbleEl.value?.offsetHeight ?? 0
  if (h === 0) return 0
  return Math.max(ICON_HALF, Math.min(h - ICON_HALF, mouseY.value))
})

function onBubbleEnter() {
  hovering.value = true
}
function onBubbleLeave() {
  hovering.value = false
  iconHovered.value = false
}
function onBubbleMouseMove(e: MouseEvent) {
  if (!bubbleEl.value) return
  // Freeze Y once the cursor is on the icon group — otherwise the icons
  // drift mid-click and the user keeps chasing them.
  if (iconHovered.value) return
  const rect = bubbleEl.value.getBoundingClientRect()
  mouseY.value = e.clientY - rect.top
}
function onIconGroupEnter() {
  iconHovered.value = true
}
function onIconGroupLeave() {
  iconHovered.value = false
}

function onToggleCollapsed() {
  msgStore.toggleCollapsed(props.message.id)
  // Collapsing/expanding shrinks or grows the bubble under a stationary
  // cursor, leaving the PC follow-mouse icons floating at a now-meaningless
  // Y. Drop the hover state so the icons dismiss with the click; they
  // reappear on the next genuine mouse-enter.
  hovering.value = false
  iconHovered.value = false
}

// Build the plain-text representation for clipboard.
// • Strips mention chips to their visible "@Nick" label
// • Drops all other HTML tags but keeps paragraph breaks as newlines
// • Prepends "[Position: …] " when this is a stance-bearing message, so the
//   copied context isn't lost.
function plainTextForCopy(): string {
  const html = props.message.content
  const withBreaks = html.replace(/<\/p>\s*<p[^>]*>/gi, '\n').replace(/<\/?p[^>]*>/gi, '')
  const text = withBreaks.replace(/<[^>]+>/g, '').trim()
  const stance = props.message.stance?.position
  return stance ? `[${stance}] ${text}` : text
}
async function onCopyMessage() {
  const text = plainTextForCopy()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Fallback for non-secure contexts: use an off-screen textarea.
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } catch {
      /* ignore */
    }
    document.body.removeChild(ta)
  }
}

// Track natural bubble content height. We measure msg-content directly so
// chat-msg padding + the (sometimes present) stance-box don't inflate the
// "is the content single-line?" check. scrollHeight stays correct even when
// the bubble is collapsed (the mask-image clamp doesn't change layout height
// of the inner element — only the visual overflow).
let resizeObs: ResizeObserver | null = null
function measureBubble() {
  const el = bubbleEl.value
  if (!el) return
  const inner = el.querySelector<HTMLElement>('.msg-content')
  naturalH.value = inner ? inner.scrollHeight : el.scrollHeight
}
function onWindowResize() {
  viewportH.value = window.innerHeight
  measureBubble()
}
onMounted(() => {
  nextTick(measureBubble)
  if (bubbleEl.value) {
    resizeObs = new ResizeObserver(measureBubble)
    resizeObs.observe(bubbleEl.value)
  }
  window.addEventListener('resize', onWindowResize)
})
onBeforeUnmount(() => {
  resizeObs?.disconnect()
  resizeObs = null
  window.removeEventListener('resize', onWindowResize)
})
// Re-measure when content changes (e.g. mention re-localisation after a
// language switch could change wrapping).
watch(
  () => props.message.content,
  () => nextTick(measureBubble),
)
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
    <!-- Bubble + side-gutter icon overlay (collapse / copy).
         The wrapper is the hover surface so leaving the bubble onto the icon
         group doesn't dismiss the icons mid-click. -->
    <div
      class="bubble-wrap"
      :class="{ mine: isMine }"
      @mouseenter="onBubbleEnter"
      @mouseleave="onBubbleLeave"
      @mousemove="onBubbleMouseMove">
      <div
        ref="bubbleEl"
        class="chat-msg"
        :class="{
          mine: isMine,
          'select-mode': selectMode,
          'catchup-flash': catchup,
          'no-header': showHeader === false,
          collapsed: isCollapsed,
          'has-stance': !!message.stance,
        }">
        <v-checkbox
          v-if="selectMode"
          :model-value="selected"
          hide-details
          density="compact"
          class="select-cb"
          @click.stop
          @update:model-value="emit('toggle', message.id)" />
        <!-- Expert-panel stance (structured field from the MCP send_message
             tool). Rendered as a status-colour strip flush with the bubble's
             top edge and STACKED ABOVE the content (column layout). When the
             bubble is collapsed only the colour band remains — the position /
             relation text hides, while the content below keeps its
             half-line-2 + gradient collapse preview. -->
        <div v-if="message.stance" class="stance-box" :class="{ collapsed: isCollapsed }">
          <div v-if="!isCollapsed" class="stance-detail">
            <div class="stance-position">
              <v-icon size="11" class="stance-icon">mdi-flag-variant-outline</v-icon>
              {{ message.stance.position }}
            </div>
            <div v-if="stanceAgree || stanceDisagree" class="stance-rel">
              <span v-if="stanceAgree" class="stance-agree">▲ {{ stanceAgree }}</span>
              <span v-if="stanceDisagree" class="stance-disagree">▼ {{ stanceDisagree }}</span>
            </div>
          </div>
        </div>
        <div class="msg-content" v-html="renderedContent" />
      </div>
      <!-- PC: follow-mouse icon group on the bubble's outside. The collapse
           v-btn is gated by `!isSingleLine` — collapsing a one-line message
           does nothing — but the copy v-btn ALWAYS shows on hover so even
           short messages can be copied via the gutter. While the cursor is
           on the icon group itself the follow-mouse Y freezes
           (`@mouseenter` flips iconHovered → onBubbleMouseMove no-ops). -->
      <div
        v-if="iconMode === 'pc-follow'"
        class="bubble-icons bubble-icons-side"
        :class="{ 'side-left': isMine, 'side-right': !isMine }"
        :style="{ top: iconY + 'px' }"
        @mouseenter="onIconGroupEnter"
        @mouseleave="onIconGroupLeave">
        <v-tooltip
          v-if="!isSingleLine"
          :text="isCollapsed ? t('room.expand') : t('room.collapse')"
          location="top"
          open-delay="1000">
          <template #activator="{ props: tp }">
            <v-btn
              :icon="isCollapsed ? 'mdi-unfold-more-horizontal' : 'mdi-unfold-less-horizontal'"
              size="x-small"
              variant="text"
              density="comfortable"
              v-bind="tp"
              @click.stop="onToggleCollapsed" />
          </template>
        </v-tooltip>
        <v-tooltip :text="t('room.copy')" location="top" open-delay="1000">
          <template #activator="{ props: tp }">
            <v-btn
              icon="mdi-content-copy"
              size="x-small"
              variant="text"
              density="comfortable"
              v-bind="tp"
              @click.stop="onCopyMessage" />
          </template>
        </v-tooltip>
      </div>
      <!-- Mobile + long bubble: two groups (top + bottom of the side). A long
           bubble is by definition multi-line, so the collapse icon shows
           unconditionally here. -->
      <template v-else-if="iconMode === 'mobile-side-both'">
        <div
          class="bubble-icons bubble-icons-side bubble-icons-anchor-top"
          :class="{ 'side-left': isMine, 'side-right': !isMine }">
          <v-tooltip :text="isCollapsed ? t('room.expand') : t('room.collapse')" location="top" open-delay="1000">
            <template #activator="{ props: tp }">
              <v-btn
                :icon="isCollapsed ? 'mdi-unfold-more-horizontal' : 'mdi-unfold-less-horizontal'"
                size="x-small"
                variant="text"
                density="comfortable"
                v-bind="tp"
                @click.stop="onToggleCollapsed" />
            </template>
          </v-tooltip>
          <v-tooltip :text="t('room.copy')" location="top" open-delay="1000">
            <template #activator="{ props: tp }">
              <v-btn
                icon="mdi-content-copy"
                size="x-small"
                variant="text"
                density="comfortable"
                v-bind="tp"
                @click.stop="onCopyMessage" />
            </template>
          </v-tooltip>
        </div>
        <div
          class="bubble-icons bubble-icons-side bubble-icons-anchor-bottom"
          :class="{ 'side-left': isMine, 'side-right': !isMine }">
          <v-tooltip :text="isCollapsed ? t('room.expand') : t('room.collapse')" location="top" open-delay="1000">
            <template #activator="{ props: tp }">
              <v-btn
                :icon="isCollapsed ? 'mdi-unfold-more-horizontal' : 'mdi-unfold-less-horizontal'"
                size="x-small"
                variant="text"
                density="comfortable"
                v-bind="tp"
                @click.stop="onToggleCollapsed" />
            </template>
          </v-tooltip>
          <v-tooltip :text="t('room.copy')" location="top" open-delay="1000">
            <template #activator="{ props: tp }">
              <v-btn
                icon="mdi-content-copy"
                size="x-small"
                variant="text"
                density="comfortable"
                v-bind="tp"
                @click.stop="onCopyMessage" />
            </template>
          </v-tooltip>
        </div>
      </template>
      <!-- Mobile + short bubble: a single vertically-centred group in the side
           gutter — beside the bubble, same placement as PC (always shown, no
           hover on touch). Collapse icon hidden for single-line bubbles. -->
      <div
        v-else-if="iconMode === 'mobile-side'"
        class="bubble-icons bubble-icons-side bubble-icons-anchor-center"
        :class="{ 'side-left': isMine, 'side-right': !isMine }">
        <v-tooltip
          v-if="!isSingleLine"
          :text="isCollapsed ? t('room.expand') : t('room.collapse')"
          location="top"
          open-delay="1000">
          <template #activator="{ props: tp }">
            <v-btn
              :icon="isCollapsed ? 'mdi-unfold-more-horizontal' : 'mdi-unfold-less-horizontal'"
              size="x-small"
              variant="text"
              density="comfortable"
              v-bind="tp"
              @click.stop="onToggleCollapsed" />
          </template>
        </v-tooltip>
        <v-tooltip :text="t('room.copy')" location="top" open-delay="1000">
          <template #activator="{ props: tp }">
            <v-btn
              icon="mdi-content-copy"
              size="x-small"
              variant="text"
              density="comfortable"
              v-bind="tp"
              @click.stop="onCopyMessage" />
          </template>
        </v-tooltip>
      </div>
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
/* ── Expert-panel stance strip ──
   A stance turns the bubble into a column: a status-colour header strip flush
   with the bubble's top edge, then the message content below. The strip bleeds
   out over the bubble's 8px/14px padding to sit edge-to-edge; `overflow:hidden`
   on the bubble clips the strip's square corners to the bubble's top radius so
   the colour band "重合" with the bubble top. Only the top of the bubble
   carries the stance colour — the content area keeps the plain bubble bg. */
.chat-msg.has-stance {
  flex-direction: column;
  align-items: stretch;
  padding-top: 0;
  overflow: hidden;
}
/* In the forward-picker the checkbox shares the column — keep it from
   stretching full width. */
.chat-msg.has-stance .select-cb {
  align-self: flex-start;
}
.stance-box {
  margin: 0 -14px 7px;
  padding: 5px 14px 6px;
  background: rgba(74, 155, 142, 0.16);
  border-top: 3px solid var(--dc-teal);
  font-size: 0.78rem;
}
.chat-msg.mine .stance-box {
  background: rgba(74, 155, 142, 0.24);
}
/* Collapsed: keep ONLY the status-colour band; the position / relation text is
   removed from the DOM (v-if), so the strip shrinks to a slim solid bar. */
.stance-box.collapsed {
  margin: 0 -14px 7px;
  padding: 0;
  height: 5px;
  border-top: 0;
  background: var(--dc-teal);
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

/* ── Bubble wrapper (chat bubble + side gutter icons) ──
   inline-block so the wrap shrinks to its content; gutter padding on the
   side away from the bubble's edge holds the absolute-positioned icon
   group INSIDE the wrap's bounding box. This is load-bearing for hover:
   if the icons sat outside the wrap (negative offset), moving the cursor
   from the bubble onto the icons would trigger mouseleave and dismiss
   them mid-click. Bubble alignment math:
     • non-mine: wrap aligns flex-start, padding on the right; bubble
                 sits left-flush, gutter is 38px to the right of bubble.
     • mine:     wrap aligns flex-end, padding on the left; bubble sits
                 right-flush, gutter is 38px to the left of bubble.
*/
.bubble-wrap {
  position: relative;
  display: inline-block;
  max-width: 100%;
  padding-right: 38px;
}
.bubble-wrap.mine {
  padding-right: 0;
  padding-left: 38px;
}

/* Collapsed bubble: clamp height so line 1 is fully visible AND line 2's top
   half is shown. Line-height is 1.5em, so 2.25em = one full line + 0.75em ≈
   half of line 2. A ::after pseudo-element paints a gradient overlay
   (transparent → bubble-bg) on the bottom 1.1em so the cut is visually
   absorbed into the bubble instead of being a hard slice — the eye reads it
   as "the text is fading out, there's more below". We use an overlay rather
   than mask-image because:
     • mask-image fades text to transparent — fragile across browsers, and
       only the very thin clipped region shows the effect.
     • An overlay gradient using the bubble's own background colour produces
       a stronger, controllable "fog" that's identical across engines.
   stance-box is outside .msg-content and stays fully visible regardless. */
.chat-msg.collapsed .msg-content {
  max-height: 2.25em;
  overflow: hidden;
  position: relative;
}
.chat-msg.collapsed .msg-content::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1.1em;
  pointer-events: none;
  /* Default = panel-coloured bubble (non-mine). The `.mine` override below
     swaps to gold. The 0%-alpha stop uses the same RGB as the destination
     colour so the gradient interpolates purely on alpha — without that,
     interpolating between transparent-white and the dark panel would pass
     through a muddy mid-grey halfway through. */
  background: linear-gradient(to bottom, rgba(36, 36, 36, 0) 0%, var(--dc-panel) 100%);
}
.chat-msg.mine.collapsed .msg-content::after {
  background: linear-gradient(to bottom, rgba(201, 168, 76, 0) 0%, var(--dc-gold) 100%);
}

/* ── Side gutter icon group (PC follow-mouse + mobile big-bubble anchors) ── */
.bubble-icons {
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 2;
  pointer-events: auto;
}
.bubble-icons-side {
  position: absolute;
  transform: translateY(-50%);
  background: rgba(20, 20, 20, 0.65);
  border-radius: 18px;
  padding: 2px;
  backdrop-filter: blur(4px);
}
/* Positive offsets — icons sit INSIDE the wrap's padding gutter so the
   wrap's bounding box (and therefore the @mouseleave trigger) includes
   them. side-right is used when the bubble is non-mine (gutter is the
   wrap's right padding); side-left when mine (gutter on the left). */
.bubble-icons-side.side-right {
  right: 2px;
}
.bubble-icons-side.side-left {
  left: 2px;
}
/* Mobile + tall bubble: fixed anchors at top / bottom of the side */
.bubble-icons-anchor-top {
  top: 28px;
}
.bubble-icons-anchor-bottom {
  top: auto;
  bottom: 28px;
  transform: translateY(50%);
}
/* Mobile + short bubble: a single group centred vertically on the bubble side */
.bubble-icons-anchor-center {
  top: 50%;
}
</style>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClipboard } from '@vueuse/core'
import QRCode from 'qrcode'

import { useRoom, MAX_FILE_SIZE } from '@/composables/useRoom'
import { MAX_VOICE_PARTICIPANTS } from '@/composables/useVoice'
import { useNotification } from '@/composables/useNotification'
import { useRoomStore } from '@/stores/room'
import { useMessagesStore } from '@/stores/messages'
import { useConnectionStore } from '@/stores/connection'
import { useTurnStore } from '@/stores/turn'
import { useVoiceStore } from '@/stores/voice'
import type { Message, MemberInfo, FileMeta } from '@/types'

import MemberList from '@/components/MemberList.vue'
import MessageItem from '@/components/MessageItem.vue'
import RichEditor from '@/components/RichEditor.vue'
import ForwardPanel from '@/components/ForwardPanel.vue'
import LanguageSwitcher from '@/components/LanguageSwitcher.vue'

import { getRandomNickname, getRandomSeriesKey } from '@/assets/nicknames'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const { copy } = useClipboard()

const roomKey = computed(() => (route.params.key as string).toUpperCase())

// ─── Pre-join state ──────────────────────────────────────
const preJoin = ref<'loading' | 'join' | 'create' | null>('loading')
const preJoinSeriesKey = getRandomSeriesKey()
const preJoinNick = ref(getRandomNickname(preJoinSeriesKey))

function preJoinRandomize() {
  preJoinNick.value = getRandomNickname(preJoinSeriesKey)
}

// ─── State ────────────────────────────────────────────────
const showKickConfirm = ref(false)
const showEndConfirm = ref(false)
const showRoomEndedDialog = ref(false)
const showKickedDialog = ref(false)
const showForward = ref(false)
const showCopied = ref(false)
const showSwitchConfirm = ref(false)
const showQR = ref(false)
const qrDataUrl = ref('')
const showRelayConfirm = ref(false)
const showConnDetail = ref(false)
const showRoomConfig = ref(false)
// Editable input inside the dialog. Synced from store on open; written back on save.
const roomConfigInput = ref<number | string>(0)

const kickTarget = ref<MemberInfo | null>(null)
const connectionFailed = ref(false)
const snackbar = ref({ show: false, text: '', color: '' })
const msgListEl = ref<HTMLElement | null>(null)

// ─── Notification ─────────────────────────────────────────
const { requestPermission, notify } = useNotification()

// ─── Stores & composables ─────────────────────────────────
const roomStore = useRoomStore()
const msgStore = useMessagesStore()
const connStore = useConnectionStore()
const turnStore = useTurnStore()
const voiceStore = useVoiceStore()

const { join, leave, sendMessage, sendForward, resendMessage, attachFile, requestFileDownload, requestFileView, startVoiceSession, joinVoiceSession, leaveVoice, toggleMute, confirmRelay, signaling, setAiTurnLimit } = useRoom((e: { event: string }) => {
  if (e.event === 'kicked')            { showKickedDialog.value = true }
  if (e.event === 'room_ended')        { showRoomEndedDialog.value = true }
  if (e.event === 'room_banned')       { showSnackbar(t('error.room_banned'), 'error') }
  if (e.event === 'connection_failed') { connectionFailed.value = true }
  if (e.event === 'relay_request')     { showRelayConfirm.value = true }
  if (e.event === 'mic_denied')        { showSnackbar(t('voice.mic_denied'), 'error', 5000) }
  if (e.event === 'voice_full')        { showSnackbar(t('voice.full', { max: MAX_VOICE_PARTICIPANTS }), 'warning', 4000) }
  if (e.event === 'relay_active') {
    showSnackbar(
      connStore.techMode ? t('conn.relay_toast_tech') : t('conn.relay_toast'),
      'warning',
      6000,
    )
  }
  // P2P recovered before the user decided on relay — dismiss the now-stale
  // "use server relay?" dialog and join the room normally. Without this the
  // dialog would just sit there, even though messages are flowing fine.
  if (e.event === 'p2p_recovered')     { showRelayConfirm.value = false }
})

// Cancel from the relay confirmation dialog: the user explicitly refuses
// the server-relay fallback. Without P2P AND without relay there is no way
// to send or receive in this room, so we tear the session down and route
// back to home rather than leave a half-dead screen behind.
function declineRelay() {
  showRelayConfirm.value = false
  confirmRelay(false)
  leave()
  router.push('/')
}

// ─── Voice ───────────────────────────────────────────────
// Mic button has three modes:
//   - in voice → click leaves the call
//   - no active session → click starts a brand-new session bubble
//   - someone else is hosting → button is disabled (use the "Join" affordance
//     on the in-progress bubble instead)
function onToggleVoice() {
  if (voiceStore.inVoice) leaveVoice()
  else if (!voiceStore.activeSessionId) startVoiceSession()
}

// Disables the mic button while someone else is hosting a call I'm not in.
// While I'm in the call the button stays enabled (it acts as "leave").
const voiceCtrlDisabled = computed(() =>
  roomStore.reconnecting ||
  (!!voiceStore.activeSessionId && !voiceStore.inVoice)
)

function onJoinVoiceFromBubble(sessionId: string) {
  joinVoiceSession(sessionId)
}

// Helper: show header only when sender changes or time minute changes
function shouldShowHeader(messages: Message[], index: number): boolean {
  if (index === 0) return true
  const curr = messages[index]
  const prev = messages[index - 1]
  if (curr.fromId !== prev.fromId) return true
  const currMinute = Math.floor(curr.timestamp / 60000)
  const prevMinute = Math.floor(prev.timestamp / 60000)
  return currMinute !== prevMinute
}

// Watch for WebSocket disconnection
watch(() => signaling.disconnected.value, (disconnected) => {
  if (disconnected) {
    showSnackbar(t('error.connection_lost'), 'error', 0)
  }
})

// ─── Lifecycle ────────────────────────────────────────────
onMounted(async () => {
  await requestPermission()

  const res = await fetch(`/api/rooms/${roomKey.value}`)
  const roomExists = res.ok

  const storedNick = roomStore.pendingNickname
  if (storedNick) {
    preJoinNick.value = storedNick
    if (roomExists) {
      // Nickname already set from home page — join directly, no pre-join screen
      preJoin.value = null
      await join(roomKey.value, storedNick)
    } else {
      // Room doesn't exist, show create confirmation
      preJoin.value = 'create'
    }
  } else {
    // Direct link without prior nickname — show pre-join card
    preJoinNick.value = getRandomNickname(preJoinSeriesKey)
    preJoin.value = roomExists ? 'join' : 'create'
  }
})

onUnmounted(() => {
  leave()
})

// ─── Pre-join action ──────────────────────────────────────
async function doJoin() {
  const nick = preJoinNick.value.trim() || getRandomNickname(preJoinSeriesKey)
  roomStore.pendingNickname = nick

  if (preJoin.value === 'create') {
    await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: roomKey.value }) })
  }

  preJoin.value = null
  await join(roomKey.value, nick)
}

// ─── Tab title unread badge ───────────────────────────────
watch(() => msgStore.messages.length, () => {
  const last = msgStore.messages.at(-1)
  if (last && last.type === 'chat' && last.fromId !== roomStore.clientId) {
    const plain = last.content.replace(/<[^>]*>/g, '')
    notify(last.from, plain)
  }
})

// ─── Auto-scroll ──────────────────────────────────────────
watch(() => msgStore.messages.length, () => {
  nextTick(() => {
    if (msgListEl.value) {
      msgListEl.value.scrollTop = msgListEl.value.scrollHeight
    }
  })
})

// ─── Reconnecting snackbar ────────────────────────────────
watch(() => roomStore.reconnecting, (v) => {
  if (v) showSnackbar(t('system.reconnecting'), 'warning')
  else   showSnackbar(t('system.reconnected'), 'success', 3000)
})

// ─── TURN toast: show once when state changes to 'turn' ──
watch(() => connStore.state, (newState, oldState) => {
  if (newState === 'turn' && oldState !== 'turn') {
    showSnackbar(
      connStore.techMode ? t('conn.turn_toast_tech') : t('conn.turn_toast'),
      'info',
      6000,
    )
  }
})

// ─── Dynamic privacy bar text ─────────────────────────────
const privacyText = computed(() => {
  switch (connStore.state) {
    case 'p2p':        return t('app.privacy')
    case 'turn':       return t('app.privacy_turn')
    case 'relay':      return t('app.privacy_relay')
    case 'connecting': return t('app.privacy_connecting')
    default:           return t('app.privacy')
  }
})

const privacyIcon = computed(() => {
  switch (connStore.state) {
    case 'p2p':        return 'mdi-lock'
    case 'turn':       return 'mdi-shield-lock-outline'
    case 'relay':      return 'mdi-lock-open-variant-outline'
    case 'connecting': return 'mdi-dots-horizontal-circle-outline'
    default:           return 'mdi-lock'
  }
})

const privacyColor = computed(() => connStore.color)

// ─── Actions ──────────────────────────────────────────────
function onSend(html: string) {
  sendMessage(html)
}

// ─── File attach ──────────────────────────────────────────
const fileInput = ref<HTMLInputElement | null>(null)

function onAttachClick() {
  if (roomStore.reconnecting) return
  fileInput.value?.click()
}

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''  // allow re-picking the same file later
  if (!file) return
  const result = attachFile(file)
  if (!result.ok && result.reason === 'too_large') {
    showSnackbar(t('file.too_large', { mb: Math.floor(MAX_FILE_SIZE / 1024 / 1024) }), 'warning', 4000)
  }
}

function onDownloadFile(meta: FileMeta) {
  requestFileDownload(meta)
}

function onViewFile(meta: FileMeta) {
  requestFileView(meta)
}

// Open the room AI config dialog. Reachable from three places: the gear icon
// on the humans-vs-AI divider in the member list, the (xx/yy) counter next to
// each AI's name, and the gear shortcut on the "first AI joined" system msg.
function onOpenRoomConfig() {
  roomConfigInput.value = roomStore.aiTurnLimit
  showRoomConfig.value = true
}

function onSaveRoomConfig() {
  const raw = Number(roomConfigInput.value)
  const next = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0
  setAiTurnLimit(next)
  showRoomConfig.value = false
}

async function copyInvite() {
  const url = window.location.href
  copy(url)
  showCopied.value = true
  setTimeout(() => showCopied.value = false, 3000)
  qrDataUrl.value = await QRCode.toDataURL(url, {
    width: 220,
    margin: 2,
    color: { dark: '#1a0035', light: '#f5f0ff' },
  })
  showQR.value = true
}

function confirmKick() {
  if (!kickTarget.value) return
  signaling.send({ type: 'kick' as never, roomKey: roomKey.value, targetId: kickTarget.value.clientId } as never)
  showKickConfirm.value = false
  kickTarget.value = null
}

function confirmEndRoom() {
  signaling.send({ type: 'end_room' as never, roomKey: roomKey.value } as never)
  showEndConfirm.value = false
}

function onKickRequest(member: MemberInfo) {
  kickTarget.value = member
  showKickConfirm.value = true
}

function onForwardSend(msgs: Message[], note: string) {
  sendForward(msgs, note)
  showForward.value = false
}

function dismissKicked() {
  router.push('/')
}

function dismissRoomEnded() {
  msgStore.clear(roomKey.value)
  roomStore.reset()
  router.push('/')
}

function showSnackbar(text: string, color: string, duration = 0) {
  snackbar.value = { show: true, text, color }
  if (duration) setTimeout(() => { snackbar.value.show = false }, duration)
}

const isMobile = computed(() => window.innerWidth < 768)
const sidebarOpen = ref(false)

// Action-bar "coming soon" icons (document / whiteboard / map). On desktop the
// hover tooltip is enough; on mobile there is no hover, so a tap surfaces the
// same hint via a short snackbar.
function onComingSoon(label: string) {
  if (isMobile.value) {
    showSnackbar(`${label} · ${t('common.coming_soon')}`, 'info', 2500)
  }
}
</script>

<template>
  <div class="room-layout">

    <!-- ═══ PRE-JOIN SCREEN ════════════════════════════════ -->
    <div v-if="preJoin && preJoin !== 'loading'" class="prejoin-overlay">
      <div class="prejoin-card">
        <div class="prejoin-logo"><v-icon color="warning" size="28">mdi-ghost</v-icon> <span class="prejoin-appname">DarkenChat</span></div>
        <div class="prejoin-room">{{ roomKey }}</div>

        <div class="prejoin-nick-row">
          <v-text-field
            v-model="preJoinNick"
            :label="t('room.nickname_label')"
            maxlength="24"
            density="compact"
            hide-details
            autofocus
            @keyup.enter="doJoin"
          />
          <v-btn icon="mdi-dice-multiple" variant="text" size="small" @click="preJoinRandomize" />
        </div>

        <v-btn
          color="primary"
          size="large"
          block
          :disabled="!preJoinNick.trim()"
          :prepend-icon="preJoin === 'create' ? 'mdi-plus-circle' : 'mdi-arrow-right'"
          @click="doJoin"
        >
          {{ preJoin === 'create' ? t('room.create_as', { nick: preJoinNick || '…' }) : t('room.join_as', { nick: preJoinNick || '…' }) }}
        </v-btn>

        <v-btn variant="text" size="small" class="mt-2" @click="router.push('/')">
          {{ t('forward.cancel') }}
        </v-btn>
      </div>
    </div>

    <!-- ═══ LOADING ════════════════════════════════════════ -->
    <div v-else-if="preJoin === 'loading'" class="prejoin-overlay">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <!-- ═══ ROOM UI ════════════════════════════════════════ -->
    <template v-else>
      <!-- HEADER -->
      <header class="room-header">
        <v-icon class="app-logo-icon" color="warning">mdi-ghost</v-icon>
        <span class="room-key">{{ roomKey }}</span>

        <!-- Connection status icon -->
        <v-tooltip :text="connStore.techMode ? t('conn.' + connStore.state + '_tech') : t('conn.' + connStore.state)" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn
              :icon="connStore.icon"
              size="x-small"
              variant="text"
              :style="{ color: connStore.color }"
              v-bind="tp"
              @click="showConnDetail = !showConnDetail"
            />
          </template>
        </v-tooltip>

        <!-- Invite / copy link -->
        <div class="invite-wrap">
          <v-tooltip :text="t('room.invite')" location="bottom">
            <template #activator="{ props: tp }">
              <v-btn icon="mdi-account-plus" size="small" variant="text" color="primary" v-bind="tp" @click="copyInvite" />
            </template>
          </v-tooltip>
          <Transition name="fade">
            <span v-if="showCopied" class="copied-tip">{{ t('room.copied') }}</span>
          </Transition>
        </div>

        <v-spacer />

        <!-- Chair-only: close room for everyone -->
        <v-tooltip v-if="roomStore.isChair" :text="t('chair.close_room_tooltip')" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn icon="mdi-stop-circle-outline" size="small" variant="text" color="error" v-bind="tp" @click="showEndConfirm = true" />
          </template>
        </v-tooltip>

        <!-- Leave room (only self) -->
        <v-tooltip :text="t('room.leave_room')" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn icon="mdi-exit-to-app" size="small" variant="text" v-bind="tp" @click="showSwitchConfirm = true" />
          </template>
        </v-tooltip>

        <!-- Language switcher (top-right) -->
        <LanguageSwitcher :size="isMobile ? 'x-small' : 'small'" />

        <!-- Mobile sidebar toggle -->
        <v-tooltip v-if="isMobile" :text="t('room.menu')" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn icon="mdi-menu" size="small" variant="text" v-bind="tp" @click="sidebarOpen = !sidebarOpen" />
          </template>
        </v-tooltip>
      </header>

      <!-- BODY -->
      <div class="room-body">
        <!-- Sidebar: member list -->
        <aside
          class="room-sidebar"
          :class="{ 'sidebar-open': sidebarOpen }"
        >
          <!-- Mobile close button -->
          <v-btn
            v-if="isMobile"
            icon="mdi-close"
            size="x-small"
            variant="text"
            class="sidebar-close-btn"
            @click="sidebarOpen = false"
          />
          <div class="sidebar-header">
            <span class="sidebar-title">{{ t('room.members_count', { count: roomStore.members.length }) }}</span>
          </div>
          <MemberList
            :members="roomStore.members"
            :chair-id="roomStore.chairId"
            :client-id="roomStore.clientId"
            :is-chair="roomStore.isChair"
            @kick="onKickRequest"
            @open-room-config="onOpenRoomConfig"
          />
        </aside>

        <!-- Main: messages + editor -->
        <div class="room-main">
          <div v-if="!showForward" ref="msgListEl" class="msg-list">
            <MessageItem
              v-for="(m, i) in msgStore.messages"
              :key="m.id"
              :message="m"
              :client-id="roomStore.clientId"
              :failed="msgStore.failedIds.has(m.id)"
              :catchup="msgStore.catchupIds.has(m.id)"
              :reconnecting="roomStore.reconnecting"
              :show-header="shouldShowHeader(msgStore.messages, i)"
              @resend="resendMessage($event)"
              @download-file="onDownloadFile"
              @view-file="onViewFile"
              @join-voice="onJoinVoiceFromBubble"
              @open-room-config="onOpenRoomConfig"
            />
          </div>

          <ForwardPanel
            v-else
            :messages="msgStore.messages"
            :client-id="roomStore.clientId"
            @forward="onForwardSend"
            @cancel="showForward = false"
          />

          <input
            v-if="!showForward"
            ref="fileInput"
            type="file"
            style="display: none"
            @change="onFilePicked"
          />

          <!-- Hidden audio sinks for remote voice streams -->
          <div class="voice-audio-host" aria-hidden="true">
            <audio
              v-for="[id, stream] in voiceStore.remoteStreams"
              :key="id"
              :ref="(el) => { if (el) (el as HTMLAudioElement).srcObject = stream }"
              autoplay
              playsinline
            />
          </div>

          <RichEditor
            v-if="!showForward"
            :disabled="roomStore.reconnecting"
            :members="roomStore.members"
            :client-id="roomStore.clientId"
            @send="onSend"
          >
            <template #action-bar>
              <v-tooltip :text="t('forward.tooltip')" location="top">
                <template #activator="{ props: tp }">
                  <v-btn
                    icon="mdi-share"
                    size="x-small"
                    variant="text"
                    v-bind="tp"
                    @click="showForward = !showForward"
                  />
                </template>
              </v-tooltip>
              <v-tooltip :text="t('file.attach_tooltip')" location="top">
                <template #activator="{ props: tp }">
                  <v-btn
                    icon="mdi-paperclip"
                    size="x-small"
                    variant="text"
                    :disabled="roomStore.reconnecting"
                    v-bind="tp"
                    @click="onAttachClick"
                  />
                </template>
              </v-tooltip>
              <!-- Voice chat (phone icon = real entry) -->
              <v-tooltip
                :text="voiceStore.inVoice
                  ? t('voice.leave')
                  : (voiceStore.activeSessionId ? t('voice.busy') : t('voice.start'))"
                location="top"
              >
                <template #activator="{ props: tp }">
                  <v-btn
                    :icon="voiceStore.inVoice ? 'mdi-phone-in-talk' : 'mdi-phone'"
                    size="x-small"
                    variant="text"
                    :color="voiceStore.inVoice ? 'success' : undefined"
                    :disabled="voiceCtrlDisabled"
                    v-bind="tp"
                    @click="onToggleVoice"
                  />
                </template>
              </v-tooltip>
              <!-- Video call: not implemented yet -->
              <v-tooltip :text="`${t('common.video')} · ${t('common.coming_soon')}`" location="top">
                <template #activator="{ props: tp }">
                  <v-btn icon="mdi-video" size="x-small" variant="text" v-bind="tp" />
                </template>
              </v-tooltip>
              <!-- Voice message (push-to-talk style): not implemented yet -->
              <v-tooltip :text="`${t('common.voice_message')} · ${t('common.coming_soon')}`" location="top">
                <template #activator="{ props: tp }">
                  <v-btn icon="mdi-microphone" size="x-small" variant="text" v-bind="tp" />
                </template>
              </v-tooltip>
              <!-- Document / Whiteboard / Map: not implemented yet.
                   Desktop shows the tooltip on hover; mobile taps the button. -->
              <v-tooltip :text="`${t('common.document')} · ${t('common.coming_soon')}`" location="top">
                <template #activator="{ props: tp }">
                  <v-btn icon="mdi-file-document-outline" size="x-small" variant="text" v-bind="tp" @click="onComingSoon(t('common.document'))" />
                </template>
              </v-tooltip>
              <v-tooltip :text="`${t('common.canvas')} · ${t('common.coming_soon')}`" location="top">
                <template #activator="{ props: tp }">
                  <v-btn icon="mdi-palette-outline" size="x-small" variant="text" v-bind="tp" @click="onComingSoon(t('common.canvas'))" />
                </template>
              </v-tooltip>
              <v-tooltip :text="`${t('common.map')} · ${t('common.coming_soon')}`" location="top">
                <template #activator="{ props: tp }">
                  <v-btn icon="mdi-map-outline" size="x-small" variant="text" v-bind="tp" @click="onComingSoon(t('common.map'))" />
                </template>
              </v-tooltip>
              <v-tooltip
                v-if="voiceStore.inVoice"
                :text="voiceStore.muted ? t('voice.unmute') : t('voice.mute')"
                location="top"
              >
                <template #activator="{ props: tp }">
                  <v-btn
                    :icon="voiceStore.muted ? 'mdi-volume-off' : 'mdi-volume-high'"
                    size="x-small"
                    variant="text"
                    :color="voiceStore.muted ? 'warning' : undefined"
                    v-bind="tp"
                    @click="toggleMute"
                  />
                </template>
              </v-tooltip>
            </template>
          </RichEditor>
        </div>
      </div>

      <!-- Privacy bar -->
      <footer class="privacy-bar">
        <v-icon size="13" :style="{ verticalAlign: 'middle', marginRight: '4px', color: privacyColor }">{{ privacyIcon }}</v-icon>
        <span :style="{ color: privacyColor }">{{ privacyText }}</span>
      </footer>

      <!-- ═══ DIALOGS ════════════════════════════════════════ -->

      <!-- Connection detail panel -->
      <v-dialog v-model="showConnDetail" max-width="460">
        <v-card id="conn-detail-panel" color="surface">
          <v-card-title class="d-flex align-center gap-2">
            <v-icon :style="{ color: connStore.color }">{{ connStore.icon }}</v-icon>
            {{ t('conn.' + connStore.state) }}
          </v-card-title>
          <v-card-text>
            {{ connStore.techMode ? t('conn.' + connStore.state + '_tech') : t('conn.' + connStore.state) }}
          </v-card-text>

          <!-- TURN server settings -->
          <v-divider />
          <v-card-text>
            <div class="text-caption mb-2" style="color: var(--dc-gray); text-transform: uppercase; letter-spacing: .05em">{{ t('conn.turn_server') }}</div>

            <!-- Metered.ca built-in option -->
            <template v-if="turnStore.meteredEnabled && !turnStore.useCustom">
              <v-switch
                v-model="turnStore.useMetered"
                :label="t('conn.turn_metered')"
                density="compact"
                hide-details
                color="primary"
                class="mb-2"
              />
            </template>

            <!-- No custom: show server default info -->
            <template v-if="!turnStore.useCustom && !turnStore.useMetered">
              <div v-if="turnStore.serverUrl" class="text-body-2 mb-1">
                <v-icon size="14" class="mr-1" color="success">mdi-check-circle-outline</v-icon>
                {{ turnStore.serverUrl }}
                <span class="text-caption ml-1" style="color: var(--dc-gray)">{{ t('conn.turn_auto_creds') }}</span>
              </div>
              <div v-else class="text-body-2 mb-1" style="color: var(--dc-gray)">
                <v-icon size="14" class="mr-1">mdi-information-outline</v-icon>
                {{ t('conn.turn_none') }}
              </div>
            </template>

            <!-- Custom TURN fields -->
            <template v-if="turnStore.useCustom">
              <v-switch
                v-model="turnStore.useCustom"
                :label="t('conn.turn_custom')"
                density="compact"
                hide-details
                color="primary"
                class="mb-2"
              />
              <v-text-field
                v-model="turnStore.customUrl"
                :label="t('conn.turn_url')"
                :placeholder="turnStore.serverUrl || 'turn:your-server.com:3478'"
                density="compact"
                hide-details
                class="mt-3 mb-3"
              />
              <v-text-field
                v-model="turnStore.customUsername"
                :label="t('conn.turn_username')"
                density="compact"
                hide-details
                class="mb-3"
              />
              <v-text-field
                v-model="turnStore.customCredential"
                :label="t('conn.turn_credential')"
                type="password"
                density="compact"
                hide-details
                class="mb-3"
              />
              <div class="text-caption mt-2" style="color: var(--dc-gray)">{{ t('conn.turn_apply_hint') }}</div>
            </template>

            <v-switch
              v-if="!turnStore.useCustom"
              v-model="turnStore.useCustom"
              :label="t('conn.turn_custom')"
              density="compact"
              hide-details
              color="primary"
              class="mt-2"
            />
          </v-card-text>

          <v-divider />
          <v-card-text>
            <v-switch
              v-model="connStore.techMode"
              :label="t('conn.tech_mode_label')"
              density="compact"
              hide-details
              color="primary"
            />
          </v-card-text>
          <v-card-actions class="justify-end">
            <v-btn variant="text" @click="showConnDetail = false">{{ t('common.close') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- WS Relay confirmation (blocking) -->
      <v-dialog v-model="showRelayConfirm" persistent max-width="480">
        <v-card color="surface">
          <v-card-title class="d-flex align-center gap-2">
            <v-icon color="warning">mdi-server-network</v-icon>
            {{ t('conn.relay_confirm_title') }}
          </v-card-title>
          <v-card-text style="white-space: pre-line">
            {{ connStore.techMode ? t('conn.relay_confirm_body_tech') : t('conn.relay_confirm_body') }}
          </v-card-text>
          <v-card-text class="text-caption">
            <v-switch
              v-model="connStore.techMode"
              :label="t('conn.tech_mode_label')"
              density="compact"
              hide-details
              color="primary"
            />
          </v-card-text>
          <v-card-actions class="justify-end gap-2">
            <v-btn variant="text" @click="declineRelay">{{ t('conn.relay_confirm_cancel') }}</v-btn>
            <v-btn color="warning" @click="showRelayConfirm = false; confirmRelay(true)">{{ t('conn.relay_confirm_ok') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Kick confirm -->
      <v-dialog v-model="showKickConfirm" max-width="380">
        <v-card color="surface">
          <v-card-text>
            {{ t('chair.kick_confirm', { name: kickTarget?.nickname ?? '' }) }}
          </v-card-text>
          <v-card-actions class="justify-end gap-2">
            <v-btn variant="text" @click="showKickConfirm = false">{{ t('common.cancel') }}</v-btn>
            <v-btn color="error" @click="confirmKick">{{ t('chair.remove_btn') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- End room confirm -->
      <v-dialog v-model="showEndConfirm" max-width="400">
        <v-card color="surface">
          <v-card-text>{{ t('chair.end_confirm') }}</v-card-text>
          <v-card-actions class="justify-end gap-2">
            <v-btn variant="text" @click="showEndConfirm = false">{{ t('common.cancel') }}</v-btn>
            <v-btn color="error" @click="confirmEndRoom">{{ t('chair.close_room_btn') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Room ended by chair -->
      <v-dialog v-model="showRoomEndedDialog" persistent max-width="400">
        <v-card color="surface" class="text-center">
          <v-card-title class="justify-center">
            <v-icon color="warning" class="mr-1">mdi-ghost</v-icon>DarkenChat
          </v-card-title>
          <v-card-text>{{ t('system.room_ended') }}</v-card-text>
          <v-card-actions class="justify-center">
            <v-btn color="primary" @click="dismissRoomEnded">{{ t('common.ok') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Kicked notice -->
      <v-dialog v-model="showKickedDialog" persistent max-width="400">
        <v-card color="surface" class="text-center">
          <v-card-title class="justify-center">
            <v-icon color="warning" class="mr-1">mdi-ghost</v-icon>DarkenChat
          </v-card-title>
          <v-card-text>{{ t('chair.kicked_notice') }}</v-card-text>
          <v-card-actions class="justify-center">
            <v-btn color="primary" @click="dismissKicked">{{ t('common.ok') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Leave room confirm -->
      <v-dialog v-model="showSwitchConfirm" max-width="420">
        <v-card color="surface">
          <v-card-text>
            <v-icon color="warning" class="mr-1">mdi-alert</v-icon>{{ t('room.switch_warning', { key: roomKey }) }}
          </v-card-text>
          <v-card-actions class="justify-end gap-2">
            <v-btn variant="text" @click="showSwitchConfirm = false">{{ t('common.cancel') }}</v-btn>
            <v-btn color="warning" @click="leave(); router.push('/')">{{ t('room.leave_room_btn') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- QR code popup -->
      <v-dialog v-model="showQR" max-width="300">
        <v-card color="surface">
          <v-card-text class="text-caption text-center" style="color: var(--dc-gold)">{{ t('room.copied') }}</v-card-text>
          <v-card-text class="d-flex justify-center">
            <img :src="qrDataUrl" width="220" height="220" style="border-radius: 10px; display:block" />
          </v-card-text>
          <v-card-actions class="justify-center">
            <v-btn variant="text" size="small" @click="showQR = false">{{ t('common.close') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Room AI config: per-room hard turn cap for bot members -->
      <v-dialog v-model="showRoomConfig" max-width="420">
        <v-card color="surface">
          <v-card-title class="d-flex align-center gap-2">
            <v-icon color="primary">mdi-cog-outline</v-icon>
            {{ t('room_config.title') }}
          </v-card-title>
          <v-card-text>
            <v-text-field
              v-model.number="roomConfigInput"
              type="number"
              min="0"
              step="1"
              :disabled="!roomStore.isChair"
              :label="t('room_config.ai_turn_limit_label')"
              :hint="t('room_config.ai_turn_limit_hint')"
              persistent-hint
              density="compact"
            />
            <div v-if="!roomStore.isChair" class="text-caption mt-2" style="color: var(--dc-gray)">
              <v-icon size="14" class="mr-1">mdi-information-outline</v-icon>
              {{ t('room_config.chair_only') }}
            </div>
          </v-card-text>
          <v-card-actions class="justify-end gap-2">
            <v-btn variant="text" @click="showRoomConfig = false">{{ t('common.cancel') }}</v-btn>
            <v-btn color="primary" :disabled="!roomStore.isChair" @click="onSaveRoomConfig">{{ t('room_config.save') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Reconnecting snackbar -->
      <v-snackbar
        v-model="snackbar.show"
        :color="snackbar.color"
        location="top"
        timeout="-1"
      >
        {{ snackbar.text }}
      </v-snackbar>
    </template>
  </div>
</template>

<style scoped>
.room-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

/* ── Pre-join ─────────────────────────────────────────── */
.prejoin-overlay {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.prejoin-card {
  background: var(--dc-panel);
  border-radius: 20px;
  padding: 40px 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  min-width: 300px;
  max-width: 380px;
  width: 100%;
}
.prejoin-logo {
  font-size: 1.4rem;
  display: flex;
  align-items: center;
  gap: 8px;
}
.prejoin-appname {
  font-weight: 700;
  color: var(--dc-gold);
  letter-spacing: 0.04em;
}
.prejoin-room {
  font-size: 2rem;
  font-weight: 700;
  color: var(--dc-gold);
  letter-spacing: 0.15em;
}
.prejoin-nick-row {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
}

/* ── Room ─────────────────────────────────────────────── */
.room-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--dc-panel);
  border-bottom: 1px solid #2a2a2a;
  flex-shrink: 0;
  min-height: 48px;
}
.app-logo-icon { font-size: 1.3rem; }
.room-key {
  font-weight: 700;
  font-size: 1rem;
  color: var(--dc-gold);
  letter-spacing: 0.1em;
}
.invite-wrap { position: relative; display: flex; align-items: center; }
.copied-tip {
  position: absolute;
  left: calc(100% + 8px);
  white-space: nowrap;
  background: var(--dc-teal);
  color: #fff;
  font-size: 0.76rem;
  padding: 2px 10px;
  border-radius: 20px;
  pointer-events: none;
}
.room-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}
.room-sidebar {
  width: 200px;
  min-width: 160px;
  background: var(--dc-panel);
  border-right: 1px solid #2a2a2a;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  position: relative;
}
.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #2a2a2a;
}
.sidebar-title {
  font-size: 0.78rem;
  color: var(--dc-gray);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.room-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.msg-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

/* Mobile sidebar overlay */
@media (max-width: 767px) {
  .room-sidebar {
    position: fixed;
    right: 0;
    top: 0;
    bottom: 0;
    z-index: 100;
    transform: translateX(100%);
    transition: transform 0.2s ease;
    width: 240px;
    border-right: none;
    border-left: 1px solid #2a2a2a;
    box-shadow: -4px 0 20px rgba(0,0,0,0.4);
  }
  .room-sidebar.sidebar-open { transform: translateX(0); }
}

/* Fade */
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* Sidebar close btn (mobile) */
.sidebar-close-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 1;
}

/* Connection dialog switch label spacing */
#conn-detail-panel :deep(.v-switch) .v-label {
  margin-left: 12px;
}

.voice-audio-host { display: none; }
</style>

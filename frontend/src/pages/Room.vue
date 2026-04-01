<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClipboard } from '@vueuse/core'
import QRCode from 'qrcode'

import { useRoom } from '@/composables/useRoom'
import { useNotification } from '@/composables/useNotification'
import { useRoomStore } from '@/stores/room'
import { useMessagesStore } from '@/stores/messages'
import { useConnectionStore } from '@/stores/connection'
import { useTurnStore } from '@/stores/turn'
import type { Message, MemberInfo } from '@/types'

import MemberList from '@/components/MemberList.vue'
import MessageItem from '@/components/MessageItem.vue'
import RichEditor from '@/components/RichEditor.vue'
import ForwardPanel from '@/components/ForwardPanel.vue'

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

const { join, leave, sendMessage, sendForward, resendMessage, confirmRelay, signaling } = useRoom((e: { event: string }) => {
  if (e.event === 'kicked')            { showKickedDialog.value = true }
  if (e.event === 'room_ended')        { showRoomEndedDialog.value = true }
  if (e.event === 'room_banned')       { showSnackbar(t('error.room_banned'), 'error') }
  if (e.event === 'connection_failed') { connectionFailed.value = true }
  if (e.event === 'relay_request')     { showRelayConfirm.value = true }
  if (e.event === 'relay_active') {
    // Relay became active from incoming message — show non-blocking toast
    showSnackbar(
      connStore.techMode ? t('conn.relay_toast_tech') : t('conn.relay_toast'),
      'warning',
      6000,
    )
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
          <v-btn icon="mdi-account-plus" size="small" variant="text" color="primary" @click="copyInvite" />
          <Transition name="fade">
            <span v-if="showCopied" class="copied-tip">{{ t('room.copied') }}</span>
          </Transition>
        </div>

        <v-spacer />

        <!-- Chair-only: close room for everyone -->
        <v-tooltip v-if="roomStore.isChair" text="Close Room for Everyone" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn icon="mdi-stop-circle-outline" size="small" variant="text" color="error" v-bind="tp" @click="showEndConfirm = true" />
          </template>
        </v-tooltip>

        <!-- Leave room (only self) -->
        <v-tooltip text="Leave Room" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn icon="mdi-exit-to-app" size="small" variant="text" v-bind="tp" @click="showSwitchConfirm = true" />
          </template>
        </v-tooltip>

        <!-- Mobile sidebar toggle -->
        <v-btn v-if="isMobile" icon="mdi-menu" size="small" variant="text" @click="sidebarOpen = !sidebarOpen" />
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
            <span class="sidebar-title">Members ({{ roomStore.members.length }})</span>
          </div>
          <MemberList
            :members="roomStore.members"
            :chair-id="roomStore.chairId"
            :client-id="roomStore.clientId"
            :is-chair="roomStore.isChair"
            @kick="onKickRequest"
          />
        </aside>

        <!-- Main: messages + editor -->
        <div class="room-main">
          <div v-if="!showForward" ref="msgListEl" class="msg-list">
            <MessageItem
              v-for="m in msgStore.messages"
              :key="m.id"
              :message="m"
              :client-id="roomStore.clientId"
              :failed="msgStore.failedIds.has(m.id)"
              :catchup="msgStore.catchupIds.has(m.id)"
              :reconnecting="roomStore.reconnecting"
              @resend="resendMessage($event)"
            />
          </div>

          <ForwardPanel
            v-else
            :messages="msgStore.messages"
            :client-id="roomStore.clientId"
            @forward="onForwardSend"
            @cancel="showForward = false"
          />

          <!-- Action bar -->
          <div v-if="!showForward" class="action-bar">
            <v-tooltip text="Forward messages" location="top">
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
            <v-tooltip text="Coming soon" location="top">
              <template #activator="{ props: tp }">
                <v-btn icon="mdi-phone" size="x-small" variant="text" v-bind="tp" />
              </template>
            </v-tooltip>
            <v-tooltip text="Coming soon" location="top">
              <template #activator="{ props: tp }">
                <v-btn icon="mdi-video" size="x-small" variant="text" v-bind="tp" />
              </template>
            </v-tooltip>
            <v-tooltip text="Coming soon" location="top">
              <template #activator="{ props: tp }">
                <v-btn icon="mdi-microphone" size="x-small" variant="text" v-bind="tp" />
              </template>
            </v-tooltip>
          </div>

          <RichEditor v-if="!showForward" :disabled="roomStore.reconnecting" @send="onSend" />
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
        <v-card color="surface">
          <v-card-title class="pt-5 px-6 d-flex align-center gap-2">
            <v-icon :style="{ color: connStore.color }">{{ connStore.icon }}</v-icon>
            {{ t('conn.' + connStore.state) }}
          </v-card-title>
          <v-card-text class="px-6 pb-1">
            {{ connStore.techMode ? t('conn.' + connStore.state + '_tech') : t('conn.' + connStore.state) }}
          </v-card-text>

          <!-- TURN server settings -->
          <v-divider class="mx-6 mt-3" />
          <v-card-text class="px-6 pt-3 pb-1">
            <div class="text-caption mb-2" style="color: var(--dc-gray); text-transform: uppercase; letter-spacing: .05em">TURN Server</div>

            <!-- Metered.ca built-in option -->
            <template v-if="turnStore.meteredEnabled && !turnStore.useCustom">
              <v-switch
                v-model="turnStore.useMetered"
                label="Use built-in TURN (Metered.ca)"
                density="compact"
                hide-details
                color="primary"
                class="mb-3"
              />
            </template>

            <!-- No custom: show server default info -->
            <template v-if="!turnStore.useCustom && !turnStore.useMetered">
              <div v-if="turnStore.serverUrl" class="text-body-2 mb-1">
                <v-icon size="14" class="mr-1" color="success">mdi-check-circle-outline</v-icon>
                {{ turnStore.serverUrl }}
                <span class="text-caption ml-1" style="color: var(--dc-gray)">(auto credentials)</span>
              </div>
              <div v-else class="text-body-2 mb-1" style="color: var(--dc-gray)">
                <v-icon size="14" class="mr-1">mdi-information-outline</v-icon>
                No default TURN configured
              </div>
            </template>

            <!-- Custom TURN fields -->
            <template v-if="turnStore.useCustom">
              <v-text-field
                v-model="turnStore.customUrl"
                label="TURN URL"
                :placeholder="turnStore.serverUrl || 'turn:your-server.com:3478'"
                density="compact"
                hide-details
                class="mb-3"
              />
              <div class="d-flex gap-2">
                <v-text-field
                  v-model="turnStore.customUsername"
                  label="Username"
                  density="compact"
                  hide-details
                  style="flex: 1"
                />
                <v-text-field
                  v-model="turnStore.customCredential"
                  label="Credential"
                  type="password"
                  density="compact"
                  hide-details
                  style="flex: 1"
                />
              </div>
              <div class="text-caption mt-3" style="color: var(--dc-gray)">Changes apply when joining the next room.</div>
            </template>

            <v-switch
              v-model="turnStore.useCustom"
              label="Use custom TURN server"
              density="compact"
              hide-details
              color="primary"
              class="mt-4"
            />
          </v-card-text>

          <v-divider class="mx-6 mt-2" />
          <v-card-text class="px-6 pt-3 pb-4">
            <v-switch
              v-model="connStore.techMode"
              :label="t('conn.tech_mode_label')"
              density="compact"
              hide-details
              color="primary"
            />
          </v-card-text>
          <v-card-actions class="justify-end px-6 pb-5">
            <v-btn variant="text" @click="showConnDetail = false">{{ t('forward.cancel') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- WS Relay confirmation (blocking) -->
      <v-dialog v-model="showRelayConfirm" persistent max-width="480">
        <v-card color="surface">
          <v-card-title class="pt-6 px-6 d-flex align-center gap-2">
            <v-icon color="warning">mdi-server-network</v-icon>
            {{ t('conn.relay_confirm_title') }}
          </v-card-title>
          <v-card-text class="px-6 pb-2" style="white-space: pre-line">
            {{ connStore.techMode ? t('conn.relay_confirm_body_tech') : t('conn.relay_confirm_body') }}
          </v-card-text>
          <v-card-text class="px-6 pt-0 pb-3 text-caption">
            <v-switch
              v-model="connStore.techMode"
              :label="t('conn.tech_mode_label')"
              density="compact"
              hide-details
              color="primary"
            />
          </v-card-text>
          <v-card-actions class="justify-end gap-2 pb-5 px-6">
            <v-btn variant="text" @click="showRelayConfirm = false; confirmRelay(false)">{{ t('conn.relay_confirm_cancel') }}</v-btn>
            <v-btn color="warning" @click="showRelayConfirm = false; confirmRelay(true)">{{ t('conn.relay_confirm_ok') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Kick confirm -->
      <v-dialog v-model="showKickConfirm" max-width="380">
        <v-card color="surface">
          <v-card-text class="pt-4">
            {{ t('chair.kick_confirm', { name: kickTarget?.nickname ?? '' }) }}
          </v-card-text>
          <v-card-actions class="justify-end gap-2 pb-4 px-4">
            <v-btn variant="text" @click="showKickConfirm = false">{{ t('forward.cancel') }}</v-btn>
            <v-btn color="error" @click="confirmKick">Remove</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- End room confirm -->
      <v-dialog v-model="showEndConfirm" max-width="400">
        <v-card color="surface">
          <v-card-text class="pt-6 px-6">{{ t('chair.end_confirm') }}</v-card-text>
          <v-card-actions class="justify-end gap-2 pb-5 px-6">
            <v-btn variant="text" @click="showEndConfirm = false">{{ t('forward.cancel') }}</v-btn>
            <v-btn color="error" @click="confirmEndRoom">Close for Everyone</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Room ended by chair -->
      <v-dialog v-model="showRoomEndedDialog" persistent max-width="400">
        <v-card color="surface" class="text-center pa-8">
          <div class="text-h5 mb-2"><v-icon color="warning" class="mr-1">mdi-ghost</v-icon>DarkenChat</div>
          <div class="mb-6">{{ t('system.room_ended') }}</div>
          <v-btn color="primary" @click="dismissRoomEnded">OK</v-btn>
        </v-card>
      </v-dialog>

      <!-- Kicked notice -->
      <v-dialog v-model="showKickedDialog" persistent max-width="400">
        <v-card color="surface" class="text-center pa-8">
          <div class="text-h5 mb-2"><v-icon color="warning" class="mr-1">mdi-ghost</v-icon>DarkenChat</div>
          <div class="mb-6">{{ t('chair.kicked_notice') }}</div>
          <v-btn color="primary" @click="dismissKicked">OK</v-btn>
        </v-card>
      </v-dialog>

      <!-- Leave room confirm -->
      <v-dialog v-model="showSwitchConfirm" max-width="420">
        <v-card color="surface">
          <v-card-text class="pt-6 px-6">
            <v-icon color="warning" class="mr-1">mdi-alert</v-icon>{{ t('room.switch_warning', { key: roomKey }) }}
          </v-card-text>
          <v-card-actions class="justify-end gap-2 pb-5 px-6">
            <v-btn variant="text" @click="showSwitchConfirm = false">{{ t('forward.cancel') }}</v-btn>
            <v-btn color="warning" @click="leave(); router.push('/')">Leave Room</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- QR code popup -->
      <v-dialog v-model="showQR" max-width="300">
        <v-card color="surface" class="pa-6">
          <div class="text-caption text-center mb-4" style="color: var(--dc-gold)">{{ t('room.copied') }}</div>
          <div class="d-flex justify-center">
            <img :src="qrDataUrl" width="220" height="220" style="border-radius: 10px; display:block" />
          </div>
          <div class="d-flex justify-center mt-4">
            <v-btn variant="text" size="small" @click="showQR = false">{{ t('forward.cancel') }}</v-btn>
          </div>
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
    transition: transform 0.25s ease;
    width: 240px;
    border-right: none;
    border-left: 1px solid #2a2a2a;
    box-shadow: -4px 0 20px rgba(0,0,0,0.4);
  }
  .room-sidebar.sidebar-open { transform: translateX(0); }
}

/* Fade */
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* Action bar */
.action-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 8px;
  border-top: 1px solid #2a2a2a;
  background: var(--dc-panel);
  flex-shrink: 0;
}

/* Sidebar close btn (mobile) */
.sidebar-close-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 1;
}
</style>

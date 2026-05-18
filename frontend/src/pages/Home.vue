<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { getRandomNickname, getRandomSeriesKey } from '@/assets/nicknames'
import { useRoomStore } from '@/stores/room'
import LanguageSwitcher from '@/components/LanguageSwitcher.vue'

const { t } = useI18n()
const router = useRouter()
const roomStore = useRoomStore()

const joinKey = ref('')
const joinError = ref('')
const creating = ref(false)
const seriesKey = getRandomSeriesKey()
const leftHovered = ref(false)
const rightHovered = ref(false)

// Hover helpers — extracted so the multi-statement template expressions
// survive Prettier (Vue's template parser does NOT do ASI between
// statements, and Prettier strips the explicit `;` when it wraps).
function hoverSide(side: 'left' | 'right' | null) {
  leftHovered.value = side === 'left'
  rightHovered.value = side === 'right'
}
const nickname = ref('')

onMounted(() => {
  nickname.value = roomStore.pendingNickname || getRandomNickname(seriesKey)
  roomStore.pendingNickname = nickname.value
})

function randomize() {
  nickname.value = getRandomNickname(seriesKey)
  roomStore.pendingNickname = nickname.value
}

function onNicknameInput(v: string) {
  roomStore.pendingNickname = v
}

async function createRoom() {
  const nick = nickname.value.trim() || getRandomNickname(seriesKey)
  roomStore.pendingNickname = nick
  creating.value = true
  try {
    const res = await fetch('/api/rooms', { method: 'POST' })
    const data = await res.json()
    router.push(`/r/${data.key}`)
  } finally {
    creating.value = false
  }
}

function enterRoom() {
  const key = joinKey.value.trim().toUpperCase()
  if (key.length === 0) {
    joinError.value = t('home.key_required')
    return
  }
  const nick = nickname.value.trim() || getRandomNickname(seriesKey)
  roomStore.pendingNickname = nick
  joinError.value = ''
  router.push(`/r/${key}`)
}
</script>

<template>
  <div class="home-layout">
    <!-- Language switcher (top-right) -->
    <div class="lang-corner">
      <LanguageSwitcher size="small" />
    </div>

    <!-- Left side: Create -->
    <div
      class="side left-side"
      :class="{ hovered: leftHovered }"
      @mouseenter="hoverSide('left')"
      @mouseleave="hoverSide(null)"
      @click="createRoom">
      <div class="side-content">
        <div class="icon-circle"><v-icon size="28" color="#1A1A1A">mdi-plus</v-icon></div>
        <span class="side-text">{{ t('home.create_as', { nick: nickname || '…' }) }}</span>
      </div>
    </div>

    <!-- Diagonal divider -->
    <div class="divider-wrapper">
      <div class="divider-line" :class="{ 'left-active': leftHovered, 'right-active': rightHovered }"></div>
    </div>

    <!-- Nickname input (centered, works on both desktop and mobile) -->
    <div class="nickname-float">
      <v-text-field
        v-model="nickname"
        :label="t('home.nickname_label')"
        maxlength="24"
        density="compact"
        hide-details
        class="nick-input"
        @update:model-value="onNicknameInput" />
      <v-btn icon="mdi-dice-multiple" variant="text" size="x-small" :title="t('home.randomize')" @click="randomize" />
    </div>

    <!-- Right side: Join -->
    <div
      class="side right-side"
      :class="{ hovered: rightHovered }"
      @mouseenter="hoverSide('right')"
      @mouseleave="hoverSide(null)"
      @click="enterRoom">
      <div class="side-content right-content">
        <span class="side-text">{{ t('home.join') }}</span>
        <v-text-field
          v-model="joinKey"
          :placeholder="t('home.join_placeholder')"
          :error-messages="joinError"
          maxlength="20"
          class="side-input"
          hide-details
          @input="joinKey = joinKey.toUpperCase()"
          @keyup.enter.stop="enterRoom"
          @click.stop />
        <span class="side-text">as {{ nickname || '…' }}</span>
        <div class="icon-circle right-icon"><v-icon size="28" color="#1A1A1A">mdi-arrow-right</v-icon></div>
      </div>
    </div>

    <!-- Mobile 60deg diagonal divider -->
    <div class="mobile-divider"></div>

    <!-- Bottom bar -->
    <footer class="privacy-bar">
      <v-icon size="13" style="vertical-align: middle; margin-right: 4px">mdi-lock</v-icon>
      {{ t('app.privacy') }}
    </footer>
  </div>
</template>

<style scoped>
.home-layout {
  position: relative;
  width: 100vw;
  height: 100%;
  background: var(--dc-bg);
  overflow: hidden;
  display: flex;
}

/* Language switcher in top-right */
.lang-corner {
  position: fixed;
  top: 8px;
  right: 12px;
  z-index: 200;
  background: rgba(36, 36, 36, 0.72);
  border-radius: 999px;
  backdrop-filter: blur(6px);
}
@media (max-width: 480px) {
  .lang-corner {
    top: 6px;
    right: 8px;
  }
}

/* Side panels */
.side {
  position: absolute;
  top: 0;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

/* Hover gradient overlay — opacity fades smoothly, unlike background-image */
.side::before {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 0.15s ease-out;
  pointer-events: none;
  z-index: 0;
}

.side.hovered::before {
  opacity: 1;
}

.side.hovered {
  z-index: 10;
}

.left-side {
  left: 0;
  width: 100vw;
  padding-right: 50vw;
  background: linear-gradient(135deg, rgba(26, 26, 26, 0.3) 0%, rgba(26, 26, 26, 0.1) 100%);
  clip-path: polygon(0 0, calc(50vw + 28.87vh) 0, calc(50vw - 28.87vh) 100%, 0 100%);
}

.left-side::before {
  background: linear-gradient(135deg, rgba(201, 168, 76, 0.18) 0%, rgba(201, 168, 76, 0.06) 100%);
}

.left-side.hovered {
  /* glow handled by ::before gradient; drop-shadow removed to avoid banded halos around icons */
}

.right-side {
  left: 0;
  right: auto;
  width: 100vw;
  padding-left: 50vw;
  background: linear-gradient(225deg, rgba(26, 26, 26, 0.3) 0%, rgba(26, 26, 26, 0.1) 100%);
  clip-path: polygon(calc(50vw + 28.87vh) 0, 100vw 0, 100vw 100%, calc(50vw - 28.87vh) 100%);
}

.right-side::before {
  background: linear-gradient(225deg, rgba(91, 141, 184, 0.18) 0%, rgba(91, 141, 184, 0.06) 100%);
}

.right-side.hovered {
  /* glow handled by ::before gradient; drop-shadow removed to avoid banded halos around icons */
}

/* Icon circle */
.icon-circle {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--dc-gold);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #1a1a1a;
  box-shadow: 0 2px 10px rgba(201, 168, 76, 0.3);
  transition:
    transform 0.15s ease-out,
    box-shadow 0.15s ease-out;
  flex-shrink: 0;
}

.side.hovered .icon-circle {
  transform: scale(1.12);
  box-shadow: 0 2px 14px rgba(201, 168, 76, 0.45);
}

.right-icon {
  background: var(--dc-blue);
  box-shadow: 0 2px 10px rgba(91, 141, 184, 0.3);
}

.right-side.hovered .right-icon {
  box-shadow: 0 2px 14px rgba(91, 141, 184, 0.45);
}

/* Side content */
.side-content {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 40px;
  opacity: 0.4;
  transition:
    opacity 0.15s ease-out,
    transform 0.15s ease-out;
}

/* Offset content toward the center of each diagonal triangle */
.left-side .side-content {
  transform: translateY(-10vh);
}
.right-side .side-content {
  transform: translateY(10vh);
}

.left-side.hovered .side-content {
  opacity: 1;
  transform: translateY(calc(-10vh - 8px)) scale(1.06);
}

.right-side.hovered .side-content {
  opacity: 1;
  transform: translateY(calc(10vh - 8px)) scale(1.06);
}

.side-text {
  font-size: 1rem;
  color: var(--dc-gray);
  transition: color 0.15s ease-out;
  white-space: nowrap;
}

.side.hovered .side-text {
  color: var(--dc-text);
}

.right-content {
  gap: 12px;
}

.side-input {
  width: 100px;
}

/* Diagonal divider */
.divider-wrapper {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) rotate(30deg);
  z-index: 5;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.divider-line {
  width: 3px;
  height: 80vh;
  background: linear-gradient(
    to bottom,
    transparent 0%,
    var(--dc-gray) 20%,
    var(--dc-gold) 50%,
    var(--dc-gray) 80%,
    transparent 100%
  );
  opacity: 0.3;
  transition:
    opacity 0.15s ease-out,
    box-shadow 0.15s ease-out,
    background 0.15s ease-out;
  border-radius: 2px;
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}

.divider-line.left-active {
  background: linear-gradient(
    to bottom,
    transparent 0%,
    rgba(201, 168, 76, 0.3) 20%,
    var(--dc-gold) 50%,
    rgba(201, 168, 76, 0.3) 80%,
    transparent 100%
  );
  opacity: 0.9;
  box-shadow: 0 0 25px rgba(201, 168, 76, 0.5);
}

.divider-line.right-active {
  background: linear-gradient(
    to bottom,
    transparent 0%,
    rgba(91, 141, 184, 0.3) 20%,
    var(--dc-blue) 50%,
    rgba(91, 141, 184, 0.3) 80%,
    transparent 100%
  );
  opacity: 0.9;
  box-shadow: 0 0 25px rgba(91, 141, 184, 0.5);
}

.nickname-float {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--dc-panel);
  padding: 8px 16px;
  border-radius: 24px;
  border: 1px solid rgba(201, 168, 76, 0.2);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  transition:
    border-color 0.15s ease-out,
    box-shadow 0.15s ease-out;
  pointer-events: auto;
  white-space: nowrap;
}

.nickname-float:hover {
  border-color: rgba(201, 168, 76, 0.5);
  box-shadow: 0 4px 30px rgba(201, 168, 76, 0.25);
}

.nick-input {
  width: 140px;
}

.nick-input :deep(.v-field) {
  background: transparent;
}

/* Mobile 60deg divider */
.mobile-divider {
  display: none;
}

/* Privacy bar */
.privacy-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 0.7rem;
  color: var(--dc-gray);
  padding: 8px 16px;
  background: rgba(26, 26, 26, 0.95);
  border-top: 1px solid #2a2a2a;
  letter-spacing: 0.02em;
  z-index: 100;
  backdrop-filter: blur(10px);
}

/* Mobile: top/bottom split with 60deg diagonal divider */
@media (max-width: 768px) {
  .side {
    width: 100vw;
    height: 100vh;
    top: 0;
  }

  .left-side {
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    padding-right: 0;
    padding-bottom: 50vh;
    background: linear-gradient(180deg, rgba(26, 26, 26, 0.3) 0%, rgba(26, 26, 26, 0.1) 100%);
    clip-path: polygon(0 0, 100vw 0, 100vw calc(50vh - 28.87vw), 0 calc(50vh + 28.87vw));
  }

  .left-side::before {
    background: linear-gradient(180deg, rgba(201, 168, 76, 0.18) 0%, rgba(201, 168, 76, 0.06) 100%);
  }

  .right-side {
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    padding-left: 0;
    padding-top: 50vh;
    background: linear-gradient(0deg, rgba(26, 26, 26, 0.3) 0%, rgba(26, 26, 26, 0.1) 100%);
    clip-path: polygon(0 calc(50vh + 28.87vw), 100vw calc(50vh - 28.87vw), 100vw 100vh, 0 100vh);
  }

  .right-side::before {
    background: linear-gradient(0deg, rgba(91, 141, 184, 0.18) 0%, rgba(91, 141, 184, 0.06) 100%);
  }

  .divider-wrapper {
    display: none;
  }

  .mobile-divider {
    display: block;
    position: absolute;
    left: 50%;
    top: 50%;
    width: 4px;
    height: 120%;
    background: linear-gradient(
      to bottom,
      transparent 0%,
      rgba(201, 168, 76, 0.4) 30%,
      var(--dc-gold) 50%,
      rgba(91, 141, 184, 0.4) 70%,
      transparent 100%
    );
    transform: translate(-50%, -50%) rotate(60deg);
    opacity: 0.6;
    z-index: 5;
  }

  .side-content {
    flex-direction: row;
    gap: 10px;
    padding: 16px;
  }

  /* Mobile: content already lives in its triangle via padding; reset desktop translateY */
  .left-side .side-content,
  .right-side .side-content {
    transform: none;
  }

  .left-side.hovered .side-content,
  .right-side.hovered .side-content {
    transform: translateY(-6px) scale(1.04);
  }

  .side-text {
    font-size: 0.85rem;
  }

  .icon-circle {
    width: 48px;
    height: 48px;
    font-size: 1.5rem;
  }

  .nickname-float {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 50;
  }
}

@media (max-width: 480px) {
  .side-content {
    gap: 6px;
    padding: 12px;
  }

  .icon-circle {
    width: 40px;
    height: 40px;
    font-size: 1.2rem;
  }

  .side-text {
    font-size: 0.75rem;
  }

  .side-input {
    width: 70px;
  }
}
</style>

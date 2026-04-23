<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { getRandomNickname, getRandomSeriesKey } from '@/assets/nicknames'
import { useRoomStore } from '@/stores/room'

const { t } = useI18n()
const router = useRouter()
const roomStore = useRoomStore()

const joinKey = ref('')
const joinError = ref('')
const creating = ref(false)
const seriesKey = getRandomSeriesKey()
const leftHovered = ref(false)
const rightHovered = ref(false)
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
  if (key.length === 0) { joinError.value = t('home.key_required'); return }
  const nick = nickname.value.trim() || getRandomNickname(seriesKey)
  roomStore.pendingNickname = nick
  joinError.value = ''
  router.push(`/r/${key}`)
}
</script>

<template>
  <div class="home-layout">
    <!-- Left side: Create -->
    <div
      class="side left-side"
      :class="{ hovered: leftHovered }"
      @mouseenter="leftHovered = true; rightHovered = false"
      @mouseleave="leftHovered = false"
      @click="createRoom"
    >
      <div class="side-content">
        <div class="icon-circle">+</div>
        <span class="side-text">{{ t('home.create_as', { nick: nickname || '…' }) }}</span>
      </div>
    </div>

    <!-- Diagonal divider with nickname input -->
    <div class="divider-wrapper">
      <div class="divider-line" :class="{ 'left-active': leftHovered, 'right-active': rightHovered }"></div>
      <div class="nickname-float">
        <v-text-field
          v-model="nickname"
          :label="t('home.nickname_label')"
          maxlength="24"
          density="compact"
          hide-details
          class="nick-input"
          @update:model-value="onNicknameInput"
        />
        <v-btn icon="mdi-dice-multiple" variant="text" size="x-small" :title="t('home.randomize')" @click="randomize" />
      </div>
    </div>

    <!-- Right side: Join -->
    <div
      class="side right-side"
      :class="{ hovered: rightHovered }"
      @mouseenter="rightHovered = true; leftHovered = false"
      @mouseleave="rightHovered = false"
      @click="enterRoom"
    >
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
          @click.stop
        />
        <span class="side-text">as {{ nickname || '…' }}</span>
        <div class="icon-circle right-icon">→</div>
      </div>
    </div>

    <!-- Mobile 60deg diagonal divider -->
    <div class="mobile-divider"></div>

    <!-- Bottom bar -->
    <footer class="privacy-bar">
      <v-icon size="13" style="vertical-align:middle;margin-right:4px">mdi-lock</v-icon>{{ t('app.privacy') }}
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

/* Side panels */
.side {
  position: absolute;
  top: 0;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  cursor: pointer;
}

.left-side {
  left: 0;
  width: 50%;
  background: linear-gradient(135deg, rgba(26,26,26,0.3) 0%, rgba(26,26,26,0.1) 100%);
}

.left-side.hovered {
  background: linear-gradient(135deg, rgba(201,168,76,0.18) 0%, rgba(201,168,76,0.06) 100%);
  box-shadow: 0 0 100px rgba(201,168,76,0.35), 0 0 200px rgba(201,168,76,0.15);
  transform: translateY(-12px) scale(1.03);
  z-index: 10;
}

.right-side {
  right: 0;
  width: 50%;
  background: linear-gradient(225deg, rgba(26,26,26,0.3) 0%, rgba(26,26,26,0.1) 100%);
}

.right-side.hovered {
  background: linear-gradient(225deg, rgba(91,141,184,0.18) 0%, rgba(91,141,184,0.06) 100%);
  box-shadow: 0 0 100px rgba(91,141,184,0.35), 0 0 200px rgba(91,141,184,0.15);
  transform: translateY(-12px) scale(1.03);
  z-index: 10;
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
  font-size: 1.8rem;
  font-weight: 400;
  color: #1A1A1A;
  box-shadow: 0 0 30px rgba(201,168,76,0.5);
  transition: all 0.4s ease;
  flex-shrink: 0;
}

.side.hovered .icon-circle {
  transform: scale(1.15);
  box-shadow: 0 0 50px rgba(201,168,76,0.8);
}

.right-icon {
  background: var(--dc-blue);
  box-shadow: 0 0 30px rgba(91,141,184,0.5);
}

.right-side.hovered .right-icon {
  box-shadow: 0 0 50px rgba(91,141,184,0.8);
}

/* Side content */
.side-content {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 40px;
  opacity: 0.4;
  transition: all 0.4s ease;
}

.side.hovered .side-content {
  opacity: 1;
  transform: scale(1.05);
}

.side-text {
  font-size: 1rem;
  color: var(--dc-gray);
  transition: all 0.3s ease;
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
  transition: all 0.4s ease;
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
    rgba(201,168,76,0.3) 20%,
    var(--dc-gold) 50%,
    rgba(201,168,76,0.3) 80%,
    transparent 100%
  );
  opacity: 0.9;
  box-shadow: 0 0 25px rgba(201,168,76,0.5);
}

.divider-line.right-active {
  background: linear-gradient(
    to bottom,
    transparent 0%,
    rgba(91,141,184,0.3) 20%,
    var(--dc-blue) 50%,
    rgba(91,141,184,0.3) 80%,
    transparent 100%
  );
  opacity: 0.9;
  box-shadow: 0 0 25px rgba(91,141,184,0.5);
}

.nickname-float {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) rotate(-30deg);
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--dc-panel);
  padding: 8px 16px;
  border-radius: 24px;
  border: 1px solid rgba(201,168,76,0.2);
  box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  transition: all 0.3s ease;
  pointer-events: auto;
  white-space: nowrap;
}

.nickname-float:hover {
  border-color: rgba(201,168,76,0.5);
  box-shadow: 0 4px 30px rgba(201,168,76,0.25);
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
  background: rgba(26,26,26,0.95);
  border-top: 1px solid #2a2a2a;
  letter-spacing: 0.02em;
  z-index: 100;
  backdrop-filter: blur(10px);
}

/* Mobile: top/bottom split with 60deg diagonal divider */
@media (max-width: 768px) {
  .side {
    width: 100%;
    height: 50%;
  }

  .left-side {
    top: 0;
    background: linear-gradient(180deg, rgba(26,26,26,0.3) 0%, rgba(26,26,26,0.1) 100%);
  }

  .left-side.hovered {
    background: linear-gradient(180deg, rgba(201,168,76,0.18) 0%, rgba(201,168,76,0.06) 100%);
  }

  .right-side {
    top: 50%;
    background: linear-gradient(0deg, rgba(26,26,26,0.3) 0%, rgba(26,26,26,0.1) 100%);
  }

  .right-side.hovered {
    background: linear-gradient(0deg, rgba(91,141,184,0.18) 0%, rgba(91,141,184,0.06) 100%);
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
      rgba(201,168,76,0.4) 30%,
      var(--dc-gold) 50%,
      rgba(91,141,184,0.4) 70%,
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
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

// Use pending nickname from store, or generate a fresh random one
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
    <header class="home-header">
      <v-icon color="warning" size="36" class="app-logo">mdi-ghost</v-icon>
      <span class="app-name">DarkenChat</span>
    </header>

    <!-- Nickname row -->
    <div class="nick-row">
      <v-text-field
        v-model="nickname"
        :label="t('home.nickname_label')"
        maxlength="24"
        density="compact"
        hide-details
        style="flex: 1; min-width: 0"
        @update:model-value="onNicknameInput"
      />
      <v-btn icon="mdi-dice-multiple" variant="text" size="small" :title="t('home.randomize')" @click="randomize" />
    </div>

    <main class="home-main">
      <!-- Left: Create -->
      <div class="home-card">
        <v-btn
          color="primary"
          size="large"
          :loading="creating"
          prepend-icon="mdi-plus-circle"
          @click="createRoom"
        >
          {{ t('home.create_as', { nick: nickname || '…' }) }}
        </v-btn>
      </div>

      <div class="home-divider">
        <span>{{ t('home.or') }}</span>
      </div>

      <!-- Right: Join -->
      <div class="home-card">
        <v-text-field
          v-model="joinKey"
          :placeholder="t('home.join_placeholder')"
          :error-messages="joinError"
          maxlength="20"
          style="width: 200px"
          @input="joinKey = joinKey.toUpperCase()"
          @keyup.enter="enterRoom"
        />
        <v-btn
          color="primary"
          append-icon="mdi-arrow-right"
          @click="enterRoom"
        >
          {{ t('home.join_as', { nick: nickname || '…' }) }}
        </v-btn>
      </div>
    </main>

    <footer class="privacy-bar">
      <v-icon size="13" style="vertical-align:middle;margin-right:4px">mdi-lock</v-icon>{{ t('app.privacy') }}
    </footer>
  </div>
</template>

<style scoped>
.home-layout {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 0;
}
.home-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 28px;
}
.app-logo { flex-shrink: 0; }
.app-name {
  font-size: 1.8rem;
  font-weight: 700;
  color: var(--dc-gold);
  letter-spacing: 0.04em;
}
.nick-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 28px;
  width: 100%;
  max-width: 320px;
}
.nick-row :deep(.v-field) {
  min-width: 200px;
}
.home-main {
  display: flex;
  align-items: center;
  gap: 32px;
  flex-wrap: wrap;
  justify-content: center;
}
.home-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  background: var(--dc-panel);
  border-radius: 16px;
  padding: 32px 40px;
  min-width: 220px;
}
.home-divider {
  color: var(--dc-gray);
  font-size: 0.9rem;
  padding: 0 8px;
}
</style>

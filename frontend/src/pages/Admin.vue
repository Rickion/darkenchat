<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import LanguageSwitcher from '@/components/LanguageSwitcher.vue'

const { t } = useI18n()

const TOKEN_KEY = 'dc_admin_token'

const token = ref(sessionStorage.getItem(TOKEN_KEY) ?? '')
const authed = ref(false)
const tokenInput = ref('')
const tokenError = ref('')

const rooms = ref<any[]>([])
const logs = ref<any[]>([])
const bans = ref<any[]>([])

const tab = ref('rooms')

async function login() {
  const res = await fetch('/api/admin/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tokenInput.value }),
  })
  if (res.ok) {
    token.value = tokenInput.value
    sessionStorage.setItem(TOKEN_KEY, token.value)
    authed.value = true
    await loadAll()
  } else {
    tokenError.value = t('admin.token_invalid')
  }
}

async function loadAll() {
  const headers = { 'x-admin-token': token.value }
  const [r1, r2, r3] = await Promise.all([
    fetch('/api/admin/rooms', { headers }).then(r => r.json()),
    fetch('/api/admin/logs', { headers }).then(r => r.json()),
    fetch('/api/admin/bans', { headers }).then(r => r.json()),
  ])
  rooms.value = r1.rooms ?? []
  logs.value = r2.logs ?? []
  bans.value = r3.bans ?? []
}

async function dissolveRoom(key: string) {
  await fetch(`/api/admin/rooms/${key}`, {
    method: 'DELETE',
    headers: { 'x-admin-token': token.value },
  })
  await loadAll()
}

async function unban(type: 'ip' | 'key', value: string) {
  await fetch(`/api/admin/bans/${type}/${encodeURIComponent(value)}`, {
    method: 'DELETE',
    headers: { 'x-admin-token': token.value },
  })
  await loadAll()
}

onMounted(async () => {
  if (token.value) {
    const res = await fetch('/api/admin/rooms', { headers: { 'x-admin-token': token.value } })
    if (res.ok) { authed.value = true; await loadAll() }
  }
})
</script>

<template>
  <div class="admin-layout">
    <!-- Token gate -->
    <div v-if="!authed" class="token-gate">
      <div class="token-card">
        <div class="text-h6 mb-4 d-flex align-center">
          <v-icon color="warning" class="mr-2">mdi-ghost</v-icon>{{ t('admin.title') }}
        </div>
        <v-text-field
          v-model="tokenInput"
          :label="t('admin.token_label')"
          type="password"
          :error-messages="tokenError"
          @keyup.enter="login"
        />
        <v-btn color="primary" block @click="login">{{ t('admin.enter') }}</v-btn>
      </div>
    </div>

    <!-- Admin dashboard -->
    <div v-else class="admin-content">
      <div class="admin-header">
        <span class="text-h6 d-flex align-center">
          <v-icon color="warning" class="mr-2">mdi-ghost</v-icon>{{ t('admin.title') }}
        </span>
        <v-spacer />
        <LanguageSwitcher size="small" />
        <v-btn icon="mdi-refresh" size="small" variant="text" @click="loadAll" />
      </div>

      <v-tabs v-model="tab" color="primary">
        <v-tab value="rooms">{{ t('admin.rooms_title') }}</v-tab>
        <v-tab value="logs">{{ t('admin.logs_title') }}</v-tab>
        <v-tab value="bans">{{ t('admin.ban_title') }}</v-tab>
      </v-tabs>

      <div class="admin-tab-body">
        <!-- Rooms -->
        <div v-if="tab === 'rooms'">
          <v-table density="compact" theme="dark">
            <thead>
              <tr>
                <th>{{ t('admin.col_key') }}</th>
                <th>{{ t('admin.col_created') }}</th>
                <th>{{ t('admin.col_status') }}</th>
                <th>{{ t('admin.col_action') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rooms" :key="r.key">
                <td><code>{{ r.key }}</code></td>
                <td>{{ dayjs(r.createdAt).format('MM-DD HH:mm') }}</td>
                <td>
                  <v-chip :color="r.banned ? 'error' : 'success'" size="x-small">
                    {{ r.banned ? t('admin.status_banned') : t('admin.status_active') }}
                  </v-chip>
                </td>
                <td>
                  <v-btn icon="mdi-stop" size="x-small" variant="text" color="error" @click="dissolveRoom(r.key)" />
                </td>
              </tr>
            </tbody>
          </v-table>
        </div>

        <!-- Logs -->
        <div v-if="tab === 'logs'">
          <v-table density="compact" theme="dark">
            <thead>
              <tr>
                <th>{{ t('admin.col_ip') }}</th>
                <th>{{ t('admin.col_time') }}</th>
                <th>{{ t('admin.col_to_key') }}</th>
                <th>{{ t('admin.col_action_type') }}</th>
                <th>{{ t('admin.col_blocked') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(l, i) in logs" :key="i" :class="{ 'blocked-row': l.blocked }">
                <td>{{ l.ip }}</td>
                <td>{{ dayjs(l.timestamp).format('HH:mm:ss') }}</td>
                <td><code>{{ l.toKey }}</code></td>
                <td>{{ l.action }}</td>
                <td><v-icon v-if="l.blocked" color="error" size="small">mdi-block-helper</v-icon></td>
              </tr>
            </tbody>
          </v-table>
        </div>

        <!-- Bans -->
        <div v-if="tab === 'bans'">
          <v-list bg-color="transparent">
            <v-list-subheader>{{ t('admin.ips') }}</v-list-subheader>
            <v-list-item v-for="b in bans.filter(b => b.type === 'ip')" :key="b.value">
              <v-list-item-title>{{ b.value }}</v-list-item-title>
              <template #append>
                <v-btn size="x-small" variant="text" color="warning" @click="unban('ip', b.value)">{{ t('admin.unban') }}</v-btn>
              </template>
            </v-list-item>
            <v-list-subheader>{{ t('admin.room_keys') }}</v-list-subheader>
            <v-list-item v-for="b in bans.filter(b => b.type === 'key')" :key="b.value">
              <v-list-item-title><code>{{ b.value }}</code></v-list-item-title>
              <template #append>
                <v-btn size="x-small" variant="text" color="warning" @click="unban('key', b.value)">{{ t('admin.unban') }}</v-btn>
              </template>
            </v-list-item>
          </v-list>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.admin-layout { height: 100%; overflow: auto; background: var(--dc-bg); }
.token-gate {
  display: flex; align-items: center; justify-content: center;
  height: 100%;
}
.token-card {
  background: var(--dc-panel);
  padding: 40px;
  border-radius: 16px;
  width: 360px;
}
.admin-content { max-width: 1000px; margin: 0 auto; padding: 24px; }
.admin-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 20px;
}
.admin-tab-body { margin-top: 16px; overflow: auto; }
.blocked-row { background: rgba(166, 60, 60, 0.1); }
code { color: var(--dc-gold); font-size: 0.85rem; }
</style>

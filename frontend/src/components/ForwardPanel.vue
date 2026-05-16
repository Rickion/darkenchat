<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Message } from '@/types'
import MessageItem from './MessageItem.vue'

const { t } = useI18n()

const props = defineProps<{
  messages: Message[]
  clientId: string
}>()

const emit = defineEmits<{
  forward: [msgs: Message[], note: string]
  cancel: []
}>()

const selected = ref<Set<string>>(new Set())
const note = ref('')

const allSelected = computed(() =>
  props.messages.length > 0 && selected.value.size === props.messages.length
)

function toggleAll() {
  if (allSelected.value) {
    selected.value.clear()
  } else {
    props.messages.forEach(m => selected.value.add(m.id))
  }
}

function toggleOne(id: string) {
  if (selected.value.has(id)) selected.value.delete(id)
  else selected.value.add(id)
}

function confirm() {
  const msgs = props.messages.filter(m => selected.value.has(m.id))
  if (msgs.length === 0) return
  emit('forward', msgs, note.value.trim())
}
</script>

<template>
  <div class="forward-panel">
    <!-- Top bar -->
    <div class="forward-bar">
      <v-checkbox
        :model-value="allSelected"
        hide-details
        density="compact"
        :label="t('forward.select_all')"
        @update:model-value="toggleAll"
      />
      <span class="count">{{ t('forward.count_selected', { count: selected.size }) }}</span>
      <v-spacer />
      <v-text-field
        v-model="note"
        :placeholder="t('forward.note_placeholder')"
        density="compact"
        variant="outlined"
        hide-details
        style="max-width: 260px"
      />
      <v-btn icon="mdi-check" color="primary" size="small" :disabled="selected.size === 0" @click="confirm" />
      <v-btn icon="mdi-close" size="small" variant="text" @click="emit('cancel')" />
    </div>

    <!-- Message list with checkboxes -->
    <div class="forward-list">
      <MessageItem
        v-for="m in messages"
        :key="m.id"
        :message="m"
        :client-id="clientId"
        :select-mode="true"
        :selected="selected.has(m.id)"
        @toggle="toggleOne"
      />
    </div>
  </div>
</template>

<style scoped>
.forward-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.forward-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--dc-panel);
  border-bottom: 1px solid #333;
  flex-shrink: 0;
}
.count {
  font-size: 0.82rem;
  color: var(--dc-gray);
  white-space: nowrap;
}
.forward-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
</style>

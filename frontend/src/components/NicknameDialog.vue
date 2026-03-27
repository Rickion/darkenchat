<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getRandomNickname } from '@/assets/nicknames'

const { t } = useI18n()

const props = defineProps<{
  modelValue: boolean
  seriesKey: string
  usedNames?: string[]
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  enter: [nickname: string]
}>()

const nickname = ref('')

watch(() => props.modelValue, (open) => {
  if (open) randomize()
})

function randomize() {
  nickname.value = getRandomNickname(props.seriesKey, props.usedNames ?? [])
}

function confirm() {
  const n = nickname.value.trim() || getRandomNickname(props.seriesKey, props.usedNames ?? [])
  emit('enter', n)
  emit('update:modelValue', false)
}
</script>

<template>
  <v-dialog :model-value="modelValue" persistent max-width="400">
    <v-card color="surface" class="pa-6">
      <v-card-title class="text-h6 pb-2">
        {{ t('nickname.title') }}
      </v-card-title>
      <v-card-text>
        <div class="d-flex align-center gap-2">
          <v-text-field
            v-model="nickname"
            :label="t('room.nickname_label')"
            :hint="t('room.nickname_hint')"
            maxlength="24"
            autofocus
            @keyup.enter="confirm"
          />
          <v-btn icon="mdi-dice-multiple" variant="text" @click="randomize" />
        </div>
      </v-card-text>
      <v-card-actions class="justify-end">
        <v-btn color="primary" :disabled="!nickname.trim()" @click="confirm">
          {{ t('nickname.enter') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

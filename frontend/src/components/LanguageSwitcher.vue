<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { SUPPORTED_LOCALES, setLocale } from '@/i18n'

const props = defineProps<{
  size?: 'x-small' | 'small' | 'default'
}>()

const { t, locale } = useI18n()

const btnSize = computed(() => props.size ?? 'small')

function pick(code: 'en' | 'zh') {
  setLocale(code)
}
</script>

<template>
  <v-menu location="bottom end">
    <template #activator="{ props: ap }">
      <v-tooltip :text="t('common.language')" location="bottom">
        <template #activator="{ props: tp }">
          <v-btn icon="mdi-translate" :size="btnSize" variant="text" class="lang-btn" v-bind="{ ...ap, ...tp }" />
        </template>
      </v-tooltip>
    </template>
    <v-list density="compact" min-width="140" class="lang-menu">
      <v-list-item
        v-for="l in SUPPORTED_LOCALES"
        :key="l.code"
        :active="locale === l.code"
        @click="pick(l.code as 'en' | 'zh')">
        <v-list-item-title>{{ t(l.labelKey) }}</v-list-item-title>
      </v-list-item>
    </v-list>
  </v-menu>
</template>

<style scoped>
.lang-btn {
  flex-shrink: 0;
}
@media (max-width: 480px) {
  .lang-btn :deep(.v-icon) {
    font-size: 18px;
  }
}
</style>

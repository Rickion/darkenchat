<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  size?: 'x-small' | 'small' | 'default'
}>()

const btnSize = computed(() => props.size ?? 'small')

const REPO_URL = 'https://github.com/Rickion/darkenchat'
</script>

<template>
  <v-tooltip text="GitHub" location="bottom">
    <template #activator="{ props: tp }">
      <v-btn
        icon="mdi-github"
        :size="btnSize"
        variant="text"
        :href="REPO_URL"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="GitHub"
        class="github-btn"
        v-bind="tp" />
    </template>
  </v-tooltip>
</template>

<style scoped>
.github-btn {
  flex-shrink: 0;
}
@media (max-width: 480px) {
  .github-btn :deep(.v-icon) {
    font-size: 18px;
  }
}
</style>

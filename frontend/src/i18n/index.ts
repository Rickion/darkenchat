import { createI18n } from 'vue-i18n'
import en from './en.json'
import zh from './zh.json'

const LOCALE_KEY = 'dc_locale'

function detectInitialLocale(): 'en' | 'zh' {
  try {
    const saved = localStorage.getItem(LOCALE_KEY)
    if (saved === 'en' || saved === 'zh') return saved
  } catch {
    /* storage unavailable */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : ''
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export const i18n = createI18n({
  legacy: false,
  locale: detectInitialLocale(),
  fallbackLocale: 'en',
  messages: { en, zh },
})

export const SUPPORTED_LOCALES = [
  { code: 'en', labelKey: 'common.language_en' },
  { code: 'zh', labelKey: 'common.language_zh' },
] as const

export function setLocale(code: 'en' | 'zh') {
  i18n.global.locale.value = code
  try {
    localStorage.setItem(LOCALE_KEY, code)
  } catch {
    /* ignore */
  }
}

import { createVuetify } from 'vuetify'
import { aliases, mdi } from 'vuetify/iconsets/mdi'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'

export const vuetify = createVuetify({
  theme: {
    defaultTheme: 'darkenchat',
    themes: {
      darkenchat: {
        dark: true,
        colors: {
          background:  '#1A1A1A',
          surface:     '#242424',
          primary:     '#C9A84C',
          secondary:   '#6B6B6B',
          warning:     '#C4784A',
          error:       '#A63C3C',
          success:     '#4A9B8E',
          info:        '#5B8DB8',
          'on-background': '#E8E3D9',
          'on-surface':    '#E8E3D9',
        },
      },
    },
  },
  icons: {
    defaultSet: 'mdi',
    aliases,
    sets: { mdi },
  },
  defaults: {
    VBtn: { variant: 'flat', rounded: 'lg' },
    VCard: { rounded: 'lg', elevation: 0 },
    VTextField: { variant: 'outlined', density: 'comfortable', rounded: 'lg' },
    VDialog: { maxWidth: 480 },
  },
})

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { vuetify } from './plugins/vuetify'
import { i18n } from './i18n'
import router from './plugins/router'
import App from './App.vue'
import './style.css'

createApp(App).use(createPinia()).use(vuetify).use(i18n).use(router).mount('#app')

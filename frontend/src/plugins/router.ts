import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/',         name: 'home',  component: () => import('@/pages/Home.vue') },
    { path: '/r/:key',   name: 'room',  component: () => import('@/pages/Room.vue') },
    { path: '/admin',    name: 'admin', component: () => import('@/pages/Admin.vue') },
  ],
})

export default router

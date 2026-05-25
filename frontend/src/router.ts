import { createRouter, createWebHistory } from 'vue-router'
import Home from '@/views/Home.vue'
import History from '@/views/History.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/history', name: 'history', component: History },
  ],
})

export default router

// Router-Konfiguration gemäß PLAN §8, erweitert um Auth-Routen.
//
// Auth-Guards:
//   - /login ist IMMER erreichbar
//   - alle anderen Routen erfordern eine aktive Session (JWT im localStorage)
//   - Admin-Routen benötigen zusätzlich Rolle=admin
//   - Wenn der Server nachweislich KEINEN User hat (auth.serverHatUser
//     === false), wird jede Navigation auf /login gezwungen — die
//     LoginView schaltet dann inline in den Setup-Modus. Wichtig: nur
//     reagieren wenn der State DEFINITIV false ist, nicht bei null
//     (offline/unknown), damit Offline-Login nicht in den Setup-Modus
//     rutscht.

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'

import DashboardView from '../views/DashboardView.vue'
import ArtikelListView from '../views/ArtikelListView.vue'
import ArtikelFormView from '../views/ArtikelFormView.vue'
import ArtikelDetailView from '../views/ArtikelDetailView.vue'
import BuchungListView from '../views/BuchungListView.vue'
import BuchungFormView from '../views/BuchungFormView.vue'
import KommissionView from '../views/KommissionView.vue'
import StandortListView from '../views/StandortListView.vue'
import SettingsView from '../views/SettingsView.vue'
import ImportView from '../views/ImportView.vue'
import LoginView from '../views/LoginView.vue'
import PasswortAendernView from '../views/PasswortAendernView.vue'
import UserVerwaltungView from '../views/UserVerwaltungView.vue'
import BarcodeScanView from '../views/BarcodeScanView.vue'

const routes: RouteRecordRaw[] = [
  // Auth-Routen (kein Login nötig)
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  { path: '/passwort-aendern', name: 'passwort-aendern', component: PasswortAendernView },

  // Geschützte Routen
  { path: '/', name: 'dashboard', component: DashboardView },
  { path: '/artikel', name: 'artikel', component: ArtikelListView },
  { path: '/artikel/neu', name: 'artikel-neu', component: ArtikelFormView },
  {
    path: '/artikel/:id',
    name: 'artikel-detail',
    component: ArtikelDetailView,
    props: true,
  },
  { path: '/buchungen', name: 'buchungen', component: BuchungListView },
  { path: '/buchung/neu', name: 'buchung-neu', component: BuchungFormView },
  {
    path: '/kommission/:buchungId',
    name: 'kommission',
    component: KommissionView,
    props: true,
  },
  { path: '/standorte', name: 'standorte', component: StandortListView },
  { path: '/einstellungen', name: 'einstellungen', component: SettingsView },
  {
    path: '/einstellungen/user',
    name: 'einstellungen-user',
    component: UserVerwaltungView,
    meta: { requiresAdmin: true },
  },
  { path: '/import', name: 'import', component: ImportView },
  { path: '/scan', name: 'scan', component: BarcodeScanView },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  const isPublic = to.meta.public === true
  const requiresAdmin = to.meta.requiresAdmin === true

  // Server hat keinen User → erzwinge /login (zeigt Setup-Modus inline).
  // Greift nur bei DEFINITIVEM false, nicht bei null (offline/unknown).
  if (auth.serverHatUser === false && to.name !== 'login') {
    return { name: 'login' }
  }

  if (isPublic) return true
  if (!auth.istAngemeldet) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (requiresAdmin && !auth.istAdmin) {
    return { name: 'dashboard' }
  }
  return true
})

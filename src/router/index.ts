// Router-Konfiguration gemäß PLAN §8, erweitert um Auth-Routen.
//
// Auth-Guards:
//   - /login ist IMMER erreichbar
//   - alle anderen Routen erfordern eine aktive Session (JWT im localStorage)
//   - Admin-Routen benötigen zusätzlich die passende Berechtigung
//     (`meta.requiresPermission`) — die Rollen-Matrix liegt im Server,
//     der Client fragt die Rechte über den Auth-Store ab.
//   - Wenn der Server nachweislich KEINEN User hat (auth.serverHatUser
//     === false), wird jede Navigation auf /login gezwungen — die
//     LoginView schaltet dann inline in den Setup-Modus. Wichtig: nur
//     reagieren wenn der State DEFINITIV false ist, nicht bei null
//     (offline/unknown), damit Offline-Login nicht in den Setup-Modus
//     rutscht.

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useSettingsStore } from '../stores/settings'
import { istMobilLayout, sollMobilenScannerStarten } from '../services/layout'
import type { Permission } from '../domain/rollen'

declare module 'vue-router' {
  interface RouteMeta {
    /** Route ohne Login erreichbar. */
    public?: boolean
    /** Erforderliche Berechtigungen (alle müssen vorhanden sein). */
    requiresPermission?: Permission[]
  }
}

import DashboardView from '../views/DashboardView.vue'
import ArtikelListView from '../views/ArtikelListView.vue'
import ArtikelFormView from '../views/ArtikelFormView.vue'
import ArtikelDetailView from '../views/ArtikelDetailView.vue'
import BuchungListView from '../views/BuchungListView.vue'
import BuchungFormView from '../views/BuchungFormView.vue'
import KommissionView from '../views/KommissionView.vue'
import StandortListView from '../views/StandortListView.vue'
import SettingsView from '../views/SettingsView.vue'
import DevelopmentView from '../views/DevelopmentView.vue'
import UpdateHilfeView from '../views/UpdateHilfeView.vue'
import ArtikelTypenView from '../views/ArtikelTypenView.vue'
import AkkuTypenView from '../views/AkkuTypenView.vue'
import AkkutauschView from '../views/AkkutauschView.vue'
import KommissionenView from '../views/KommissionenView.vue'
import ArtikelKatalogeView from '../views/ArtikelKatalogeView.vue'
import ImportView from '../views/ImportView.vue'
import LoginView from '../views/LoginView.vue'
import PasswortAendernView from '../views/PasswortAendernView.vue'
import UserVerwaltungView from '../views/UserVerwaltungView.vue'
import RollenView from '../views/RollenView.vue'
import BarcodeScanView from '../views/BarcodeScanView.vue'
import BarcodeErzeugenView from '../views/BarcodeErzeugenView.vue'
import InfoView from '../views/InfoView.vue'
import MindestbestandPanelView from '../views/MindestbestandPanelView.vue'
import InventurView from '../views/InventurView.vue'
import BackupView from '../views/BackupView.vue'
import GeraetView from '../views/GeraetView.vue'
import ApiKeysView from '../views/ApiKeysView.vue'
import HerstellerView from '../views/HerstellerView.vue'

const routes: RouteRecordRaw[] = [
  // Auth-Routen (kein Login nötig)
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  { path: '/passwort-aendern', name: 'passwort-aendern', component: PasswortAendernView },

  // Geschützte Routen
  { path: '/', name: 'dashboard', component: DashboardView },
  { path: '/artikel', name: 'artikel', component: ArtikelListView },
  {
    // Neuen Artikel anlegen: Stammdaten-Pflege ist Lager-Sache
    // ('artikel.schreiben') — der Basis-User darf nur lesen.
    path: '/artikel/neu',
    name: 'artikel-neu',
    component: ArtikelFormView,
    meta: { requiresPermission: ['artikel.schreiben'] },
  },
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
  {
    // Standorte anlegen/umbenennen: das darf der Lagerist (Lager-Sache),
    // das Loeschen bleibt Admin-Sache.
    path: '/standorte',
    name: 'standorte',
    component: StandortListView,
    meta: { requiresPermission: ['standort.schreiben'] },
  },
  { path: '/einstellungen', name: 'einstellungen', component: SettingsView },
  {
    path: '/einstellungen/api-keys',
    name: 'einstellungen-api-keys',
    component: ApiKeysView,
    meta: { requiresPermission: ['apiKey.verwalten'] },
  },
  { path: '/info', name: 'info', component: InfoView },
  {
    path: '/einstellungen/user',
    name: 'einstellungen-user',
    component: UserVerwaltungView,
    meta: { requiresPermission: ['benutzer.verwalten'] },
  },
  {
    path: '/einstellungen/rollen',
    name: 'einstellungen-rollen',
    component: RollenView,
    meta: { requiresPermission: ['benutzer.verwalten'] },
  },
  {
    path: '/einstellungen/artikel-typen',
    name: 'einstellungen-artikel-typen',
    component: ArtikelTypenView,
    meta: { requiresPermission: ['stammdaten.verwalten'] },
  },
  {
    path: '/einstellungen/akku-typen',
    name: 'einstellungen-akku-typen',
    component: AkkuTypenView,
    meta: { requiresPermission: ['stammdaten.verwalten'] },
  },
  {
    path: '/einstellungen/kommissionen',
    name: 'einstellungen-kommissionen',
    component: KommissionenView,
    meta: { requiresPermission: ['stammdaten.verwalten'] },
  },
  {
    path: '/einstellungen/artikel-kataloge',
    name: 'einstellungen-artikel-kataloge',
    component: ArtikelKatalogeView,
  },
  {
    // The alarm log is tracking, not configuration: every role may follow
    // which items are under minimum stock, ordered and replenished again.
    // Writing (mindestbestand config) stays admin-only in the panel itself.
    path: '/einstellungen/mindestbestand',
    name: 'einstellungen-mindestbestand',
    component: MindestbestandPanelView,
  },
  {
    path: '/einstellungen/hersteller',
    name: 'einstellungen-hersteller',
    component: HerstellerView,
    meta: { requiresPermission: ['stammdaten.verwalten'] },
  },
  {
    // Inventur-Stichtag, Abschluss und Archiv. Jeder mit `inventur.lesen`
    // darf den Stand sehen; das Setzen des Stichtags braucht `inventur.stichtag`.
    path: '/einstellungen/inventur',
    name: 'einstellungen-inventur',
    component: InventurView,
    meta: { requiresPermission: ['inventur.lesen'] },
  },
  {
    path: '/einstellungen/backup',
    name: 'einstellungen-backup',
    component: BackupView,
    meta: { requiresPermission: ['backup.verwalten'] },
  },
  {
    // Device-local storage: reachable for every role. The local IndexedDB is
    // a disposable mirror — a user must always be able to rebuild it.
    path: '/einstellungen/geraet',
    name: 'einstellungen-geraet',
    component: GeraetView,
  },
  {
    path: '/einstellungen/entwicklung',
    name: 'einstellungen-entwicklung',
    component: DevelopmentView,
    meta: { requiresPermission: ['entwicklung'] },
  },
  {
    path: '/einstellungen/update-hilfe',
    name: 'einstellungen-update-hilfe',
    component: UpdateHilfeView,
    meta: { requiresPermission: ['entwicklung'] },
  },
  {
    path: '/import',
    name: 'import',
    component: ImportView,
    meta: { requiresPermission: ['import.fuehren'] },
  },
  { path: '/scan', name: 'scan', component: BarcodeScanView },
  {
    path: '/etiketten',
    name: 'etiketten',
    component: BarcodeErzeugenView,
  },
  { path: '/akkutausch', name: 'akkutausch', component: AkkutauschView },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  // Scroll-Position explizit und deterministisch: neuer Route -> nach oben,
  // Back/Forward -> gespeicherte Position. iOS stellt sonst seine eigene
  // Scroll-Restoration wieder her und der Layout wirkt nach einem
  // Bottom-Nav-Tap, als wuerde es springen.
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition ?? { top: 0 }
  },
})

// One-shot marker: only the first authenticated navigation (app boot or the
// redirect after login) may send mobile users to the scanner. Tapping the
// dashboard in the bottom nav afterwards must keep working normally.
let scannerStartErledigt = false

router.beforeEach((to) => {
  const auth = useAuthStore()
  const settings = useSettingsStore()
  const isPublic = to.meta.public === true
  const requiredPermissions = to.meta.requiresPermission ?? []

  if (!auth.istAngemeldet) scannerStartErledigt = false

  // Server hat keinen User → erzwinge /login (zeigt Setup-Modus inline).
  // Greift nur bei DEFINITIVEM false, nicht bei null (offline/unknown).
  if (auth.serverHatUser === false && to.name !== 'login') {
    return { name: 'login' }
  }

  if (isPublic) return true
  if (!auth.istAngemeldet) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  // Berechtigungs-Gate: die Route verlangt eine (oder mehrere) Berechtigungen.
  if (requiredPermissions.length > 0 && !requiredPermissions.every((p) => auth.hat(p))) {
    return { name: 'dashboard' }
  }

  // Akkutausch is opt-in. The App.vue watcher catches the case where the
  // setting finishes loading after this guard ran.
  if (
    settings.geladen &&
    !settings.settings.akkutauschAktiv &&
    (to.name === 'akkutausch' || to.name === 'einstellungen-akku-typen')
  ) {
    return { name: 'dashboard' }
  }

  if (
    sollMobilenScannerStarten({
      angemeldet: auth.istAngemeldet,
      bereitsGestartet: scannerStartErledigt,
      mobil: istMobilLayout(),
      routeName: to.name,
    })
  ) {
    scannerStartErledigt = true
    return { name: 'scan', replace: true }
  }
  scannerStartErledigt = true
  return true
})

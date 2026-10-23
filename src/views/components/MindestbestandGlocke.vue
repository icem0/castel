<script setup lang="ts">
// MindestbestandGlocke: Header-Indikator, der die Anzahl ungesehener
// Mindestbestand-Ereignisse anzeigt. Klick öffnet ein Drop-Down mit
// den letzten 50 Events; Klick auf einen Eintrag navigiert zum
// betroffenen Artikel. Beim Öffnen des Drop-Downs werden alle
// aktuellen Events als "gesehen" markiert (Counter → 0).
//
// Sichtbar nur für Admins — der Counter im Header ist uninteressant
// für normale User (User dürfen nicht stornieren, sie sehen den
// Bestand selbst in der Artikel-Detail-View). Die Route zum
// Panel-View (`/einstellungen/mindestbestand`) bleibt admin-only.

import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useMindestbestandStore } from '../../stores/mindestbestand'
import { useArtikelStore } from '../../stores/artikel'
import { useStandortStore } from '../../stores/standort'
import { useAuthStore } from '../../stores/auth'
import { useMindestbestandAlarm } from '../../composables/useMindestbestandAlarm'

const { t } = useI18n()
const router = useRouter()
const mindestbestand = useMindestbestandStore()
const artikelStore = useArtikelStore()
const standortStore = useStandortStore()
const auth = useAuthStore()
// The bell is the single owner of the repeat timer (the settings page
// mounts the same composable for its test button and must not double-ring).
const alarm = useMindestbestandAlarm({ wiederholung: true })

const offen = ref(false)
let documentClickListener: ((e: MouseEvent) => void) | null = null

function toggle(): void {
  offen.value = !offen.value
  if (offen.value) {
    void mindestbestand.markiereAlleGesehen()
  }
}

function close(): void {
  offen.value = false
}

function onDocumentClick(e: MouseEvent): void {
  if (!offen.value) return
  const ziel = e.target as HTMLElement | null
  if (ziel && !ziel.closest('.mindestbestand-indicator, .mindestbestand-dropdown')) {
    close()
  }
}

/**
 * Browser-Notification-Permission anfragen. Die Notification-API
 * feuert nur, solange die PWA im Vordergrund läuft — kein Service
 * Worker, kein Web-Push. Für ein Tablet im Lager, das immer offen
 * ist, reicht das; wer echte OS-Push-Notifications braucht, kann den
 * Schritt später nachrüsten (VAPID-Setup).
 *
 * Wird nur einmal pro Session beim ersten Mount der Glocke
 * angefragt. Wenn der User ablehnt, fragen wir nicht erneut
 * (Browser-seitiges Throttling).
 */
async function requestNotificationPermission(): Promise<void> {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'granted' || Notification.permission === 'denied') return
  try {
    await Notification.requestPermission()
  } catch {
    // bewusst ignorieren — der User kann später in den Browser-Settings
    // manuell aktivieren.
  }
}

onMounted(() => {
  mindestbestand.start()
  mindestbestand.startMarker()
  documentClickListener = onDocumentClick
  document.addEventListener('click', documentClickListener)
  // Permission nur anfragen, wenn die Glocke überhaupt gemountet wird
  // (= User ist Admin). Sonst würden wir den normalen User unnötig
  // belästigen.
  void requestNotificationPermission()
})

onBeforeUnmount(() => {
  mindestbestand.stop()
  mindestbestand.stopMarker()
  if (documentClickListener) {
    document.removeEventListener('click', documentClickListener)
    documentClickListener = null
  }
})

const isAdmin = computed(() => auth.rolle === 'admin')

// Anzahl kommt aus dem Alarm-Composable — dort ist der Trigger auch
// angesetzt, damit Zähler und Signal nie auseinanderlaufen.
const anzahl = alarm.anzahl
const liste = computed(() => mindestbestand.letzte50)

function artikelTitel(id: string): string {
  return artikelStore.byId(id)?.titel ?? '…'
}
function standortName(id: string): string {
  return standortStore.aktive.find((s) => s.id === id)?.name ?? '…'
}

function formatZeit(iso: string): string {
  const d = new Date(iso)
  const jetzt = Date.now()
  const diff = jetzt - d.getTime()
  if (diff < 60_000) return 'gerade eben'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} min`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} h`
  return d.toLocaleDateString()
}

function openArtikel(id: string): void {
  close()
  void router.push(`/artikel/${id}`)
}

function openPanel(): void {
  close()
  void router.push('/einstellungen/mindestbestand')
}
</script>

<template>
  <div v-if="isAdmin" class="mindestbestand-wrapper">
    <button
      type="button"
      class="mindestbestand-indicator"
      :class="{
        aktiv: offen,
        'hat-neu': anzahl > 0,
        'hat-glanz': alarm.blitzaktiv.value,
      }"
      :title="anzahl > 0 ? `${anzahl} neue Mindestbestand-Ereignisse` : 'Mindestbestand'"
      :aria-label="`Mindestbestand-Benachrichtigungen (${anzahl} neu)`"
      :aria-expanded="offen"
      @click.stop="toggle"
    >
      <span aria-hidden="true" class="mindestbestand-icon">🔔</span>
      <span v-if="anzahl > 0" class="mindestbestand-badge" :aria-label="`${anzahl} ungesehen`">
        {{ anzahl > 99 ? '99+' : anzahl }}
      </span>
    </button>
    <div
      v-if="offen"
      class="mindestbestand-dropdown"
      role="dialog"
      aria-label="Mindestbestand-Ereignisse"
    >
      <header class="mindestbestand-dropdown-head">
        <strong>{{ t('view.mindestbestand.title') }}</strong>
        <button type="button" class="link-btn" @click="openPanel">
          {{ t('view.mindestbestand.openPanel') }}
        </button>
      </header>
      <p v-if="liste.length === 0" class="mindestbestand-leer">
        {{ t('view.mindestbestand.empty') }}
      </p>
      <ul v-else class="mindestbestand-liste">
        <li v-for="ev in liste" :key="ev.id">
          <button type="button" class="mindestbestand-item" @click="openArtikel(ev.artikelId)">
            <span class="mindestbestand-item-titel">{{ artikelTitel(ev.artikelId) }}</span>
            <span class="mindestbestand-item-meta">
              {{ standortName(ev.standortId) }} ·
              {{
                t('view.mindestbestand.bestand', {
                  bestand: ev.bestandDanach,
                  mindest: ev.mindestbestand,
                })
              }}
            </span>
            <span class="mindestbestand-item-zeit">{{ formatZeit(ev.erstelltAm) }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.mindestbestand-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.mindestbestand-indicator {
  position: relative;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 0.4rem 0.5rem;
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  color: var(--text-strong);
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.mindestbestand-indicator:hover {
  background: var(--accent-bg, rgba(0, 0, 0, 0.06));
}
.mindestbestand-indicator.aktiv {
  background: var(--accent-bg, rgba(0, 0, 0, 0.08));
}

/* ---- Zustand: ungesehene Events liegen an (anzahl > 0) ----
   Der Dauer-Ring macht den Zustand auch aus 3 m Entfernung sichtbar,
   ohne dass er das ganze Header-Layout dominiert. */
.mindestbestand-indicator.hat-neu {
  animation: glocken-wackel 1.2s ease-in-out infinite;
}
.mindestbestand-indicator.hat-neu::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 10px;
  border: 2px solid var(--danger, #c0392b);
  opacity: 0;
  animation: ring-puls 2s ease-out infinite;
  pointer-events: none;
}

/* ---- Zustand: ein NEUES Event ist gerade eingetroffen (1,2 s) ----
   Ein einmaliger weißer Blitz, damit der Admin den Moment nicht
   verpasst, wenn er nicht auf die Glocke schaut. */
.mindestbestand-indicator.hat-glanz {
  animation:
    glocken-wackel 1.2s ease-in-out infinite,
    glocken-blitz 1.2s ease-out 1;
}

.mindestbestand-badge {
  position: absolute;
  top: 0;
  right: 0;
  min-width: 1.1rem;
  height: 1.1rem;
  padding: 0 0.3rem;
  background: var(--danger, #c0392b);
  color: #fff;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.mindestbestand-indicator.hat-neu .mindestbestand-badge {
  animation: badge-puls 1.6s ease-in-out infinite;
}
.mindestbestand-dropdown {
  position: absolute;
  top: calc(100% + 0.4rem);
  right: 0;
  width: min(22rem, 90vw);
  max-height: 24rem;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--bg-card, #1a1f29);
  color: var(--text-strong);
  border: 1px solid var(--border-strong, #2f374a);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  z-index: 30;
}
.mindestbestand-dropdown-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.8rem;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}
.mindestbestand-leer {
  padding: 1rem 0.8rem;
  margin: 0;
  color: var(--text-muted);
  font-size: 0.9rem;
}
.mindestbestand-liste {
  list-style: none;
  margin: 0;
  padding: 0;
}
.mindestbestand-item {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  gap: 0.2rem 0.5rem;
  width: 100%;
  padding: 0.6rem 0.8rem;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: inherit;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
}
.mindestbestand-item:last-child {
  border-bottom: none;
}
.mindestbestand-item:hover,
.mindestbestand-item:focus-visible {
  background: var(--accent-bg, rgba(99, 102, 241, 0.12));
  outline: none;
}
.mindestbestand-item-titel {
  font-weight: 600;
  font-size: 0.95rem;
  grid-column: 1;
  color: var(--text-strong);
  overflow-wrap: anywhere;
}
.mindestbestand-item-meta {
  color: var(--text-muted);
  font-size: 0.85rem;
  grid-column: 1;
  overflow-wrap: anywhere;
}
.mindestbestand-item-zeit {
  color: var(--text-muted);
  font-size: 0.8rem;
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
  white-space: nowrap;
}
.link-btn {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0;
}
.link-btn:hover {
  text-decoration: underline;
}
@keyframes glocken-wackel {
  0%,
  50%,
  100% {
    transform: rotate(0deg);
  }
  10%,
  30% {
    transform: rotate(-12deg);
  }
  20%,
  40% {
    transform: rotate(12deg);
  }
}
/* Dauer-Ring: skaliert nach außen und blendet aus. Nur `transform`
   + `opacity`, KEINE background-Animation — das würde auf jedem
   Frame neu painten und auf schwachen Lager-Tablets ruckeln. */
@keyframes ring-puls {
  0% {
    transform: scale(0.92);
    opacity: 0.9;
  }
  70% {
    transform: scale(1.25);
    opacity: 0;
  }
  100% {
    transform: scale(1.25);
    opacity: 0;
  }
}
/* Einmaliger Blitz beim Eintreffen eines neuen Events. */
@keyframes glocken-blitz {
  0% {
    background: var(--danger, #c0392b);
    box-shadow: 0 0 0 0 var(--danger, #c0392b);
  }
  40% {
    background: var(--accent-bg, rgba(99, 102, 241, 0.12));
    box-shadow: 0 0 0 6px transparent;
  }
  100% {
    background: transparent;
    box-shadow: 0 0 0 0 transparent;
  }
}
@keyframes badge-puls {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.18);
  }
}

/* Barrierefreiheit: Wer reduzierte Bewegung eingestellt hat (oder
   auf einer trägen Maschine arbeitet), bekommt nur den Ring — kein
   Wackeln, kein Puls, kein Blitz. Der Zähler bleibt sichtbar. */
@media (prefers-reduced-motion: reduce) {
  .mindestbestand-indicator.hat-neu,
  .mindestbestand-indicator.hat-neu .mindestbestand-badge,
  .mindestbestand-indicator.hat-glanz {
    animation: none;
  }
  .mindestbestand-indicator.hat-neu::after {
    animation: none;
    opacity: 0.9;
    transform: none;
  }
}
</style>

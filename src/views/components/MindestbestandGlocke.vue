<script setup lang="ts">
// MindestbestandGlocke: Header-Indikator, der die Anzahl ungesehener
// Mindestbestand-Ereignisse anzeigt. Klick öffnet direkt die Seite
// `/einstellungen/mindestbestand` (kein Drop-Down mehr). Beim Klick
// werden alle aktuellen Events als "gesehen" markiert (Counter → 0).
//
// Sichtbar für JEDE Rolle — User sollen verfolgen, was einen Alarm hat,
// was bestellt ist und was wieder aufgefüllt wurde. Der Shop-Link und
// der manuelle Bestellt-Toggle bleiben im Mindestbestand-Panel
// vorbehalten. Die Glocke selbst zeigt nur Zähler, Ring-Animation und
// Blitz; sie navigiert beim Klick auf das Panel.

import { onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useMindestbestandStore } from '../../stores/mindestbestand'
import { useSettingsStore } from '../../stores/settings'
import { useMindestbestandAlarm } from '../../composables/useMindestbestandAlarm'

const router = useRouter()
const mindestbestand = useMindestbestandStore()
const settings = useSettingsStore()
// The bell is the single owner of the repeat timer (the settings page
// mounts the same composable for its test button and must not double-ring).
const alarm = useMindestbestandAlarm({ wiederholung: true })

// Anzahl kommt aus dem Alarm-Composable — dort ist der Trigger auch
// angesetzt, damit Zähler und Signal nie auseinanderlaufen.
const anzahl = alarm.anzahl

function openPanel(): void {
  void router.push('/einstellungen/mindestbestand')
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
})

// Notification-Permission erst anfragen, wenn der Alarm tatsächlich
// eingeschaltet ist (Master-Switch `mindestbestandSoundAn`). User starten
// ohne Alarm und bekommen beim ersten Start keinen Permission-Dialog.
watch(
  () => [settings.geladen, settings.settings.mindestbestandSoundAn] as const,
  ([geladen, soundAn]) => {
    if (geladen && soundAn) void requestNotificationPermission()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  mindestbestand.stop()
  mindestbestand.stopMarker()
})
</script>

<template>
  <div class="mindestbestand-wrapper">
    <button
      type="button"
      class="mindestbestand-indicator"
      :class="{
        'hat-neu': anzahl > 0,
        'hat-glanz': alarm.blitzaktiv.value,
      }"
      :title="anzahl > 0 ? `${anzahl} neue Mindestbestand-Ereignisse` : 'Mindestbestand'"
      :aria-label="`Mindestbestand-Benachrichtigungen (${anzahl} neu)`"
      @click.stop="openPanel"
    >
      <span aria-hidden="true" class="mindestbestand-icon">🔔</span>
      <span v-if="anzahl > 0" class="mindestbestand-badge" :aria-label="`${anzahl} ungesehen`">
        {{ anzahl > 99 ? '99+' : anzahl }}
      </span>
    </button>
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

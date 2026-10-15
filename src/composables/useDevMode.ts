// useDevMode — liefert den DEV_MODE-Status, der vom PWA-Container-
// Entrypoint aus VITE_DEV_MODE in /config.js geschrieben wird
// (siehe scripts/pwa-entrypoint.sh).
//
// Auflösung (höchste Priorität zuerst):
//   1. window.__CASTEL_DEV_MODE__  — runtime, vom Container-Entrypoint
//                                 gesetzt (Standard in der compose-Stack).
//   2. import.meta.env.VITE_DEV_MODE  — Build-Default (z. B. lokaler
//                                      Vite-Dev-Server ohne Container).
//   3. 'false'  — Default.
//
// Der Modus wird EINMAL beim ersten Aufruf gecached, weil sich die
// ENV zur Laufzeit nicht ändert (Container-Neustart = neuer App-Run).
// Für Hot-Reload in Dev: window.__CASTEL_DEV_MODE__ direkt im DevTools
// setzen + reload.
//
// Verwendung:
//   const { active, tooltip } = useDevMode()
//   if (active.value) { ... Badge zeigen ... }

import { computed, ref, type ComputedRef } from 'vue'

type DevModeGlobal = { __CASTEL_DEV_MODE__?: string }

// Pure Auflösung ohne Vue-Reactivity. Wird sowohl intern in useDevMode
// als auch im Dev-Mode-Bootstrap (services/dev-mode-bootstrap.ts)
// benutzt, der VOR dem Vue-App-Mount laufen muss.
export function resolveDevMode(): boolean {
  // 1) Container-Runtime-Config
  const fromWindow = (globalThis as DevModeGlobal).__CASTEL_DEV_MODE__
  if (typeof fromWindow === 'string') return fromWindow.toLowerCase() === 'true'
  // 2) Build-Default
  const fromBuild = import.meta.env.VITE_DEV_MODE
  if (typeof fromBuild === 'string') return fromBuild.toLowerCase() === 'true'
  return false
}

const cachedActive = ref<boolean | null>(null)
const cachedTooltip = ref<string>('')

export interface UseDevModeResult {
  active: ComputedRef<boolean>
  tooltip: ComputedRef<string>
}

export function useDevMode(): UseDevModeResult {
  if (cachedActive.value === null) {
    cachedActive.value = resolveDevMode()
    cachedTooltip.value = cachedActive.value
      ? 'DEV_MODE=true: Die API löscht beim Start alle Daten-Tabellen ' +
        '(users, artikel, buchungen, …). Es bleibt nur das Schema, der erste ' +
        'Admin muss neu angelegt werden. ' +
        'Steuerung über DEV_MODE in der .env (docker-compose.yml). ' +
        'Im Live-Betrieb DEV_MODE=false setzen.'
      : ''
  }

  const active = computed(() => cachedActive.value === true)
  const tooltip = computed(() => cachedTooltip.value)
  return { active, tooltip }
}

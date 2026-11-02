// Rollen-Matrix: vom Server laden und offline cachen.
//
// Die Matrix (Rollen, ihre Rechte und die Beschreibungen) liefert der Server
// ueber GET /api/rollen. Die PWA braucht sie fuer die Rollen-Legende unter
// /einstellungen/user. Damit die Legende auch offline geht, wird sie im
// localStorage gecacht — der Cache ist ein reiner Anzeige-Cache, die
// eigentlichen Rechte kommen aus der Session (siehe `useAuthStore`).

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { holeRollenMatrix, type RollenMatrixDto } from '../auth/users'
import { ROLLEN, ROLLEN_INFO, type Permission, type Rolle } from '../domain/rollen'

const LS_MATRIX = 'castel.rollen.matrix'

function cacheLesen(): RollenMatrixDto | null {
  try {
    const raw = localStorage.getItem(LS_MATRIX)
    if (!raw) return null
    return JSON.parse(raw) as RollenMatrixDto
  } catch {
    return null
  }
}

function cacheSchreiben(matrix: RollenMatrixDto): void {
  try {
    localStorage.setItem(LS_MATRIX, JSON.stringify(matrix))
  } catch {
    // localStorage kann gesperrt sein (privater Kontext) — dann gibt es
    // keinen Cache, die Legende laedt bei Bedarf neu.
  }
}

/**
 * Fallback-Matrix aus dem lokalen Modul: sorgt dafuer, dass die Legende auch
 * ohne Server (frische Installation, offline) Text zu sehen bekommt.
 */
function lokaleMatrix(): RollenMatrixDto {
  return {
    version: 1,
    rollen: ROLLEN.map((id) => ({
      id,
      titel: ROLLEN_INFO[id].titel,
      beschreibung: ROLLEN_INFO[id].beschreibung,
      rechte: [...ROLLEN_INFO[id].rechte],
      berechtigungen: [],
    })),
    berechtigungen: [],
  }
}

export const useRollenStore = defineStore('rollen', () => {
  const matrix = ref<RollenMatrixDto>(cacheLesen() ?? lokaleMatrix())
  const geladen = ref(cacheLesen() !== null)

  /** Laedt die Matrix vom Server. Scheitert das, bleibt der Cache aktiv. */
  async function laden(): Promise<void> {
    try {
      const frisch = await holeRollenMatrix()
      matrix.value = frisch
      geladen.value = true
      cacheSchreiben(frisch)
    } catch {
      // Offline / Server nicht erreichbar — der Cache (bzw. die lokale
      // Fallback-Matrix) bleibt bestehen.
    }
  }

  const rollen = computed(() => matrix.value.rollen)
  const berechtigungen = computed(() => matrix.value.berechtigungen)

  function titel(id: Rolle): string {
    return matrix.value.rollen.find((r) => r.id === id)?.titel ?? ROLLEN_INFO[id].titel
  }

  function beschreibung(id: Rolle): string {
    return (
      matrix.value.rollen.find((r) => r.id === id)?.beschreibung ?? ROLLEN_INFO[id].beschreibung
    )
  }

  function rechte(id: Rolle): string[] {
    return matrix.value.rollen.find((r) => r.id === id)?.rechte ?? [...ROLLEN_INFO[id].rechte]
  }

  function berechtigungTitel(id: Permission): string {
    return matrix.value.berechtigungen.find((b) => b.id === id)?.titel ?? id
  }

  return {
    matrix,
    geladen,
    rollen,
    berechtigungen,
    laden,
    titel,
    beschreibung,
    rechte,
    berechtigungTitel,
  }
})

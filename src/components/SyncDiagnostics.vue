<script setup lang="ts">
// SyncDiagnostics: die "Fehleranalyse" des Sync-Panels.
//
// Zeigt IMMER an, was los ist — nicht nur Zählerstände, sondern Klartext:
//   * Befunde ("was ist kaputt?")
//   * Row-Counts aller Tabellen (lokal vs. Server)
//   * ausstehende Outbox-Einträge (mit letztem Server-Fehler)
//   * lokale Datensätze, die der Server nicht kennt
//   * Buchungen, die der Server nicht übernommen hat
//   * stillgelegte Einträge (Quarantäne)
//
// Ein Klick auf "Fehleranalyse ausführen" holt frische Zahlen und eine
// frische ID-Prüfung vom Server — unabhängig vom 30-Sekunden-Sync-Tick.

import { computed, ref } from 'vue'
import { getApiBaseUrl } from '../auth/api'
import { runDiagnostics } from '../services/sync/worker'
import { useSyncStore } from '../stores/sync'

const sync = useSyncStore()
const laeuft = ref(false)
const fehler = ref<string | null>(null)

const diag = computed(() => sync.status.diagnostics)

const befunde = computed(() => diag.value?.findings ?? [])

const abweichungen = computed(() =>
  (diag.value?.tables ?? []).filter((t) => t.server !== null && t.local !== t.server),
)

function zeit(iso: string | null): string {
  if (!iso) return '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '–'
  return d.toLocaleString()
}

async function analyse(): Promise<void> {
  if (laeuft.value) return
  laeuft.value = true
  fehler.value = null
  try {
    await runDiagnostics({
      apiBase: getApiBaseUrl(),
      token: localStorage.getItem('castel.auth.jwt'),
    })
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laeuft.value = false
  }
}
</script>

<template>
  <div class="sync-diag">
    <div class="sync-diag-head">
      <h3>Fehleranalyse</h3>
      <button type="button" :disabled="laeuft" @click="analyse">
        {{ laeuft ? 'Analysiere…' : 'Fehleranalyse ausführen' }}
      </button>
    </div>

    <p v-if="fehler" class="wert-fehler">Analyse fehlgeschlagen: {{ fehler }}</p>

    <p v-if="!diag" class="hint">
      Noch keine Analyse vorhanden — bitte „Fehleranalyse ausführen“ klicken.
    </p>

    <template v-else>
      <p class="hint">Analyse von {{ zeit(diag.at) }}</p>

      <!-- Befunde: das eigentliche "Warum" -->
      <ul class="sync-befunde">
        <li v-for="(f, idx) in befunde" :key="idx" :class="`level-${f.level}`">
          {{ f.text }}
        </li>
      </ul>

      <!-- Row-Counts ALLER Tabellen -->
      <table class="sync-counts">
        <thead>
          <tr>
            <th>Tabelle</th>
            <th>Lokal</th>
            <th>Server</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in diag.tables"
            :key="row.table"
            :class="row.server !== null && row.local !== row.server ? 'wert-warn' : ''"
          >
            <td>{{ row.table }}</td>
            <td>{{ row.local }}</td>
            <td>{{ row.server ?? '–' }}</td>
            <td>
              {{
                row.server !== null
                  ? (row.server - row.local > 0 ? '+' : '') + (row.server - row.local)
                  : '–'
              }}
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Ausstehende Ops -->
      <details v-if="diag.pendingTotal > 0" class="sync-diag-details" open>
        <summary>
          Ausstehende Änderungen ({{ diag.pendingTotal }} insgesamt, {{ diag.pendingItems.length }}
          angezeigt)
        </summary>
        <ul class="sync-diag-list">
          <li v-for="p in diag.pendingItems" :key="p.outboxId">
            <code class="mono">{{ p.entity }}/{{ p.op }}</code>
            <span v-if="p.label"> {{ p.label }}</span>
            <span class="muted mono"> {{ p.payloadId.slice(0, 8) }}… </span>
            <span class="muted"> (Versuch {{ p.attempts }}) </span>
            <span v-if="p.lastError" class="wert-fehler"> {{ p.lastError }}</span>
          </li>
        </ul>
      </details>

      <!-- Lokal vorhanden, Server kennt sie nicht -->
      <details v-if="diag.localOnlyTotal > 0" class="sync-diag-details" open>
        <summary>Nur lokal vorhanden ({{ diag.localOnlyTotal }} — dem Server unbekannt)</summary>
        <ul class="sync-diag-list">
          <li v-for="r in diag.localOnly" :key="`${r.entity}:${r.id}`">
            <code class="mono">{{ r.entity }}</code>
            <span> {{ r.label }}</span>
            <span class="muted mono"> {{ r.id.slice(0, 8) }}… </span>
          </li>
        </ul>
        <p class="hint">
          Diese Datensätze haben keinen Outbox-Eintrag mehr und werden deshalb nie übertragen. Ein
          Admin kann sie unter Einstellungen → Entwicklung → „Server aus lokalen Daten aufbauen“
          wiederherstellen.
        </p>
      </details>

      <!-- Buchungen, die der Server nicht übernommen hat -->
      <details v-if="diag.missingBookingsTotal > 0" class="sync-diag-details" open>
        <summary>Buchungen ohne Server-Daten ({{ diag.missingBookingsTotal }})</summary>
        <ul class="sync-diag-list">
          <li v-for="b in diag.missingBookings" :key="b.id">
            <span>{{ b.label }}</span>
            <span class="muted"> {{ zeit(b.createdAt) }} </span>
            <span v-if="b.reason" class="wert-warn"> {{ b.reason }}</span>
          </li>
        </ul>
      </details>

      <!-- Stillgelegte Einträge -->
      <details v-if="diag.quarantinedItems.length > 0" class="sync-diag-details">
        <summary>Stillgelegt ({{ diag.quarantinedItems.length }})</summary>
        <ul class="sync-diag-list">
          <li v-for="q in diag.quarantinedItems" :key="q.outboxId">
            <code class="mono">{{ q.entity }}/{{ q.op }}</code>
            <span class="wert-warn"> {{ q.quarantineReason }}</span>
          </li>
        </ul>
      </details>

      <p v-if="abweichungen.length === 0 && befunde.length === 1" class="hint wert-ok">
        Keine Abweichung zwischen lokaler und serverseitiger Datenbank.
      </p>
    </template>
  </div>
</template>

<style scoped>
.sync-diag {
  margin-top: 1rem;
  border-top: 1px solid var(--border, #ddd);
  padding-top: 0.75rem;
}

.sync-diag-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.sync-diag-head h3 {
  margin: 0;
}

.sync-befunde {
  list-style: none;
  margin: 0.5rem 0 0.75rem;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.sync-befunde li {
  padding: 0.4rem 0.6rem;
  border-radius: 4px;
  border-left: 3px solid transparent;
  font-size: 0.9rem;
}

.sync-befunde li.level-error {
  border-left-color: var(--danger, #c0392b);
  background: var(--danger-bg, rgba(192, 57, 43, 0.08));
}

.sync-befunde li.level-warn {
  border-left-color: var(--warn, #d68910);
  background: var(--warn-bg, rgba(214, 137, 16, 0.08));
}

.sync-befunde li.level-info {
  border-left-color: var(--ok, #1e8449);
  background: var(--ok-bg, rgba(30, 132, 73, 0.08));
}
</style>

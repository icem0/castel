<script setup lang="ts">
// UpdateMenu: der Update-Block im Versions-Panel (nur fuer Admins).
//
// WICHTIG — zwei Regeln, die den Bug "Klick auf Pruefen passiert nichts"
// verhindert:
//   1. Der Pruef-Button bleibt IMMER sichtbar. Er wird weder durch einen
//      Lade-Hinweis ersetzt noch in einen anderen Block verschoben — der
//      Admin kann immer neu pruefen.
//   2. Der Fehler wird IMMER angezeigt, auch wenn kein Ergebnis vorliegt.
//      Ein fehlgeschlagener Check liefert `current` + `error`; beides wird
//      gerendert, damit der Admin sieht, was installiert ist und WARUM der
//      Vergleich nicht klappte.
//
// Der Click-Handler stoppt die Propagation: sonst wuerde der Klick bis zum
// Dokument blubbern und das Panel (onDocumentClick -> closeVersion) schliessen.

import { useI18n } from 'vue-i18n'
import type { UpdateCheck } from '../services/admin/update-webhook'

export type UpdatePhase = 'idle' | 'bestaetigen' | 'laufend' | 'fertig' | 'fehler'

const props = defineProps<{
  /** Ergebnis des letzten Checks (null = noch nie geprueft). */
  check: UpdateCheck | null
  /** Ein Check laeuft gerade. */
  checkLaeuft: boolean
  /** Fehlermeldung des letzten Checks. */
  checkFehler: string | null
  /** Phase des Update-Starts. */
  phase: UpdatePhase
  /** Fehlermeldung des Update-Starts. */
  fehler: string | null
}>()

const emit = defineEmits<{
  (e: 'pruefen'): void
  (e: 'start'): void
  (e: 'bestaetigen'): void
  (e: 'abbrechen'): void
  (e: 'schliessen'): void
}>()

const { t } = useI18n()
</script>

<template>
  <div class="update-block">
    <h3>{{ t('view.update.h1') }}</h3>

    <!-- Fehler immer anzeigen — auch wenn kein Ergebnis vorliegt. -->
    <p v-if="props.checkFehler" class="wert-fehler" data-test="update-fehler">
      {{ t('view.update.fehlgeschlagen', { error: props.checkFehler }) }}
    </p>

    <template v-if="props.check">
      <p class="hint" data-test="update-versionen">
        {{
          t('view.update.versionen', {
            current: props.check.current ?? t('view.update.unbekannt'),
            latest: props.check.latest ?? t('view.update.unbekannt'),
          })
        }}
      </p>
      <p v-if="props.check.updateAvailable === true" class="hint hint-ok">
        {{ t('view.update.verfuegbar', { latest: props.check.latest }) }}
      </p>
      <p v-else-if="props.check.updateAvailable === false" class="hint hint-ok">
        {{ t('view.update.aktuellVersion') }}
      </p>
    </template>

    <!-- Der Button bleibt immer sichtbar — auch waehrend und nach dem Check. -->
    <div class="actions">
      <button
        type="button"
        data-test="update-pruefen"
        :disabled="props.checkLaeuft"
        @click.stop="emit('pruefen')"
      >
        {{ props.checkLaeuft ? t('view.update.pruefLaeuft') : t('view.update.pruefen') }}
      </button>
      <button
        v-if="props.check && props.check.updateAvailable === true"
        type="button"
        class="primary"
        data-test="update-start"
        :disabled="props.phase === 'laufend'"
        @click.stop="emit('start')"
      >
        {{ props.phase === 'laufend' ? t('view.update.startLaeuft') : t('view.update.start') }}
      </button>
    </div>

    <!-- Update-Bestaetigung / Status -->
    <div v-if="props.phase !== 'idle'" class="confirm" role="alertdialog" data-test="update-dialog">
      <template v-if="props.phase === 'fertig'">
        <p class="hint hint-ok">{{ t('view.update.startErfolg') }}</p>
        <div class="actions">
          <button type="button" @click.stop="emit('schliessen')">
            {{ t('view.common.schliessen') }}
          </button>
        </div>
      </template>
      <template v-else-if="props.phase === 'fehler' && props.fehler">
        <p class="wert-fehler">{{ props.fehler }}</p>
        <div class="actions">
          <button type="button" @click.stop="emit('abbrechen')">
            {{ t('view.common.schliessen') }}
          </button>
        </div>
      </template>
      <template v-else>
        <p>
          <strong>
            {{
              props.phase === 'bestaetigen'
                ? t('view.update.startFrage', { latest: props.check?.latest ?? '' })
                : t('view.update.startLaeuft')
            }}
          </strong>
        </p>
        <p class="hint">{{ t('view.update.startDetail') }}</p>
        <div class="actions">
          <button
            v-if="props.phase === 'bestaetigen'"
            type="button"
            class="primary danger"
            data-test="update-bestaetigen"
            @click.stop="emit('bestaetigen')"
          >
            {{ t('view.update.startBestaetigen') }}
          </button>
          <button type="button" @click.stop="emit('abbrechen')">
            {{ t('view.common.abbrechen') }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.update-block {
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}
.update-block h3 {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
  color: var(--text-strong);
}
.update-block .actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.5rem;
}
.confirm {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.confirm p {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
}
.confirm .hint {
  color: var(--text-muted);
  font-size: 0.78rem !important;
}
.hint-ok {
  color: var(--success);
  font-weight: 600;
}
.wert-fehler {
  color: var(--danger);
  font-weight: 600;
}
</style>

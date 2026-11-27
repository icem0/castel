<script setup lang="ts">
// UpdateMenu: der Update-Block im Versions-Panel (nur fuer Admins).
//
// Read-only: zeigt installierte und neueste Version (GET /api/update/check).
// Das Update selbst laeuft auf dem Server (scripts/update.sh), nicht aus der
// App - deshalb gibt es hier keinen Start-Button.
//
// WICHTIG - zwei Regeln, die den Bug "Klick auf Pruefen passiert nichts"
// verhindern:
//   1. Der Pruef-Button bleibt IMMER sichtbar. Er wird weder durch einen
//      Lade-Hinweis ersetzt noch in einen anderen Block verschoben - der
//      Admin kann immer neu pruefen.
//   2. Der Fehler wird IMMER angezeigt, auch wenn kein Ergebnis vorliegt.
//      Ein fehlgeschlagener Check liefert `current` + `error`; beides wird
//      gerendert, damit der Admin sieht, was installiert ist und WARUM der
//      Vergleich nicht klappte.
//
// Der Click-Handler stoppt die Propagation: sonst wuerde der Klick bis zum
// Dokument blubbern und das Panel (onDocumentClick -> closeVersion) schliessen.

import { useI18n } from 'vue-i18n'
import type { UpdateCheck } from '../services/admin/update-check'

const props = defineProps<{
  /** Ergebnis des letzten Checks (null = noch nie geprueft). */
  check: UpdateCheck | null
  /** Ein Check laeuft gerade. */
  checkLaeuft: boolean
  /** Fehlermeldung des letzten Checks. */
  checkFehler: string | null
}>()

const emit = defineEmits<{
  (e: 'pruefen'): void
}>()

const { t } = useI18n()
</script>

<template>
  <div class="update-block">
    <h3>{{ t('view.update.h1') }}</h3>

    <!-- Fehler immer anzeigen - auch wenn kein Ergebnis vorliegt. -->
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
      <template v-if="props.check.updateAvailable === true">
        <p class="hint hint-ok" data-test="update-verfuegbar">
          {{ t('view.update.verfuegbar', { latest: props.check.latest }) }}
        </p>
        <p class="hint" data-test="update-manuell">{{ t('view.update.manuell') }}</p>
      </template>
      <p v-else-if="props.check.updateAvailable === false" class="hint hint-ok">
        {{ t('view.update.aktuellVersion') }}
      </p>
    </template>

    <!-- Der Button bleibt immer sichtbar - auch waehrend und nach dem Check. -->
    <div class="actions">
      <button
        type="button"
        data-test="update-pruefen"
        :disabled="props.checkLaeuft"
        @click.stop="emit('pruefen')"
      >
        {{ props.checkLaeuft ? t('view.update.pruefLaeuft') : t('view.update.pruefen') }}
      </button>
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
.hint-ok {
  color: var(--success);
  font-weight: 600;
}
.wert-fehler {
  color: var(--danger);
  font-weight: 600;
}
</style>

// Tests für das Update-Menü (UpdateMenu.vue).
//
// Regression: "Beim Klick auf 'Auf Updates prüfen' passiert nichts."
// Ursache war, dass der Fehler nur im Block fuer ein vorhandenes Ergebnis
// gerendert wurde und der Button waehrend des Requests verschwand. Ein
// fehlgeschlagener Check sah damit komplett tot aus.
//
// Diese Tests sichern ab:
//   * der Pruef-Button ist IMMER vorhanden und klickbar
//   * der Fehler wird IMMER angezeigt (auch ohne Ergebnis)
//   * ein Klick loest 'pruefen' aus und propagiert NICHT zum Dokument
//     (sonst schliesst das Panel)

import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import UpdateMenu from '../UpdateMenu.vue'
import de from '../../locales/de-DE'
import type { UpdateCheck } from '../../services/admin/update-webhook'

const i18n = createI18n({
  legacy: false,
  locale: 'de-DE',
  fallbackLocale: 'de-DE',
  messages: { 'de-DE': de },
})

function check(overrides: Partial<UpdateCheck> = {}): UpdateCheck {
  return {
    current: 'abc1234',
    latest: 'def5678',
    updateAvailable: true,
    commitsBehind: 2,
    commits: [],
    checkedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

type Props = {
  check?: UpdateCheck | null
  checkLaeuft?: boolean
  checkFehler?: string | null
  phase?: 'idle' | 'bestaetigen' | 'laufend' | 'fertig' | 'fehler'
  fehler?: string | null
}

function mountMit(props: Props = {}) {
  return mount(UpdateMenu, {
    props: {
      check: null,
      checkLaeuft: false,
      checkFehler: null,
      phase: 'idle',
      fehler: null,
      ...props,
    },
    global: { plugins: [i18n] },
  })
}

describe('UpdateMenu', () => {
  it('zeigt den Pruef-Button auch ohne Ergebnis an', () => {
    const wrapper = mountMit()
    const btn = wrapper.get('[data-test="update-pruefen"]')
    expect(btn.attributes('disabled')).toBeUndefined()
  })

  it('zeigt den Pruef-Button auch bei einem Fehler an', () => {
    const wrapper = mountMit({ checkFehler: 'GitHub API: HTTP 403' })
    wrapper.get('[data-test="update-pruefen"]')
    // Der Fehler ist sichtbar — er darf nicht im Ergebnis-Block versteckt sein.
    const fehler = wrapper.get('[data-test="update-fehler"]')
    expect(fehler.text()).toContain('GitHub API: HTTP 403')
  })

  it('laesst den Pruef-Button waehrend des Checks sichtbar (nur disabled)', () => {
    const wrapper = mountMit({ checkLaeuft: true })
    const btn = wrapper.get('[data-test="update-pruefen"]')
    expect(btn.attributes('disabled')).toBeDefined()
  })

  it('loest beim Klick "pruefen" aus und stoppt die Propagation', async () => {
    const wrapper = mountMit()
    const stopPropagation = vi.fn()
    await wrapper.get('[data-test="update-pruefen"]').trigger('click', { stopPropagation })
    expect(wrapper.emitted('pruefen')).toHaveLength(1)
    // Ohne .stop wuerde der Klick das Versions-Panel schliessen.
    expect(stopPropagation).toHaveBeenCalled()
  })

  it('zeigt Versionen und Update-Button bei verfuegbarem Update', () => {
    const wrapper = mountMit({ check: check() })
    expect(wrapper.get('[data-test="update-versionen"]').text()).toContain('abc1234')
    expect(wrapper.get('[data-test="update-versionen"]').text()).toContain('def5678')
    wrapper.get('[data-test="update-start"]')
  })

  it('zeigt KEINEN Update-Button, wenn kein Update verfuegbar ist', () => {
    const wrapper = mountMit({ check: check({ updateAvailable: false }) })
    expect(wrapper.find('[data-test="update-start"]').exists()).toBe(false)
  })

  it('zeigt die Bestaetigung erst nach "start" und loest sie aus', async () => {
    const wrapper = mountMit({ check: check(), phase: 'bestaetigen' })
    wrapper.get('[data-test="update-dialog"]')
    await wrapper.get('[data-test="update-bestaetigen"]').trigger('click')
    expect(wrapper.emitted('bestaetigen')).toHaveLength(1)
  })

  it('zeigt im Fehlerfall die Fehlermeldung des Starts', () => {
    const wrapper = mountMit({ check: check(), phase: 'fehler', fehler: 'Kein Update verfügbar.' })
    expect(wrapper.get('[data-test="update-dialog"]').text()).toContain('Kein Update verfügbar.')
    wrapper.get('[data-test="update-dialog"]')
  })
})

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SortableTh from '../SortableTh.vue'

function mountTh(props: {
  label?: string
  sortKey?: string
  activeKey?: string | null
  dir?: 'asc' | 'desc' | 'off'
  align?: 'left' | 'right'
}) {
  return mount(SortableTh, {
    props: {
      label: props.label ?? 'Titel',
      sortKey: props.sortKey ?? 'titel',
      activeKey: props.activeKey ?? null,
      dir: props.dir ?? 'off',
      ...(props.align ? { align: props.align } : {}),
    },
  })
}

describe('SortableTh', () => {
  it('rendert das Label', () => {
    const w = mountTh({ label: 'Mein Titel' })
    expect(w.text()).toContain('Mein Titel')
  })

  it('zeigt keinen Pfeil im off-Modus', () => {
    const w = mountTh({ activeKey: null, dir: 'off' })
    expect(w.find('.arrow').text()).toBe('')
    expect(w.attributes('aria-sort')).toBe('none')
  })

  it('zeigt einen Aufwaertspfeil im asc-Modus', () => {
    const w = mountTh({ sortKey: 'titel', activeKey: 'titel', dir: 'asc' })
    expect(w.find('.arrow').text()).toBe('\u2191')
    expect(w.attributes('aria-sort')).toBe('ascending')
  })

  it('zeigt einen Abwaertspfeil im desc-Modus', () => {
    const w = mountTh({ sortKey: 'titel', activeKey: 'titel', dir: 'desc' })
    expect(w.find('.arrow').text()).toBe('\u2193')
    expect(w.attributes('aria-sort')).toBe('descending')
  })

  it('zeigt keinen Pfeil, wenn activeKey nicht passt (andere Spalte aktiv)', () => {
    const w = mountTh({ sortKey: 'titel', activeKey: 'typ', dir: 'asc' })
    expect(w.find('.arrow').text()).toBe('')
    expect(w.attributes('aria-sort')).toBe('none')
  })

  it('emittiert sort-Event mit eigenem Key beim Klick', async () => {
    const w = mountTh({ sortKey: 'titel' })
    await w.find('th').trigger('click')
    const events = w.emitted('sort')
    expect(events).toBeTruthy()
    expect(events).toHaveLength(1)
    expect(events![0]).toEqual(['titel'])
  })

  it('emittiert sort-Event bei Enter-Taste', async () => {
    const w = mountTh({ sortKey: 'bestand' })
    await w.find('th').trigger('keydown.enter')
    const events = w.emitted('sort')
    expect(events).toBeTruthy()
    expect(events![0]).toEqual(['bestand'])
  })

  it('emittiert sort-Event bei Leertaste', async () => {
    const w = mountTh({ sortKey: 'bestand' })
    await w.find('th').trigger('keydown.space')
    const events = w.emitted('sort')
    expect(events).toBeTruthy()
    expect(events![0]).toEqual(['bestand'])
  })

  it('aktive Spalte hat die .active-Klasse', () => {
    const w = mountTh({ activeKey: 'titel', dir: 'asc' })
    expect(w.find('th').classes()).toContain('active')
  })

  it('inaktive Spalte hat keine .active-Klasse', () => {
    const w = mountTh({ activeKey: 'typ', dir: 'asc' })
    expect(w.find('th').classes()).not.toContain('active')
  })
})

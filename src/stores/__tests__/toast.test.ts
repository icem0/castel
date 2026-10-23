import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useToastStore } from '../toast'

describe('Toast-Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('zeigt einen Toast und blendet ihn nach dem Timeout aus', () => {
    const toast = useToastStore()
    toast.show({ text: 'Buchung wird gesendet …', timeoutMs: 1_000 })

    expect(toast.toasts).toHaveLength(1)
    vi.advanceTimersByTime(999)
    expect(toast.toasts).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(toast.toasts).toHaveLength(0)
  })

  it('aktualisiert Status und Text und startet den Timer neu', () => {
    const toast = useToastStore()
    const id = toast.show({ text: 'wird gesendet', status: 'info', timeoutMs: 1_000 })

    toast.update(id, { text: 'angekommen', status: 'success', timeoutMs: 2_000 })
    expect(toast.toasts[0]).toMatchObject({ text: 'angekommen', status: 'success' })

    vi.advanceTimersByTime(1_000)
    expect(toast.toasts).toHaveLength(1)
    vi.advanceTimersByTime(1_000)
    expect(toast.toasts).toHaveLength(0)
  })

  it('behält höchstens drei Toasts', () => {
    const toast = useToastStore()
    for (let i = 0; i < 4; i++) {
      toast.show({ text: `Toast ${i}`, timeoutMs: null })
    }
    expect(toast.toasts).toHaveLength(3)
    expect(toast.toasts.map((t) => t.text)).toEqual(['Toast 1', 'Toast 2', 'Toast 3'])
  })
})

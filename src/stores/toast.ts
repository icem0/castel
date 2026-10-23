// Global, in-memory toast state. Used for booking sync feedback that must
// survive an immediate route change (form -> scanner).
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { neueUuid } from '../domain/ids'

export type ToastStatus = 'info' | 'success' | 'warning' | 'error'

export interface ToastEintrag {
  id: string
  text: string
  status: ToastStatus
  timeoutMs: number | null
}

export interface ToastOptionen {
  text: string
  status?: ToastStatus
  /** `null` keeps the toast until it is updated or dismissed. */
  timeoutMs?: number | null
  id?: string
}

const MAX_TOASTS = 3
const DEFAULT_TIMEOUT_MS = 4_000

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<ToastEintrag[]>([])
  const timer = new Map<string, ReturnType<typeof setTimeout>>()

  function clearTimer(id: string): void {
    const handle = timer.get(id)
    if (handle !== undefined) {
      clearTimeout(handle)
      timer.delete(id)
    }
  }

  function schedule(id: string, timeoutMs: number | null): void {
    clearTimer(id)
    if (timeoutMs === null) return
    timer.set(
      id,
      setTimeout(() => dismiss(id), timeoutMs),
    )
  }

  function dismiss(id: string): void {
    clearTimer(id)
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  function show(opts: ToastOptionen): string {
    const id = opts.id ?? neueUuid()
    const eintrag: ToastEintrag = {
      id,
      text: opts.text,
      status: opts.status ?? 'info',
      timeoutMs: opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs,
    }
    const index = toasts.value.findIndex((t) => t.id === id)
    if (index >= 0) {
      toasts.value[index] = eintrag
    } else {
      toasts.value.push(eintrag)
      while (toasts.value.length > MAX_TOASTS) {
        const oldest = toasts.value.shift()
        if (oldest) clearTimer(oldest.id)
      }
    }
    schedule(id, eintrag.timeoutMs)
    return id
  }

  function update(id: string, patch: Partial<Omit<ToastEintrag, 'id'>>): void {
    const index = toasts.value.findIndex((t) => t.id === id)
    if (index < 0) return
    const next = { ...toasts.value[index]!, ...patch }
    toasts.value[index] = next
    schedule(id, next.timeoutMs)
  }

  return { toasts, show, update, dismiss }
})

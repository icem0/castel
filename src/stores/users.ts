// User-Store: reaktive Liste aller User via API + manueller Refresh.
// Quelle der Wahrheit ist der Server; wir cachen die letzte Liste im RAM.

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { holeAktiveUserliste, type UserDto } from '../auth/users'

export const useUserStore = defineStore('users', () => {
  const users = ref<UserDto[]>([])
  const geladen = ref(false)
  const fehler = ref<string | null>(null)

  async function laden(): Promise<void> {
    try {
      fehler.value = null
      users.value = await holeAktiveUserliste()
      geladen.value = true
    } catch (e) {
      fehler.value = e instanceof Error ? e.message : String(e)
    }
  }

  function byId(id: string): UserDto | undefined {
    return users.value.find((u) => u.id === id)
  }

  return { users, geladen, fehler, laden, byId }
})

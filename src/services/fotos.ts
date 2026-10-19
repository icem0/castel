// Foto-Service für die PWA: lädt Bilder zum Server und löscht sie dort.
//
// Workflow:
//   1. Datei aus <input type=file capture> empfangen
//   2. clientseitig komprimieren (browser-image-compression)
//   3. Multipart-Upload an POST /api/fotos/upload/:artikelId
//   4. Server liefert URL → in der `fotos`-Tabelle ist das die Source-of-Truth
//
// Fotos leben nur auf dem Server. Die PWA lädt die Liste bei Bedarf frisch
// per `ladeFotoListe`. Es gibt keine lokale Caching- oder Outbox-Pfad für
// Foto-URLs — offline ist die Foto-Sektion ausgeblendet.

import imageCompression from 'browser-image-compression'
import { getApiBaseUrl } from '../auth/api'
import { jwtLesen } from '../auth/session'
import { getSyncStatus, triggerSyncNow } from './sync/worker'

export interface FotoUploadErgebnis {
  id: string
  url: string
  contentType: string
  groesse: number
}

export interface FotoListEintrag {
  id: string
  url: string
}

const MAX_SIZE_MB = 0.32
const MAX_WIDTH = 1280

export async function komprimiereBild(datei: File): Promise<File> {
  return imageCompression(datei, {
    maxSizeMB: MAX_SIZE_MB,
    maxWidthOrHeight: MAX_WIDTH,
    useWebWorker: true,
    fileType: 'image/jpeg',
  })
}

/** Wartet, bis kein Sync mehr läuft (max. timeoutMs), dann retry erlauben. */
async function waitForSyncIdle(timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (getSyncStatus().status !== 'syncing') return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

export async function ladeFotoHoch(
  artikelId: string,
  datei: File,
  originalFilename?: string,
): Promise<FotoUploadErgebnis> {
  const komprimiert = await komprimiereBild(datei)
  const filename = originalFilename ?? `foto-${Date.now()}.jpg`

  const upload = async (): Promise<Response> => {
    const formData = new FormData()
    formData.append('foto', komprimiert, filename)
    const url = `${getApiBaseUrl()}/api/fotos/upload/${artikelId}`
    const token = jwtLesen()
    return fetch(url, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
      credentials: 'include',
    })
  }

  let res = await upload()

  // Offline-first: Artikel existiert lokal, wurde aber ggf. noch nicht auf
  // den Server gesynced. Bei ARTIKEL_NOT_FOUND Sync triggern, auf Abschluss
  // warten und Upload wiederholen.
  if (res.status === 404) {
    try {
      const body = await res.json()
      if (body?.code === 'ARTIKEL_NOT_FOUND') {
        await triggerSyncNow({ token: jwtLesen(), apiBase: getApiBaseUrl() })
        await waitForSyncIdle()
        res = await upload()
      }
    } catch {
      // JSON nicht parsebar -> Fallthrough zur normalen Fehlerbehandlung
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Upload fehlgeschlagen (${res.status}): ${text}`)
  }
  return (await res.json()) as FotoUploadErgebnis
}

/** Liest die Bild-Liste eines Artikels vom Server. */
export async function ladeFotoListe(artikelId: string): Promise<FotoListEintrag[]> {
  const url = `${getApiBaseUrl()}/api/fotos/list/${artikelId}`
  const token = jwtLesen()
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'include',
  })
  if (!res.ok) return []
  return (await res.json()) as FotoListEintrag[]
}

/** Löscht ein Foto auf dem Server (Admin-only, via JWT-Rolle). */
export async function loescheFoto(fotoId: string): Promise<void> {
  const url = `${getApiBaseUrl()}/api/fotos/${fotoId}`
  const token = jwtLesen()
  const res = await fetch(url, {
    method: 'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'include',
  })
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => '')
    throw new Error(`Löschen fehlgeschlagen (${res.status}): ${text}`)
  }
}

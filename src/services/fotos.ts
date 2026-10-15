// Foto-Service für die PWA: lädt Bilder zum Server.
//
// Workflow:
//   1. Datei aus <input type=file capture> empfangen
//   2. clientseitig komprimieren (browser-image-compression)
//   3. Multipart-Upload an POST /api/fotos/upload/:artikelId
//   4. Server liefert URL → in artikel.fotoUrls speichern
//
// Offline: Base64-Repräsentation in IndexedDB, beim nächsten Sync hochladen.

import imageCompression from 'browser-image-compression'
import { getApiBaseUrl } from '../auth/api'
import { jwtLesen } from '../auth/session'

export interface FotoUploadErgebnis {
  id: string
  url: string
  contentType: string
  groesse: number
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

export async function ladeFotoHoch(
  artikelId: string,
  datei: File,
  originalFilename?: string,
): Promise<FotoUploadErgebnis> {
  const komprimiert = await komprimiereBild(datei)
  const formData = new FormData()
  const filename = originalFilename ?? `foto-${Date.now()}.jpg`
  formData.append('foto', komprimiert, filename)

  const url = `${getApiBaseUrl()}/api/fotos/upload/${artikelId}`
  const token = jwtLesen()
  const res = await fetch(url, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
    credentials: 'include',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Upload fehlgeschlagen (${res.status}): ${text}`)
  }
  return (await res.json()) as FotoUploadErgebnis
}

/** Liest die Bild-Liste eines Artikels vom Server. */
export async function ladeFotoListe(
  artikelId: string,
): Promise<Array<{ id: string; url: string }>> {
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
  return (await res.json()) as Array<{ id: string; url: string }>
}

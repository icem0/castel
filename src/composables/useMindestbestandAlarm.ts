// useMindestbestandAlarm — Auslöser für Audio + Blitz + OS-Notification
// bei neuen Mindestbestand-Ereignissen.
//
// Der Alarm feuert NUR für Events, die nach dem Cooldown-Anker
// (`mindestbestand.letztesSignalAm`) liegen. Damit gilt:
//   - Beim ersten Mount / Login klingelt es NICHT über historische
//     Events (der Anker ist persistiert).
//   - Nach einem Reload klingelt es nicht erneut.
//   - Maximal 1 Alarm pro 60 s (`COOLDOWN_MS`), auch wenn im gleichen
//     Sync-Tick 5 Events ankommen.
//
// Die reine WebAudio-Logik liegt aus Gründen der Testbarkeit in
// `services/audio/alarm.ts` — dieses Composable orchestriert nur
// Store-Zustand, Settings, Cooldown und Notification.

import { computed, onScopeDispose, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMindestbestandStore } from '../stores/mindestbestand'
import { useSettingsStore } from '../stores/settings'
import { useArtikelStore } from '../stores/artikel'
import { useAuthStore } from '../stores/auth'
import type { MindestbestandEreignis } from '../db/types'
import { alarmKlingeln, audioContextBereit, vibrateMuster } from '../services/audio/alarm'

/** Mindestabstand zwischen zwei Alarmen. */
export const COOLDOWN_MS = 60_000

/** Wie lange der visuelle Blitz aktiv bleibt. */
export const BLITZ_DAUER_MS = 1200

/**
 * Reine Cooldown-Prüfung. Exportiert, damit sie ohne Store und ohne
 * Timer getestet werden kann.
 *
 * @param marker      letzter Signal-Zeitpunkt (ISO) oder `null`
 * @param jetztMs     aktuelle Zeit in ms
 * @param cooldownMs  Mindestabstand in ms
 */
export function cooldownAktiv(
  marker: string | null,
  jetztMs: number,
  cooldownMs: number = COOLDOWN_MS,
): boolean {
  // Kein Anker (frische Installation / lokale DB gelöscht): KEIN Alarm.
  // Sonst würde das erste neue Event sofort klingeln — genau richtig,
  // aber ohne Anker können wir historische Events nicht von neuen
  // unterscheiden und würden beim Mount alles nachliefern.
  if (!marker) return true
  const zeit = Date.parse(marker)
  if (!Number.isFinite(zeit)) return true
  return jetztMs - zeit < cooldownMs
}

export interface MindestbestandAlarm {
  /** Anzahl ungesehener Events (Badge). */
  anzahl: Readonly<Ref<number>>
  /** `true` für `BLITZ_DAUER_MS` nach einem neuen Event — CSS-Klasse. */
  blitzaktiv: Ref<boolean>
  /** Notification-Permission des Browsers (für Settings-Anzeige). */
  permission: Readonly<Ref<NotificationPermission | 'unsupported'>>
  /** Manuell auslösen (für den "Testen"-Knopf). Umgeht den Cooldown. */
  signalTesten: () => Promise<void>
}

export function useMindestbestandAlarm(): MindestbestandAlarm {
  const router = useRouter()
  const mindestbestand = useMindestbestandStore()
  const settings = useSettingsStore()
  const auth = useAuthStore()
  const artikelStore = useArtikelStore()

  const blitzaktiv = ref(false)
  let blitzTimer: ReturnType<typeof setTimeout> | null = null

  const anzahl = computed(() => mindestbestand.ungesehenCount)

  const permission = computed<NotificationPermission | 'unsupported'>(() => {
    if (typeof Notification === 'undefined') return 'unsupported'
    return Notification.permission
  })

  /** Prozent (0..100) → WebAudio-Gain (0..1). */
  function gainAusProzent(prozent: number): number {
    return Math.max(0, Math.min(100, prozent)) / 100
  }

  function zeigeBlitz(): void {
    blitzaktiv.value = true
    if (blitzTimer !== null) clearTimeout(blitzTimer)
    blitzTimer = setTimeout(() => {
      blitzaktiv.value = false
      blitzTimer = null
    }, BLITZ_DAUER_MS)
  }

  function osNotificationSenden(artikelId: string, titel: string, bestand: number, soll: number) {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    // Doppel-Notification vermeiden: nur wenn die PWA im Hintergrund ist.
    // Bei sichtbarer App sieht der Admin die Glocke ohnehin.
    if (typeof document !== 'undefined' && !document.hidden) return
    try {
      const n = new Notification(titel, {
        body: `Bestand ${bestand}, Mindestbestand ${soll}`,
        tag: 'mindestbestand', // ersetzt vorherige statt zu stapeln
        icon: '/castel-logo.png',
      })
      n.onclick = () => {
        window.focus()
        void router.push(`/artikel/${artikelId}`)
        n.close()
      }
    } catch {
      // Manche Browser (iOS ohne installierte PWA) werfen trotz
      // Permission. Kein Grund für einen Fehler.
    }
  }

  /**
   * Löst den vollständigen Alarm aus. Setzt VOR den Nebenwirkungen
   * den Cooldown-Anker — sonst käme ein Fehler in `alarmKlingeln` dazu,
   * dass der nächste Tick erneut versucht.
   */
  async function signalAusloesen(
    ereignis: MindestbestandEreignis,
    ueberspringeCooldown = false,
  ): Promise<void> {
    if (!auth.istAdmin) return

    if (!ueberspringeCooldown) {
      const anker = mindestbestand.letztesSignalAm
      if (cooldownAktiv(anker, Date.now())) return
    }
    await mindestbestand.markiereSignalGesendet()

    const artikelTitel = artikelStore.byId(ereignis.artikelId)?.titel ?? 'Artikel'

    // 1) Audio (nur wenn eingeschaltet)
    if (settings.settings.mindestbestandSoundAn) {
      alarmKlingeln(audioContextBereit(), {
        lautstaerke: gainAusProzent(settings.settings.mindestbestandLautstaerke),
      })
    }

    // 2) Haptik — unabhängig vom Sound-Switch, weil die Einstellung
    //    semantisch "Klingelton" heißt, nicht "Benachrichtigung".
    vibrateMuster()

    // 3) Visueller Blitz
    zeigeBlitz()

    // 4) OS-Notification (nur bei verstecktem Dokument + Permission)
    osNotificationSenden(
      ereignis.artikelId,
      `Mindestbestand unterschritten: ${artikelTitel}`,
      ereignis.bestandDanach,
      ereignis.mindestbestand,
    )
  }

  /**
   * Trigger: wir beobachten die ID-Liste der letzten Events. Sobald
   * sich die Liste ändert, ist mindestens ein Event dazugekommen.
   *
   * `watch` ohne `immediate: true` feuert beim Mount NICHT — das ist
   * der Grund, warum wir hier keinen `alt`-Guard brauchen: der
   * allererste Lauf des Watchers liefert kein Signal.
   *
   * `alt === undefined` tritt auf, wenn `letzte50` beim Mount noch leer
   * war (Store noch nicht geladen). Dann darf das erste Batch (das
   * aus IndexedDB kommt) keinen Alarm auslösen — sonst klingelt es
   * beim Login über historische Events. Wir prüfen das zusätzlich
   * gegen den Cooldown-Anker.
   */
  watch(
    () => mindestbestand.letzte50.map((e) => e.id).join(','),
    async (neu, alt) => {
      if (neu === alt) return
      if (!auth.istAdmin) return
      if (alt === undefined) return // Store noch nicht geladen
      // Das NEUESTE Event (Index 0, weil `orderBy('erstelltAm').reverse()`).
      const neueste = mindestbestand.letzte50[0]
      if (!neueste) return
      await signalAusloesen(neueste)
    },
  )

  // Autoplay-Policy: nach einem Tab-Wechsel ist der AudioContext in
  // vielen Browsern `suspended`. Beim Zurückkommen vorab aktivieren,
  // damit der nächste Alarm nicht stumm bleibt.
  function onVisibilityChange(): void {
    if (document.visibilityState !== 'visible') return
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
    audioContextBereit()
  }

  document.addEventListener('visibilitychange', onVisibilityChange)

  onScopeDispose(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (blitzTimer !== null) clearTimeout(blitzTimer)
  })

  /** Manueller Test — umgeht den Cooldown bewusst. */
  async function signalTesten(): Promise<void> {
    // Wir brauchen für den Test ein synthetisches Event, falls die DB
    // leer ist (frische Installation). Die Werte sind egal — es geht
    // nur um Klingelton / Blitz / Haptik.
    const artikel = artikelStore.artikel[0]
    const platzhalter: MindestbestandEreignis = {
      id: 'test',
      artikelId: artikel?.id ?? '',
      standortId: '',
      ausloeserBuchungId: '',
      bestandDanach: 0,
      mindestbestand: 1,
      defizit: 1,
      erstelltAm: new Date().toISOString(),
    }
    const vorhanden = mindestbestand.letzte50[0]
    await signalAusloesen(vorhanden ?? platzhalter, true)
  }

  return { anzahl, blitzaktiv, permission, signalTesten }
}

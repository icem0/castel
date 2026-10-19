// Notification-Gateway: Schnittstelle für die Auslieferung von
// Mindestbestand-Ereignissen an externe Kanäle.
//
// Hintergrund: der Sync-Resolver (`sync/resolver.ts`) schreibt jedes
// ausgelöste Mindestbestand-Ereignis in die Postgres-Tabelle
// `mindestbestand_ereignisse`. Die PWA liest die Tabelle via
// Snapshot-Endpoint und zeigt sie im Glocken-Panel. Das hier ist die
// Schnittstelle für weitere Kanäle (z. B. tägliche Sammel-Mail an
// Admins), die OHNE Schema-Bruch nachgerüstet werden sollen.
//
// Status: nur Skeleton. Die `SmtpNotificationGateway`-Implementierung
// ist als `throw new Error('not implemented')` ausgelegt, damit die
// Schnittstelle dokumentiert und testbar ist, ohne jetzt schon
// `nodemailer` zu installieren. Die `LogNotificationGateway` ist die
// aktive Default-Implementierung — sie schreibt Events nur ins pino-Log.

import type { FastifyBaseLogger } from 'fastify'

/**
 * Reduzierte Form eines Mindestbestand-Ereignisses, wie sie an externe
 * Kanäle ausgeliefert wird. Server-only Felder (zustellung_admin_ids,
 * konsumiert_von_mail) bleiben bewusst außen vor.
 */
export interface MindestbestandEvent {
  id: string
  artikelId: string
  standortId: string
  ausloeserBuchungId: string
  bestandDanach: number
  mindestbestand: number
  defizit: number
  erstelltAm: string // ISO
}

/**
 * Schnittstelle für externe Notification-Kanäle. Implementierungen
 * müssen idempotent sein — der Resolver darf denselben Event bei einem
 * Retrigger nicht doppelt zustellen.
 */
export interface NotificationGateway {
  readonly name: string
  /**
   * Liefert ein frisch erzeugtes Mindestbestand-Ereignis aus. Sollte
   * nicht blockieren — der Resolver ist bereits in einer DB-Transaktion
   * und will die Latenz klein halten. Fehler werden geloggt, nicht
   * geworfen (Resolver darf nicht abbrechen, wenn der Notification-
   * Kanal ausfällt).
   */
  dispatchMindestbestandEvent(event: MindestbestandEvent): Promise<void>
}

/**
 * Default-Implementierung: loggt das Event auf info-Level. Aktiv wenn
 * `MAIL_ENABLED=false` (Default). Damit ist die Schnittstelle
 * dokumentiert und die Events sind im Container-Log nachvollziehbar,
 * ohne dass SMTP konfiguriert sein muss.
 */
export class LogNotificationGateway implements NotificationGateway {
  readonly name = 'log'

  constructor(private readonly logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>) {}

  async dispatchMindestbestandEvent(event: MindestbestandEvent): Promise<void> {
    this.logger.info(
      {
        event: 'mindestbestand.unterschritten',
        id: event.id,
        artikelId: event.artikelId,
        standortId: event.standortId,
        bestandDanach: event.bestandDanach,
        mindestbestand: event.mindestbestand,
        defizit: event.defizit,
        erstelltAm: event.erstelltAm,
      },
      'Mindestbestand unterschritten (LogGateway)',
    )
  }
}

/**
 * Skeleton für den späteren SMTP-Versand. Wirft aktuell — die
 * Implementierung wird in einem eigenen Schritt nachgerüstet, sobald
 * `MAIL_ENABLED=true` gesetzt und `nodemailer` als Dependency
 * aufgenommen ist. Bis dahin dient der Stub nur dazu, die Schnittstelle
 * zu fixieren und Tests zu ermöglichen.
 */
export class SmtpNotificationGateway implements NotificationGateway {
  readonly name = 'smtp'
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_opts: SmtpGatewayOptions) {
    // bewusst leer — Implementierung folgt.
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async dispatchMindestbestandEvent(_event: MindestbestandEvent): Promise<void> {
    throw new Error('SmtpNotificationGateway ist noch nicht implementiert')
  }
}

export interface SmtpGatewayOptions {
  host: string
  port: number
  user: string
  pass: string
  from: string
  /** Cron-taugliche Stunde (0–23), zu der die Tages-Sammel-Mail gebaut wird. */
  dailyDigestHour: number
}

/**
 * Factory: wählt anhand der Mail-Config die passende Implementierung.
 * Default: LogNotificationGateway. Wird von `index.ts` einmal beim
 * Boot aufgerufen und das Resultat an den Resolver durchgereicht.
 */
export function buildNotificationGateway(opts: {
  mailEnabled: boolean
  smtp: SmtpGatewayOptions
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
}): NotificationGateway {
  if (opts.mailEnabled) {
    return new SmtpNotificationGateway(opts.smtp)
  }
  return new LogNotificationGateway(opts.logger)
}

// Shared helpers for the E2E specs: test users, login, navigation and the
// few UI interactions the sync scenarios need (booking, editing an article,
// triggering a sync, reading the stock per location).

import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'

export interface TestUser {
  name: string
  email: string
  passwort: string
}

// Throwaway credentials that exist only in the wiped "_e2e" database.
export const ADMIN: TestUser = {
  name: 'E2E Admin',
  email: 'admin@castel-e2e.test',
  passwort: 'e2e-admin-passwort',
}
export const LAGERIST: TestUser = {
  name: 'E2E Lagerist',
  email: 'lagerist@castel-e2e.test',
  passwort: 'e2e-lagerist-passwort',
}

export const HAUPTLAGER = 'Hauptlager'

/** Opens a fresh browser context (own IndexedDB, own outbox) and logs in. */
export async function neuerClient(browser: Browser, user: TestUser): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  // The onboarding dialog opens once per user after the first login, at a
  // moment that depends on the first sync. Close it whenever it shows up.
  await page.addLocatorHandler(page.locator('[aria-labelledby="onb-title"]'), async (dialog) => {
    await dialog.getByRole('button', { name: 'Später' }).click()
  })
  await page.goto('/login')
  await page.locator('input[name="email"]').fill(user.email)
  await page.locator('input[name="password"]').fill(user.passwort)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).not.toHaveURL(/\/login/)
  await expect(page.locator('.sync-indicator')).toBeVisible()
  return page
}

/** Looks up an article id by title through the API (admin token). */
export async function artikelId(request: APIRequestContext, titel: string): Promise<string> {
  const login = await request.post('/api/auth/login', {
    data: { email: ADMIN.email, password: ADMIN.passwort },
  })
  expect(login.ok(), await login.text()).toBeTruthy()
  const { token } = (await login.json()) as { token: string }
  const snap = await request.get('/api/sync/snapshot', {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(snap.ok(), await snap.text()).toBeTruthy()
  const body = (await snap.json()) as { artikel: Array<{ id: string; titel: string }> }
  const treffer = body.artikel.find((a) => a.titel === titel)
  if (!treffer) throw new Error(`Artikel "${titel}" nicht im Snapshot`)
  return treffer.id
}

/**
 * Opens the article detail page once the article has reached the local
 * database (the first sync after login fills IndexedDB asynchronously).
 */
export async function oeffneArtikel(page: Page, id: string): Promise<void> {
  await page.goto(`/artikel/${id}`)
  await expect(page.getByRole('link', { name: 'Buchen' })).toBeVisible({ timeout: 30_000 })
}

/** Stock card for one location on the article detail page. */
export function bestandKarte(page: Page, standort: string = HAUPTLAGER) {
  return page.locator('.stat-card').filter({ hasText: standort }).locator('strong')
}

/** Article heading on the detail page. */
export function artikelTitel(page: Page) {
  return page.locator('.view-head h1')
}

/**
 * Books from the article detail page. Navigation stays inside the SPA (router
 * links), so it also works while the context is offline.
 */
export async function buchen(
  page: Page,
  typ: 'Einlagerung' | 'Entnahme',
  menge: number,
): Promise<void> {
  const url = page.url()
  await page.getByRole('link', { name: 'Buchen' }).click()
  await expect(page.getByRole('heading', { name: 'Neue Buchung' })).toBeVisible()
  await page.locator('label.tile').filter({ hasText: typ }).click()
  await page.getByRole('spinbutton', { name: 'Menge' }).fill(String(menge))
  await page.locator('form.buchung-card button[type="submit"]').click()
  await expect(page).toHaveURL(url)
}

/** Edits the article title inline on the detail page. */
export async function titelAendern(page: Page, neuerTitel: string): Promise<void> {
  await page.getByTestId('artikel-detail-bearbeiten').click()
  const feld = page.locator('form label').filter({ hasText: 'Titel' }).locator('input')
  await feld.fill(neuerTitel)
  await page.locator('form button[type="submit"]').filter({ hasText: 'Speichern' }).click()
  await expect(artikelTitel(page)).toContainText(neuerTitel)
}

export interface OutboxZeile {
  entity: string
  op: string
  syncedAt: string | null
  quarantinedAt: string | null
  lastError: string | null
}

/**
 * Reads the client's outbox straight from IndexedDB (database "castel",
 * see src/db/database.ts). The badge on the sync button only refreshes when
 * the worker runs, which it does not while offline.
 */
export async function outbox(page: Page): Promise<OutboxZeile[]> {
  return page.evaluate(
    () =>
      new Promise<OutboxZeile[]>((resolve, reject) => {
        const open = indexedDB.open('castel')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const req = db.transaction('outbox', 'readonly').objectStore('outbox').getAll()
          req.onerror = () => reject(req.error)
          req.onsuccess = () => {
            db.close()
            resolve(
              (req.result as OutboxZeile[]).map((o) => ({
                entity: o.entity,
                op: o.op,
                syncedAt: o.syncedAt,
                quarantinedAt: o.quarantinedAt ?? null,
                lastError: o.lastError,
              })),
            )
          }
        }
      }),
  )
}

/** Outbox items that still wait for the push (not synced, not quarantined). */
export async function ausstehend(page: Page, entity?: string): Promise<OutboxZeile[]> {
  return (await outbox(page)).filter(
    (o) => o.syncedAt === null && o.quarantinedAt === null && (!entity || o.entity === entity),
  )
}

/** Waits until every outbox item of `entity` left the pending state. */
export async function warteAufPush(page: Page, entity: string, timeout = 30_000): Promise<void> {
  await expect.poll(async () => (await ausstehend(page, entity)).length, { timeout }).toBe(0)
}

/** Triggers "Jetzt synchronisieren" in the sync panel and waits for the run. */
export async function synchronisieren(page: Page): Promise<void> {
  await page.locator('.sync-indicator').click()
  const knopf = page.getByRole('button', { name: /Jetzt synchronisieren|Synchronisiere/ })
  await expect(knopf).toBeEnabled()
  await knopf.click()
  await expect(knopf).toHaveText('Jetzt synchronisieren', { timeout: 60_000 })
  await page.getByRole('button', { name: 'Schließen' }).click()
}

/**
 * Syncs until the assertion holds. A single run may legitimately miss a
 * change the other client pushed a moment later, so this retries.
 */
export async function synchronisiereBis(
  page: Page,
  pruefung: () => Promise<void>,
  timeout = 60_000,
): Promise<void> {
  await expect(async () => {
    await synchronisieren(page)
    await pruefung()
  }).toPass({ timeout, intervals: [1_000, 2_000, 3_000] })
}

/** Switches a client's network off/on and waits for the app to notice. */
export async function setzeOffline(page: Page, offline: boolean): Promise<void> {
  await page.context().setOffline(offline)
  const banner = page.getByText('Offline – Daten werden lokal gespeichert')
  if (offline) await expect(banner).toBeVisible()
  else await expect(banner).toBeHidden()
}

// Seeds the freshly migrated E2E database through the public API, exactly
// like an operator would: first-run setup (admin + Hauptlager + five sample
// articles), then a second user for the second browser. The forced password
// change for the new user is completed here so the specs can log straight in.

import { expect, test as setup } from '@playwright/test'
import { ADMIN, LAGERIST } from './helpers.ts'

setup('Datenbank anlegen: Admin, Lagerist, Beispielartikel', async ({ request }) => {
  const status = await request.get('/api/auth/setup-status')
  expect(status.ok()).toBeTruthy()
  expect(await status.json(), 'E2E database must be empty').toMatchObject({ setupRequired: true })

  const setupRes = await request.post('/api/auth/setup', {
    data: { anzeigename: ADMIN.name, email: ADMIN.email, passwort: ADMIN.passwort },
  })
  expect(setupRes.status(), await setupRes.text()).toBe(201)

  const adminToken = await apiLogin(request, ADMIN.email, ADMIN.passwort)

  const userRes = await request.post('/api/users', {
    headers: { authorization: `Bearer ${adminToken}` },
    data: {
      email: LAGERIST.email,
      password: LAGERIST.passwort,
      rollen: ['user', 'lagerist'],
      anzeigename: LAGERIST.name,
    },
  })
  expect(userRes.status(), await userRes.text()).toBe(201)

  // New users must replace their initial password on first login. Setting
  // the same password again clears the flag.
  const lageristToken = await apiLogin(request, LAGERIST.email, LAGERIST.passwort)
  const pwRes = await request.post('/api/auth/change-password', {
    headers: { authorization: `Bearer ${lageristToken}` },
    data: { oldPassword: '', newPassword: LAGERIST.passwort },
  })
  expect(pwRes.status(), await pwRes.text()).toBe(204)
})

async function apiLogin(
  request: import('@playwright/test').APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  const res = await request.post('/api/auth/login', { data: { email, password } })
  expect(res.ok(), await res.text()).toBeTruthy()
  const body = (await res.json()) as { token: string }
  return body.token
}

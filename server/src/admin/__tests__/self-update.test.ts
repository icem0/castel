// Tests fuer das Self-Update (der API-Container ersetzt sich selbst).
//
// Die Docker-API wird nicht real aufgerufen - getestet werden die pure
// Teile: das Zerlegen einer Image-Referenz und das Bauen des create-Payloads
// fuer den geklonten Container. Das Payload entscheidet darueber, ob der
// Klon danach wirklich wie der alte laeuft (Name, Labels, Mounts, Ports,
// Netzwerk-Aliase) - ein Fehler dort waere ein stiller Ausfall des Updates.

import { describe, expect, it } from 'vitest'
import { bildReferenzTeilen, clonePayload } from '../self-update.js'
import type { DockerInspect } from '../docker-api.js'

describe('bildReferenzTeilen', () => {
  it('trennt Repo und Tag', () => {
    expect(bildReferenzTeilen('ghcr.io/icem0/castel-api:latest')).toEqual({
      repo: 'ghcr.io/icem0/castel-api',
      tag: 'latest',
    })
  })

  it('nutzt latest, wenn kein Tag dasteht', () => {
    expect(bildReferenzTeilen('ghcr.io/icem0/castel-api')).toEqual({
      repo: 'ghcr.io/icem0/castel-api',
      tag: 'latest',
    })
  })

  it('versteht einen Port im Registry-Namen', () => {
    expect(bildReferenzTeilen('localhost:5000/castel-api:v1.2.3')).toEqual({
      repo: 'localhost:5000/castel-api',
      tag: 'v1.2.3',
    })
  })

  it('ignoriert einen Digest', () => {
    expect(bildReferenzTeilen('ghcr.io/icem0/castel-api@sha256:abcdef')).toEqual({
      repo: 'ghcr.io/icem0/castel-api',
      tag: 'latest',
    })
  })
})

const INSPECT: DockerInspect = {
  Id: 'abc123',
  Name: '/castel-api-1',
  Config: {
    Image: 'ghcr.io/icem0/castel-api:latest',
    Cmd: ['node', 'dist/index.js'],
    Entrypoint: ['sh', '-c'],
    Env: ['NODE_ENV=production', 'PORT=3000'],
    Labels: {
      'com.docker.compose.project': 'castel',
      'com.docker.compose.service': 'api',
    },
    ExposedPorts: { '3000/tcp': {} },
    WorkingDir: '/app',
    User: 'castel',
    StopSignal: 'SIGTERM',
    Healthcheck: { Test: ['CMD', 'node', '-e', 'x'], Interval: 30_000_000_000, Retries: 3 },
  },
  HostConfig: {
    Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
    PortBindings: {},
    RestartPolicy: { Name: 'unless-stopped' },
    NetworkMode: 'castel_internal',
    ExtraHosts: ['host.docker.internal:host-gateway'],
    LogConfig: { Type: 'json-file' },
    Mounts: [
      { Type: 'volume', Name: 'pgdata', Source: 'pgdata', Destination: '/var/lib/castel/fotos' },
    ],
  },
  NetworkSettings: {
    Networks: {
      castel_internal: { IPAddress: '172.20.0.3', Aliases: ['api', 'castel-api-1'] },
    },
    Ports: {},
  },
}

describe('clonePayload', () => {
  const payload = clonePayload(INSPECT, 'sha256:newimage', 'castel-api-1')

  it('nutzt die neue Image-ID und den Originalnamen', () => {
    expect(payload['Image']).toBe('sha256:newimage')
    expect(payload['name']).toBe('castel-api-1')
  })

  it('behaelt Umgebung, Labels und Ports', () => {
    expect(payload['Env']).toEqual(['NODE_ENV=production', 'PORT=3000'])
    expect(payload['Labels']).toMatchObject({
      'com.docker.compose.project': 'castel',
      'com.docker.compose.service': 'api',
    })
    expect(payload['ExposedPorts']).toMatchObject({ '3000/tcp': {} })
  })

  it('uebernimmt die Mounts statt der Binds', () => {
    const hostConfig = payload['HostConfig'] as Record<string, unknown>
    expect(hostConfig['Mounts']).toHaveLength(1)
    expect(hostConfig['Binds']).toBeUndefined()
  })

  it('behaelt die Netzwerk-Aliase (DNS auf den Service-Namen)', () => {
    const networking = payload['NetworkingConfig'] as {
      EndpointsConfig: Record<string, { Aliases: string[] }>
    }
    expect(networking.EndpointsConfig['castel_internal']?.Aliases).toEqual(['api', 'castel-api-1'])
    // Eigenes Netzwerk: NetworkMode waere doppelt gemoppelt.
    const hostConfig = payload['HostConfig'] as Record<string, unknown>
    expect(hostConfig['NetworkMode']).toBeUndefined()
  })

  it('setzt NetworkMode nur bei den Default-Netzwerken', () => {
    const bridge = clonePayload(
      { ...INSPECT, HostConfig: { ...INSPECT.HostConfig, NetworkMode: 'bridge' } },
      'sha256:newimage',
      'x',
    )
    expect((bridge['HostConfig'] as Record<string, unknown>)['NetworkMode']).toBe('bridge')
  })

  it('behaelt den Healthcheck', () => {
    expect(payload['Healthcheck']).toMatchObject({ Test: ['CMD', 'node', '-e', 'x'] })
  })

  it('uebernimmt keine Read-only-Felder', () => {
    expect(payload).not.toHaveProperty('State')
    expect(payload).not.toHaveProperty('Id')
    expect(payload).not.toHaveProperty('Created')
  })
})

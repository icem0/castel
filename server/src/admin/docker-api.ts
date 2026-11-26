// Minimaler Docker-Client ueber den Unix-Socket.
//
// Der API-Container aktualisiert sich selbst (siehe self-update.ts): er zieht
// die neuen Images, klont die Container mit der neuen Image-ID und startet sie
// - ohne Sidecar-Container, ohne docker-CLI und ohne compose. Deshalb wird die
// Docker-HTTP-API direkt angesprochen.
//
// Der Socket ist eine Root-Sache: wer ihn im Container sieht, kann den Host
// steuern. Deshalb ist der Mount optional (CASTEL_SELF_UPDATE=false schaltet
// das Feature ab) und der Socket haengt an der Server-Instanz, nicht am
// Web-Frontend.

import http from 'node:http'
import fs from 'node:fs'

export const DOCKER_SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock'

export type DockerContainerSummary = {
  Id: string
  Names: string[]
  Image: string
  Labels: Record<string, string>
  State: string
  Status: string
}

export type DockerInspect = {
  Id: string
  Name: string
  Config: {
    Image: string
    Cmd?: string[] | null
    Entrypoint?: string[] | null
    Env?: string[] | null
    Labels?: Record<string, string>
    ExposedPorts?: Record<string, unknown>
    WorkingDir?: string
    User?: string
    StopSignal?: string | null
    Healthcheck?: Record<string, unknown> | null
  }
  HostConfig: {
    Binds?: string[] | null
    PortBindings?: Record<string, unknown> | null
    RestartPolicy?: Record<string, unknown>
    NetworkMode?: string
    ExtraHosts?: string[] | null
    LogConfig?: Record<string, unknown>
    Mounts?: Array<Record<string, unknown>>
    AutoRemove?: boolean
  }
  NetworkSettings: {
    Networks?: Record<string, { IPAddress?: string; Aliases?: string[] | null }>
    Ports?: Record<string, unknown>
  }
}

/** True, wenn der Docker-Socket im Container sichtbar ist. */
export function dockerSichtbar(): boolean {
  try {
    return fs.existsSync(DOCKER_SOCKET)
  } catch {
    return false
  }
}

/**
 * Ruft die Docker-HTTP-API auf. `body` wird als JSON gesendet, die Antwort
 * als JSON geparst. Fehler der Daemon-API kommen als Error mit `status`.
 */
export async function dockerRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 120_000,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        method,
        path,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const status = res.statusCode ?? 0
          if (status >= 400) {
            reject(new Error(`Docker-API ${method} ${path} → HTTP ${status}: ${text.slice(0, 300)}`))
            return
          }
          if (text.trim() === '') {
            resolve(undefined as T)
            return
          }
          try {
            resolve(JSON.parse(text) as T)
          } catch {
            resolve(text as unknown as T)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`Docker-API ${method} ${path} → Timeout`)))
    req.on('error', (e) => reject(e))
    if (payload) req.write(payload)
    req.end()
  })
}

/** Container eines Compose-Projekts (Label-Filter). */
export async function containerProjekt(project: string): Promise<DockerContainerSummary[]> {
  const filter = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }))
  const res = await dockerRequest<DockerContainerSummary[]>(
    'GET',
    `/containers/json?all=true&filters=${filter}`,
  )
  return Array.isArray(res) ? res : []
}

/** Einen Container im Detail ansehen. */
export async function containerInspect(id: string): Promise<DockerInspect> {
  return await dockerRequest<DockerInspect>('GET', `/containers/${id}/json`)
}

/**
 * Zieht ein Image. Die Daemon-API streamt den Fortschritt; am Ende steht
 * entweder ein Fehler-Status oder "Download complete".
 */
export async function imageZiehen(repo: string, tag = 'latest'): Promise<void> {
  const query = `fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`
  const text = await dockerRequest<string>('POST', `/images/create?${query}`)
  if (typeof text === 'string' && /"error"\s*:/.test(text)) {
    throw new Error(`Image-Pull ${repo}:${tag} fehlgeschlagen: ${text.slice(-300)}`)
  }
}

/** Startet einen Container. */
export async function containerStarten(id: string): Promise<void> {
  await dockerRequest('POST', `/containers/${id}/start`)
}

/** Stoppt einen Container (SIGTERM, dann SIGKILL nach 10s). */
export async function containerStoppen(id: string): Promise<void> {
  try {
    await dockerRequest('POST', `/containers/${id}/stop?t=10`)
  } catch {
    // Der Container ist dann schon weg - das ist kein Fehler.
  }
}

/** Entfernt einen Container. */
export async function containerEntfernen(id: string): Promise<void> {
  try {
    await dockerRequest('DELETE', `/containers/${id}?force=true&v=true`)
  } catch {
    // Bereits entfernt.
  }
}

/** Benennt einen Container um (fuer den Clone mit dem gleichen Namen). */
export async function containerUmbenennen(id: string, name: string): Promise<void> {
  await dockerRequest('POST', `/containers/${id}/rename?name=${encodeURIComponent(name)}`)
}

/** Legt einen Container an. */
export async function containerErstellen(payload: Record<string, unknown>): Promise<{ Id: string }> {
  return await dockerRequest<{ Id: string }>(
    'POST',
    `/containers/create?name=${encodeURIComponent(String(payload['name'] ?? ''))}`,
    payload,
  )
}

/** Entfernt ungenutzte Images (docker image prune -a). */
export async function imagesAufrraeumen(): Promise<void> {
  try {
    await dockerRequest('POST', '/images/prune?filters=%7B%22dangling%22%3Afalse%7D')
  } catch {
    // Prune ist optional.
  }
}

/**
 * Die Container-Id des eigenen Prozesses. Im Docker steht sie in
 * /proc/self/cgroup (v1) oder im Hostnamen (v2).
 */
export function eigeneContainerId(): string | null {
  try {
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8')
    const treffer = cgroup.match(/\/(?:docker[-/]|containerd[-/])([0-9a-f]{12,64})/)
    if (treffer?.[1]) return treffer[1]
  } catch {
    // weiter mit dem Hostnamen
  }
  try {
    const host = fs.readFileSync('/etc/hostname', 'utf8').trim()
    if (/^[0-9a-f]{12,64}$/.test(host)) return host
  } catch {
    // keine Id
  }
  return null
}

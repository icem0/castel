// Self-Update: der API-Container aktualisiert den Stack selbst.
//
// Ablauf (alles im vorhandenen API-Container, KEIN Sidecar, kein drittes
// Image, kein Webhook-Listener):
//   1. Der Admin klickt "Jetzt aktualisieren" -> POST /api/admin/update/request
//   2. Der API-Container zieht die neuen Images ueber die Docker-Socket,
//      klont den PWA-Container mit der neuen Image-ID, startet ihn und
//      entfernt den alten.
//   3. Danach klont er sich selbst (neue Image-ID), startet den Klon und
//      beendet sich. Der alte Container wird von der Daemon-API gestoppt.
//   4. Der NEUE API-Container erkennt beim Start den Marker
//      `server.updateState` (phase=running) und macht den Rest:
//      Health-Check, Image-Purge und Status "done".
//
// Warum der Umweg ueber den Marker: ein Container kann sich nicht selbst
// ersetzen und dabei weiterlaufen - der Prozess stirbt mit dem alten
// Container. Der Zustand liegt deshalb in der DB, die den Neustart
// ueberlebt.
//
// Voraussetzungen: der Docker-Socket muss im Container sichtbar sein
// (docker-compose.yml: volumes: /var/run/docker.sock). Ohne Socket meldet
// die API "Self-Update nicht moeglich" und der Lauf bleibt beim Marker.

import {
  containerEntfernen,
  containerErstellen,
  containerInspect,
  containerProjekt,
  containerStarten,
  containerStoppen,
  containerUmbenennen,
  dockerRequest,
  dockerSichtbar,
  eigeneContainerId,
  imageZiehen,
  imagesAufrraeumen,
  type DockerContainerSummary,
  type DockerInspect,
} from './docker-api.js'
import { readUpdateState, writeUpdateState } from './update-routes.js'

/** Der Socket muss im Container sichtbar sein, sonst gibt es kein Self-Update. */
export function selfUpdateMoeglich(): boolean {
  return dockerSichtbar()
}

/**
 * Zerlegt eine Image-Referenz in Repo und Tag: "ghcr.io/icem0/castel-api:latest"
 * -> { repo: "ghcr.io/icem0/castel-api", tag: "latest" }.
 */
export function bildReferenzTeilen(image: string): { repo: string; tag: string } {
  const ohneDigest = image.split('@')[0] ?? image
  const letzterDoppelpunkt = ohneDigest.lastIndexOf(':')
  const slash = ohneDigest.lastIndexOf('/')
  if (letzterDoppelpunkt > slash && letzterDoppelpunkt > 0) {
    return {
      repo: ohneDigest.slice(0, letzterDoppelpunkt),
      tag: ohneDigest.slice(letzterDoppelpunkt + 1),
    }
  }
  return { repo: ohneDigest, tag: 'latest' }
}

/**
 * Baut aus einem inspect-Report das create-Payload fuer den Klon. Nur die
 * Felder, die die Daemon-API beim Anlegen akzeptiert - Read-only-Felder
 * (State, Created, Id ...) werden bewusst nicht uebernommen.
 */
export function clonePayload(
  inspect: DockerInspect,
  neueImageId: string,
  neuerName: string,
): Record<string, unknown> {
  const config = inspect.Config ?? ({} as DockerInspect['Config'])
  const host = inspect.HostConfig ?? ({} as DockerInspect['HostConfig'])
  const networks = inspect.NetworkSettings?.Networks ?? {}

  const endpoints: Record<string, unknown> = {}
  for (const [name, net] of Object.entries(networks)) {
    endpoints[name] = { Aliases: net.Aliases ?? [] }
  }

  const hostConfig: Record<string, unknown> = {
    Binds: host.Binds ?? undefined,
    PortBindings: host.PortBindings ?? undefined,
    RestartPolicy: host.RestartPolicy ?? undefined,
    ExtraHosts: host.ExtraHosts ?? undefined,
    LogConfig: host.LogConfig ?? undefined,
  }
  // Mounts und Binds nicht gleichzeitig senden - der Daemon nimmt sonst den
  // Mount (Host-Pfad) und ignoriert das Bind.
  if (Array.isArray(host.Mounts) && host.Mounts.length > 0) {
    hostConfig.Mounts = host.Mounts
    delete hostConfig.Binds
  }
  // NetworkMode nur fuer die Default-Networks; eigene Netzwerke kommen ueber
  // NetworkingConfig.
  const mode = host.NetworkMode ?? ''
  if (mode === 'bridge' || mode === 'host' || mode === 'none') hostConfig.NetworkMode = mode

  const payload: Record<string, unknown> = {
    name: neuerName,
    Image: neueImageId,
    Cmd: config.Cmd ?? undefined,
    Entrypoint: config.Entrypoint ?? undefined,
    Env: config.Env ?? undefined,
    Labels: config.Labels ?? undefined,
    ExposedPorts: config.ExposedPorts ?? undefined,
    WorkingDir: config.WorkingDir || undefined,
    User: config.User || undefined,
    StopSignal: config.StopSignal ?? undefined,
    HostConfig: hostConfig,
  }
  if (config.Healthcheck && typeof config.Healthcheck === 'object') {
    const hc = config.Healthcheck as Record<string, unknown>
    payload.Healthcheck = {
      Test: hc.Test,
      Interval: hc.Interval,
      Timeout: hc.Timeout,
      Retries: hc.Retries,
      StartPeriod: hc.StartPeriod,
    }
  }
  if (Object.keys(endpoints).length > 0) payload.NetworkingConfig = { EndpointsConfig: endpoints }
  return payload
}

function statusDokument(phase: string, step: string | null, message: string | null): string {
  return JSON.stringify({
    phase,
    ok: null,
    exitCode: null,
    requestedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    step,
    message,
    log: null,
    gitBefore: null,
    gitAfter: null,
    versionBefore: null,
    versionAfter: null,
    imageTag: null,
    host: null,
  })
}

async function projektName(): Promise<string | null> {
  const id = eigeneContainerId()
  if (!id) return process.env.COMPOSE_PROJECT_NAME ?? null
  try {
    const inspect = await containerInspect(id)
    const labels = inspect.Config?.Labels ?? {}
    return labels['com.docker.compose.project'] ?? process.env.COMPOSE_PROJECT_NAME ?? null
  } catch {
    return process.env.COMPOSE_PROJECT_NAME ?? null
  }
}

function serviceVon(summary: DockerContainerSummary): string {
  return summary.Labels?.['com.docker.compose.service'] ?? ''
}

/**
 * Klont einen Container mit einer neuen Image-ID: alten umbenennen, Klon
 * anlegen, starten, alten stoppen und entfernen. Der Klon behaelt Namen,
 * Labels, Umgebung, Mounts, Ports und Netzwerk-Aliase - damit Compose und
 * der nginx (DNS auf den Service-Namen) weiter funktionieren.
 */
export async function containerTauschen(
  summary: DockerContainerSummary,
  neueImageId: string,
): Promise<void> {
  const inspect = await containerInspect(summary.Id)
  const name = (summary.Names[0] ?? '').replace(/^\//, '')
  const alterName = `${name}-old`
  await containerUmbenennen(summary.Id, alterName)
  const payload = clonePayload(inspect, neueImageId, name)
  const neu = await containerErstellen(payload)
  await containerStarten(neu.Id)
  await containerStoppen(summary.Id)
  await containerEntfernen(summary.Id)
}

async function imageIdNachPull(repo: string, tag: string): Promise<string> {
  await imageZiehen(repo, tag)
  const inspektion = await dockerRequest<{ Id: string }>(
    'GET',
    `/images/${encodeURIComponent(`${repo}:${tag}`)}/json`,
  )
  return inspektion.Id
}

export type SelfUpdateErgebnis = {
  ok: boolean
  message: string
  /** true, wenn der API-Container sich selbst ersetzt hat (der Prozess endet). */
  selbstErsetzt: boolean
}

/**
 * Führt das Self-Update aus: Images ziehen, PWA tauschen, API tauschen.
 * Beim API-Tausch beendet sich der Prozess - der neue Container macht weiter.
 */
export async function selfUpdateStarten(): Promise<SelfUpdateErgebnis> {
  if (!selfUpdateMoeglich()) {
    return {
      ok: false,
      message:
        'Self-Update nicht moeglich: der Docker-Socket ist im Container nicht sichtbar. ' +
        'Bitte UPDATE_RUNNER/Externe-Update-Dienst nutzen.',
      selbstErsetzt: false,
    }
  }

  const projekt = await projektName()
  if (!projekt) {
    return {
      ok: false,
      message: 'Self-Update nicht moeglich: das Compose-Projekt liess sich nicht ermitteln.',
      selbstErsetzt: false,
    }
  }

  const container = await containerProjekt(projekt)
  const eigeneId = eigeneContainerId()
  const api = container.find((c) => c.Id === eigeneId) ?? container.find((c) => serviceVon(c) === 'api')
  const pwa = container.find((c) => serviceVon(c) === 'pwa')
  if (!api) {
    return {
      ok: false,
      message: 'Self-Update nicht moeglich: der api-Container wurde nicht gefunden.',
      selbstErsetzt: false,
    }
  }

  const tag = process.env.CASTEL_IMAGE_TAG ?? 'latest'

  try {
    // 1) PWA zuerst: die Oberflaeche ist danach aktuell, der API-Container
    //    laeuft noch. Das Update laeuft also nie gegen eine alte Oberflaeche.
    if (pwa) {
      const { repo } = bildReferenzTeilen(pwa.Image)
      await writeUpdateState(statusDokument('running', 'images', 'Image wird gezogen …'))
      const neueId = await imageIdNachPull(repo, tag)
      await containerTauschen(pwa, neueId)
    }

    // 2) Der API-Container selbst: neues Image ziehen, Klon starten, dann
    //    beendet sich der alte Prozess mit dem alten Container.
    const { repo } = bildReferenzTeilen(api.Image)
    await writeUpdateState(
      statusDokument('running', 'api-restart', 'API-Container wird ersetzt …'),
    )
    const neueId = await imageIdNachPull(repo, tag)
    await containerTauschen(api, neueId)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await writeUpdateState(statusDokument('failed', 'self-update', `Self-Update fehlgeschlagen: ${message}`))
    return { ok: false, message, selbstErsetzt: false }
  }

  // Der alte Container wird jetzt gestoppt - der Prozess endet hier.
  return {
    ok: true,
    message: 'Update ausgefuehrt: der API-Container wurde ersetzt.',
    selbstErsetzt: true,
  }
}

/**
 * Beendet ein laufendes Self-Update ab: laeuft beim Start des neuen
 * API-Containers und macht Health-Check, Prune und Status "done".
 */
export async function selfUpdateAbschliessen(): Promise<void> {
  const state = await readUpdateState()
  if (state.phase !== 'running') return
  const step = state.step ?? ''
  if (!step.startsWith('api-restart') && !step.startsWith('images')) return

  const projekt = await projektName()
  if (projekt) {
    const container = await containerProjekt(projekt)
    const eigeneId = eigeneContainerId()
    const api = container.find((c) => c.Id === eigeneId) ?? container.find((c) => serviceVon(c) === 'api')
    const pwa = container.find((c) => serviceVon(c) === 'pwa')
    for (const ziel of [api, pwa]) {
      if (!ziel) continue
      try {
        const detail = await containerInspect(ziel.Id)
        const health = (detail as unknown as { State?: { Health?: { Status?: string } } }).State?.Health
          ?.Status
        if (health && health !== 'healthy') {
          await writeUpdateState(
            statusDokument('failed', 'health', `Container ${ziel.Names[0] ?? ziel.Id} ist ${health}.`),
          )
          return
        }
      } catch {
        // Ignore: der Health-Status ist optional.
      }
    }
  }

  await imagesAufrraeumen()
  await writeUpdateState(
    statusDokument('done', 'done', 'Update abgeschlossen (Self-Update im API-Container).'),
  )
}

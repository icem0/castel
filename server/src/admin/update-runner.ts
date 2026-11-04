// Starts the host-side update as a short-lived sibling container.
//
// WHY A SEPARATE CONTAINER
//   The API container cannot update its own stack directly: `docker compose up`
//   recreates the api container and would kill the process halfway through.
//   Instead we start a throwaway container from the same image that is NOT part
//   of the compose project. It survives the recreation, runs scripts/update.sh
//   and then exits (--rm). The API only needs the Docker socket to start it.
//
// WHAT THE UPDATER CONTAINER MOUNTS
//   - /var/run/docker.sock : to control the host daemon
//   - the host project dir : to read the compose files and run scripts/update.sh
//   The host project dir is read from the compose label
//   `com.docker.compose.project.working_dir` of the api container itself.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type RunResult = { stdout: string; stderr: string }
export type RunFn = (cmd: string, args: string[]) => Promise<RunResult>

const defaultRun: RunFn = async (cmd, args) => {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
}

export type DockerProbe = {
  available: boolean
  /** Why the daemon is not reachable (only set when available is false). */
  reason: string | null
}

/** Unix socket path the CLI talks to, or null for remote (tcp/ssh) daemons. */
function dockerSocketPath(): string | null {
  const host = process.env.DOCKER_HOST
  if (host) {
    return host.startsWith('unix://') ? host.slice('unix://'.length) : null
  }
  return '/var/run/docker.sock'
}

/**
 * Probes the Docker daemon and classifies the failure so the admin UI can
 * show an actionable hint (missing CLI vs. missing socket vs. permission).
 */
export async function probeDocker(run: RunFn = defaultRun): Promise<DockerProbe> {
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}'])
    return { available: true, reason: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/spawn docker ENOENT|docker: (command )?not found|command not found/i.test(message)) {
      return { available: false, reason: 'DOCKER_CLI_MISSING' }
    }
    if (/permission denied|EACCES/i.test(message)) {
      return { available: false, reason: 'SOCKET_PERMISSION' }
    }
    if (/cannot connect to the docker daemon|is the docker daemon running/i.test(message)) {
      const socket = dockerSocketPath()
      if (socket && !existsSync(socket)) {
        return { available: false, reason: 'SOCKET_MISSING' }
      }
      return { available: false, reason: 'DOCKER_UNAVAILABLE' }
    }
    return { available: false, reason: 'DOCKER_UNAVAILABLE' }
  }
}

/** True when the Docker daemon is reachable from this process. */
export async function dockerReachable(run: RunFn = defaultRun): Promise<boolean> {
  return (await probeDocker(run)).available
}

/** The container id of the current process (Docker writes it to /etc/hostname). */
function selfContainerId(): string {
  try {
    return readFileSync('/etc/hostname', 'utf8').trim()
  } catch {
    return process.env.HOSTNAME ?? ''
  }
}

export type StartUpdaterDeps = {
  run?: RunFn
  selfId?: string
  image?: string
  hostDir?: string
  containerName?: string
}

export type StartUpdaterResult = {
  started: boolean
  /** Machine-readable reason when started is false. */
  reason?: string
  container?: string
  image?: string
  hostDir?: string
}

/**
 * Starts the updater container. Returns started=false with a reason instead of
 * throwing, so the caller can fall back to the manual path and report why.
 */
export async function startUpdater(deps: StartUpdaterDeps = {}): Promise<StartUpdaterResult> {
  const run = deps.run ?? defaultRun
  const name = deps.containerName ?? process.env.CASTEL_UPDATER_CONTAINER ?? 'castel-updater'

  if (!(await dockerReachable(run))) {
    return { started: false, reason: 'DOCKER_UNAVAILABLE' }
  }

  const selfId = deps.selfId ?? selfContainerId()
  let image = deps.image ?? process.env.CASTEL_UPDATE_IMAGE ?? ''
  let hostDir = deps.hostDir ?? process.env.CASTEL_REPO_DIR ?? ''

  if (!image && selfId) {
    try {
      const { stdout } = await run('docker', ['inspect', '--format', '{{.Config.Image}}', selfId])
      image = stdout.trim()
    } catch {
      /* keep empty - reported below */
    }
  }

  if (!hostDir && selfId) {
    try {
      const { stdout } = await run('docker', [
        'inspect',
        '--format',
        '{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
        selfId,
      ])
      hostDir = stdout.trim()
    } catch {
      /* keep empty - reported below */
    }
  }

  if (!image) return { started: false, reason: 'IMAGE_UNKNOWN' }
  if (!hostDir) return { started: false, reason: 'PROJECT_DIR_UNKNOWN' }

  // Refuse to start a second updater; drop a stale, stopped one.
  try {
    const { stdout } = await run('docker', ['inspect', '--format', '{{.State.Running}}', name])
    if (stdout.trim() === 'true') {
      return { started: false, reason: 'ALREADY_RUNNING', container: name }
    }
    await run('docker', ['rm', '-f', name])
  } catch {
    /* container does not exist yet */
  }

  const args = [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    // Root inside the throwaway container: it must reach the socket and may
    // need to write to the checkout regardless of the host file owner.
    '--user',
    '0:0',
    '--entrypoint',
    '/bin/bash',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${hostDir}:${hostDir}`,
    '-w',
    hostDir,
    image,
    '-c',
    'exec ./scripts/update.sh --if-requested',
  ]

  try {
    await run('docker', args)
    return { started: true, container: name, image, hostDir }
  } catch {
    return { started: false, reason: 'SPAWN_FAILED', container: name, image, hostDir }
  }
}

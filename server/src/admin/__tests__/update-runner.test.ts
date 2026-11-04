import { describe, expect, it, vi } from 'vitest'
import { startUpdater, type RunFn } from '../update-runner.js'

type Call = { cmd: string; args: string[] }

function makeRun(handler: (call: Call) => { stdout?: string; stderr?: string } | Error): {
  run: RunFn
  calls: Call[]
} {
  const calls: Call[] = []
  const run: RunFn = async (cmd, args) => {
    const call = { cmd, args }
    calls.push(call)
    const result = handler(call)
    if (result instanceof Error) throw result
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  return { run, calls }
}

const baseHandler = (call: Call) => {
  const joined = call.args.join(' ')
  if (joined.startsWith('version')) return { stdout: '27.0.0' }
  if (joined.includes('{{.Config.Image}}')) return { stdout: 'ghcr.io/icem0/castel-api:latest' }
  if (joined.includes('project.working_dir')) return { stdout: '/opt/docker/castel' }
  if (joined.includes('{{.State.Running}}')) return new Error('no such container')
  if (call.args[0] === 'run') return { stdout: 'container-id' }
  return { stdout: '' }
}

describe('startUpdater', () => {
  it('startet einen abgesetzten Updater-Container mit Socket und Projektordner', async () => {
    const { run, calls } = makeRun(baseHandler)
    const result = await startUpdater({ run, selfId: 'abc123' })

    expect(result.started).toBe(true)
    expect(result.image).toBe('ghcr.io/icem0/castel-api:latest')
    expect(result.hostDir).toBe('/opt/docker/castel')

    const runCall = calls.find((c) => c.args[0] === 'run')
    expect(runCall).toBeDefined()
    const args = runCall!.args.join(' ')
    expect(args).toContain('--name castel-updater')
    expect(args).toContain('/var/run/docker.sock:/var/run/docker.sock')
    expect(args).toContain('-v /opt/docker/castel:/opt/docker/castel')
    expect(args).toContain('ghcr.io/icem0/castel-api:latest')
    expect(args).toContain('./scripts/update.sh --if-requested')
  })

  it('nutzt explizite Image- und Pfad-Overrides ohne inspect', async () => {
    const { run, calls } = makeRun(baseHandler)
    const result = await startUpdater({
      run,
      selfId: 'abc123',
      image: 'ghcr.io/icem0/castel-api:v1.2.3',
      hostDir: '/srv/castel',
    })
    expect(result.started).toBe(true)
    expect(calls.some((c) => c.args.join(' ').includes('{{.Config.Image}}'))).toBe(false)

    const args = calls.find((c) => c.args[0] === 'run')!.args.join(' ')
    expect(args).toContain('-v /srv/castel:/srv/castel')
    expect(args).toContain('ghcr.io/icem0/castel-api:v1.2.3')
  })

  it('meldet DOCKER_UNAVAILABLE, wenn der Daemon nicht erreichbar ist', async () => {
    const { run } = makeRun((call) => {
      if (call.args.join(' ').startsWith('version')) return new Error('no docker')
      return { stdout: '' }
    })
    const result = await startUpdater({ run, selfId: 'abc123' })
    expect(result.started).toBe(false)
    expect(result.reason).toBe('DOCKER_UNAVAILABLE')
  })

  it('startet keinen zweiten Updater, wenn einer laeuft', async () => {
    const { run, calls } = makeRun((call) => {
      const joined = call.args.join(' ')
      if (joined.startsWith('version')) return { stdout: '27.0.0' }
      if (joined.includes('{{.Config.Image}}')) return { stdout: 'img' }
      if (joined.includes('project.working_dir')) return { stdout: '/opt/castel' }
      if (joined.includes('{{.State.Running}}')) return { stdout: 'true' }
      return { stdout: '' }
    })
    const result = await startUpdater({ run, selfId: 'abc123' })
    expect(result.started).toBe(false)
    expect(result.reason).toBe('ALREADY_RUNNING')
    expect(calls.some((c) => c.args[0] === 'run')).toBe(false)
  })

  it('meldet SPAWN_FAILED, wenn der Start fehlschlaegt', async () => {
    const { run } = makeRun((call) => {
      if (call.args[0] === 'run') return new Error('cannot start')
      return baseHandler(call)
    })
    const result = await startUpdater({
      run,
      selfId: 'abc123',
      image: 'img',
      hostDir: '/opt/castel',
      containerName: 'castel-updater',
    })
    expect(result.started).toBe(false)
    expect(result.reason).toBe('SPAWN_FAILED')
  })
})

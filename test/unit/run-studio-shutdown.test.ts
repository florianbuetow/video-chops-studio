import { PassThrough, Readable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EXIT_SUCCESS, run } from '../../src/cli/run.js'
import { startStudio } from '../../src/cli/studio-server.js'

vi.mock('../../src/cli/studio-server.js', () => ({ startStudio: vi.fn() }))

const originalExitCode = process.exitCode
const originalInterruptListeners = process.listeners('SIGINT')
const originalTerminateListeners = process.listeners('SIGTERM')

afterEach(() => {
  for (const listener of process.listeners('SIGINT')) {
    if (!originalInterruptListeners.includes(listener))
      process.removeListener('SIGINT', listener)
  }
  for (const listener of process.listeners('SIGTERM')) {
    if (!originalTerminateListeners.includes(listener))
      process.removeListener('SIGTERM', listener)
  }
  process.exitCode = originalExitCode
  vi.clearAllMocks()
})

function io() {
  const output: string[] = []
  const errors: string[] = []
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()))
  stderr.on('data', (chunk: Buffer) => errors.push(chunk.toString()))
  return {
    streams: { stdin: Readable.from([]), stdout, stderr },
    stdout: () => output.join(''),
    stderr: () => errors.join(''),
  }
}

const argumentsList = [
  'studio',
  '--input',
  'in',
  '--output',
  'out',
  '--port',
  '4310',
]

interface ControlledShutdown {
  readonly promise: Promise<void>
  resolve(): void
  reject(reason: unknown): void
}

function controlledShutdown(): ControlledShutdown {
  let resolvePromise: () => void = () => undefined
  let rejectPromise: (reason: unknown) => void = () => undefined
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function studioWith(shutdown: Promise<void>) {
  const close = vi.fn().mockResolvedValue(undefined)
  vi.mocked(startStudio).mockResolvedValue({
    url: 'http://127.0.0.1:4310',
    shutdown,
    close,
  })
  return close
}

describe('studio CLI shutdown lifecycle', () => {
  it('announces the URL on stdout as one JSON line and on stderr in words', async () => {
    studioWith(new Promise<void>(() => undefined))
    const captured = io()
    expect(await run(argumentsList, captured.streams)).toBe(EXIT_SUCCESS)
    expect(captured.stdout()).toBe('{"url":"http://127.0.0.1:4310"}\n')
    expect(captured.stderr()).toBe(
      'Video Chops Studio is ready at http://127.0.0.1:4310\n',
    )
    expect(process.listeners('SIGINT')).toHaveLength(
      originalInterruptListeners.length + 1,
    )
    expect(process.listeners('SIGTERM')).toHaveLength(
      originalTerminateListeners.length + 1,
    )
  })

  it('reports a client-requested shutdown and detaches the signal handlers', async () => {
    const shutdown = controlledShutdown()
    studioWith(shutdown.promise)
    const captured = io()
    expect(await run(argumentsList, captured.streams)).toBe(EXIT_SUCCESS)
    shutdown.resolve()
    await flush()
    expect(captured.stderr()).toBe(
      'Video Chops Studio is ready at http://127.0.0.1:4310\nVideo Chops Studio stopped\n',
    )
    expect(captured.stdout()).toBe('{"url":"http://127.0.0.1:4310"}\n')
    expect(process.listeners('SIGINT')).toEqual(originalInterruptListeners)
    expect(process.listeners('SIGTERM')).toEqual(originalTerminateListeners)
    expect(process.exitCode).toBe(originalExitCode)
  })

  it('reports a failed shutdown as an error, sets the exit code, and detaches', async () => {
    const shutdown = controlledShutdown()
    studioWith(shutdown.promise)
    const captured = io()
    expect(await run(argumentsList, captured.streams)).toBe(EXIT_SUCCESS)
    shutdown.reject(new Error('close failed'))
    await flush()
    expect(captured.stderr()).toBe(
      'Video Chops Studio is ready at http://127.0.0.1:4310\nerror: close failed\n',
    )
    expect(process.exitCode).toBe(1)
    expect(process.listeners('SIGINT')).toEqual(originalInterruptListeners)
    expect(process.listeners('SIGTERM')).toEqual(originalTerminateListeners)
  })

  it('stringifies a non-Error shutdown failure', async () => {
    const shutdown = controlledShutdown()
    studioWith(shutdown.promise)
    const captured = io()
    await run(argumentsList, captured.streams)
    shutdown.reject('server vanished')
    await flush()
    expect(captured.stderr()).toContain('error: server vanished\n')
    expect(process.exitCode).toBe(1)
  })

  it('closes once on SIGINT and detaches both signal handlers', async () => {
    const close = studioWith(new Promise<void>(() => undefined))
    const captured = io()
    await run(argumentsList, captured.streams)
    const stop = process
      .listeners('SIGINT')
      .find((listener) => !originalInterruptListeners.includes(listener))
    expect(stop).toBeDefined()
    stop?.('SIGINT')
    await flush()
    expect(close).toHaveBeenCalledTimes(1)
    expect(process.listeners('SIGINT')).toEqual(originalInterruptListeners)
    expect(process.listeners('SIGTERM')).toEqual(originalTerminateListeners)
    expect(captured.stderr()).toBe(
      'Video Chops Studio is ready at http://127.0.0.1:4310\n',
    )
  })

  it('stringifies a non-Error close failure', async () => {
    const close = vi.fn().mockRejectedValue('disk gone')
    vi.mocked(startStudio).mockResolvedValue({
      url: 'http://127.0.0.1:4310',
      shutdown: new Promise<void>(() => undefined),
      close,
    })
    const captured = io()
    await run(argumentsList, captured.streams)
    const stop = process
      .listeners('SIGTERM')
      .find((listener) => !originalTerminateListeners.includes(listener))
    stop?.('SIGTERM')
    await flush()
    expect(captured.stderr()).toContain('error: disk gone\n')
    expect(process.exitCode).toBe(1)
  })
})

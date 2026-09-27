import { PassThrough, Readable } from 'node:stream'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { run } from '../../src/cli/run.js'
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
    output,
    errors,
  }
}

const argumentsList = [
  'studio',
  '--input',
  'data/input',
  '--output',
  'data/output',
  '--port',
  '4310',
]

describe('studio CLI lifecycle', () => {
  it('prints the machine-readable URL and closes cleanly on an interrupt', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    vi.mocked(startStudio).mockResolvedValue({
      url: 'http://127.0.0.1:4310',
      shutdown: new Promise<void>(() => undefined),
      close,
    })
    const captured = io()
    expect(await run(argumentsList, captured.streams)).toBe(0)
    expect(vi.mocked(startStudio).mock.calls[0]?.[0]).toEqual({
      inputDirectory: 'data/input',
      outputDirectory: 'data/output',
      port: 4310,
      publicDirectory: `${resolve('dist/web')}/`,
    })
    expect(JSON.parse(captured.output.join(''))).toEqual({
      url: 'http://127.0.0.1:4310',
    })
    expect(captured.errors.join('')).toContain('Video Chops Studio is ready')
    const stop = process
      .listeners('SIGINT')
      .find((listener) => !originalInterruptListeners.includes(listener))
    expect(stop).toBeDefined()
    stop?.('SIGINT')
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
    expect(process.listeners('SIGINT')).toEqual(originalInterruptListeners)
    expect(process.listeners('SIGTERM')).toEqual(originalTerminateListeners)
  })

  it('reports startup failures as a runtime error', async () => {
    vi.mocked(startStudio).mockRejectedValue(new Error('Port is occupied'))
    const captured = io()
    expect(await run(argumentsList, captured.streams)).toBe(1)
    expect(captured.output).toEqual([])
    expect(captured.errors.join('')).toBe('error: Port is occupied\n')
  })

  it('reports shutdown errors and sets the failure exit code', async () => {
    const close = vi
      .fn()
      .mockRejectedValue(new Error('Could not close the server'))
    vi.mocked(startStudio).mockResolvedValue({
      url: 'http://127.0.0.1:4310',
      shutdown: new Promise<void>(() => undefined),
      close,
    })
    const captured = io()
    expect(await run(argumentsList, captured.streams)).toBe(0)
    const stop = process
      .listeners('SIGTERM')
      .find((listener) => !originalTerminateListeners.includes(listener))
    expect(stop).toBeDefined()
    stop?.('SIGTERM')
    await Promise.resolve()
    expect(captured.errors.join('')).toContain(
      'error: Could not close the server',
    )
    expect(process.exitCode).toBe(1)
  })
})

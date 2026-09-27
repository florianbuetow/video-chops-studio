import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnState = vi.hoisted(() => ({
  behavior: 'success' as 'success' | 'error' | 'signal',
  progress: 'out_time_us=50000\n',
  stderrSize: 140 * 1024,
  delayMilliseconds: 0,
  calls: [] as string[][],
}))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: vi.fn((_command: string, args: readonly string[]) => {
      spawnState.calls.push([...args])
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      const complete = (): void => {
        if (spawnState.behavior === 'error') {
          child.emit('error', new Error('spawn failed'))
          child.emit('close', 1, null)
          return
        }
        if (spawnState.behavior === 'signal') {
          child.stderr.emit('data', Buffer.alloc(spawnState.stderrSize, 'x'))
          child.emit('close', null, 'SIGTERM')
          return
        }
        const outputPath = args.at(-1)
        if (outputPath === undefined) {
          child.emit('error', new Error('missing output path'))
          return
        }
        void writeFile(outputPath, 'mock video').then(() => {
          child.stdout.emit('data', Buffer.from(spawnState.progress))
          child.emit('close', 0, null)
        })
      }
      if (spawnState.delayMilliseconds === 0) queueMicrotask(complete)
      else setTimeout(complete, spawnState.delayMilliseconds)
      return child
    }),
  }
})

import {
  preparePreview,
  renderVideo,
  VideoRenderError,
} from '../../src/application/video-render.js'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function fixture(): Promise<{
  root: string
  input: string
  output: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'video-render-errors-'))
  temporaryDirectories.push(root)
  const input = join(root, 'input')
  const output = join(root, 'output')
  await mkdir(input)
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=size=64x64:rate=25:duration=0.2',
    '-c:v',
    'libx264',
    join(input, 'source.mp4'),
  ])
  return { root, input, output }
}

const request = {
  source: 'source.mp4',
  segments: [{ start: 0, end: 0.1 }],
  crop: { x: 0, y: 0, width: 64, height: 64 },
  outputName: 'result.mp4',
  muted: true,
} as const

afterEach(async () => {
  spawnState.behavior = 'success'
  spawnState.progress = 'out_time_us=50000\n'
  spawnState.stderrSize = 140 * 1024
  spawnState.delayMilliseconds = 0
  spawnState.calls.length = 0
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('render process failures', () => {
  it('parses timestamp progress records and ignores invalid or duplicate records', async () => {
    const { input, output } = await fixture()
    const progress: number[] = []
    spawnState.progress =
      'out_time_us=invalid\nout_time=invalid\nout_time=00:00:00.025\nout_time_us=50000\nout_time_us=50000\n'
    await renderVideo(input, output, request, (fraction) =>
      progress.push(fraction),
    )
    expect(progress).toEqual([0, 0.25, 0.5, 1])
    expect(spawnState.calls).toHaveLength(1)
    expect(spawnState.calls[0]).toEqual(
      expect.arrayContaining([
        '-filter_complex',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-threads',
        '2',
        '-progress',
        'pipe:1',
      ]),
    )
  })

  it('maps a spawn failure to an actionable typed error and ignores the later close event', async () => {
    spawnState.behavior = 'error'
    const { input, output } = await fixture()
    const failure = renderVideo(input, output, request, () => undefined)
    await expect(failure).rejects.toMatchObject({
      name: 'VideoRenderError',
      message:
        'could not start ffmpeg; install FFmpeg and ensure it is on PATH',
      cause: expect.any(Error),
    })
  })

  it('bounds stderr captured from a signal failure', async () => {
    spawnState.behavior = 'signal'
    const { input, output } = await fixture()
    const failure = renderVideo(input, output, request, () => undefined)
    await expect(failure).rejects.toBeInstanceOf(VideoRenderError)
    await expect(failure).rejects.toThrow('signal SIGTERM')
    await expect(failure).rejects.toSatisfy(
      (error: VideoRenderError) =>
        error.message.length > 127 * 1024 &&
        error.message.length < 129 * 1024 &&
        error.message.endsWith('x'),
    )
  })

  it('deduplicates simultaneous preview processes and emits compatibility arguments', async () => {
    spawnState.delayMilliseconds = 20
    const { input, output } = await fixture()
    const [first, second] = await Promise.all([
      preparePreview(input, 'source.mp4', output),
      preparePreview(input, 'source.mp4', output),
    ])
    expect(second).toBe(first)
    expect(spawnState.calls).toHaveLength(1)
    expect(spawnState.calls[0]).toEqual(
      expect.arrayContaining([
        '-map',
        '0:v:0',
        '0:a:0?',
        '-vf',
        "scale=w='min(1280\\,iw)':h='min(1280\\,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
      ]),
    )
    await writeFile(first, '')
    await expect(preparePreview(input, 'source.mp4', output)).rejects.toThrow(
      'preview cache entry is invalid',
    )
    expect((await stat(first)).size).toBe(0)
    expect(spawnState.calls).toHaveLength(1)
  })

  it('keeps simultaneous preview requests isolated by cache directory', async () => {
    spawnState.delayMilliseconds = 20
    const { root, input, output } = await fixture()
    const secondCache = join(root, 'second-cache')
    const [first, second] = await Promise.all([
      preparePreview(input, 'source.mp4', output),
      preparePreview(input, 'source.mp4', secondCache),
    ])
    expect(first).toContain(output)
    expect(second).toContain(secondCache)
    expect(second).not.toBe(first)
    expect(spawnState.calls).toHaveLength(2)
  })

  it('removes failed preview temporaries and returns a typed process failure', async () => {
    spawnState.behavior = 'signal'
    const { input, output } = await fixture()
    await expect(preparePreview(input, 'source.mp4', output)).rejects.toThrow(
      'signal SIGTERM',
    )
    expect(spawnState.calls).toHaveLength(1)
  })
})

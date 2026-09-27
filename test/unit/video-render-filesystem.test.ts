import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

function systemError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

const state = vi.hoisted(() => ({
  accessError: Object.assign(new Error('missing'), {
    code: 'ENOENT',
  }) as Error & {
    code: string
  },
  linkError: null as (Error & { code: string }) | null,
  unlinkError: null as (Error & { code: string }) | null,
  cacheStats: [] as ('missing' | 'directory' | 'empty' | 'file')[],
  spawnMode: 'success' as 'success' | 'failure',
  progress: '',
  linkCalls: [] as [string, string][],
  unlinkCalls: [] as string[],
  spawnCalls: [] as string[][],
}))

vi.mock('node:fs/promises', () => ({
  access: vi.fn(async () => {
    if (state.accessError !== null) throw state.accessError
  }),
  mkdir: vi.fn(async () => undefined),
  realpath: vi.fn(async (path: string) => path),
  link: vi.fn(async (temporaryPath: string, finalPath: string) => {
    state.linkCalls.push([temporaryPath, finalPath])
    if (state.linkError !== null) throw state.linkError
  }),
  unlink: vi.fn(async (path: string) => {
    state.unlinkCalls.push(path)
    if (state.unlinkError !== null) throw state.unlinkError
  }),
  stat: vi.fn(async (path: string) => {
    if (path === '/input/source.mp4') {
      return { isFile: () => true, size: 100, mtimeMs: 123 }
    }
    if (path.startsWith('/cache/') && path.endsWith('.mp4')) {
      const result = state.cacheStats.shift() ?? 'missing'
      if (result === 'missing')
        throw systemError('ENOENT', 'missing cache entry')
      return {
        isFile: () => result !== 'directory',
        size: result === 'empty' ? 0 : 42,
        mtimeMs: 456,
      }
    }
    return { isFile: () => true, size: 42, mtimeMs: 456 }
  }),
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_command: string, args: readonly string[]) => {
    state.spawnCalls.push([...args])
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      if (state.progress.length > 0) {
        child.stdout.emit('data', Buffer.from(state.progress))
      }
      if (state.spawnMode === 'failure') {
        child.stderr.emit('data', Buffer.from('encoding failed'))
        child.emit('close', 1, null)
      } else {
        child.emit('close', 0, null)
      }
    })
    return child
  }),
}))

vi.mock('../../src/application/video-files.js', () => ({
  checkVideoTools: vi.fn(async () => undefined),
  resolveVideo: vi.fn(async () => '/input/source.mp4'),
  probeVideo: vi.fn(async () => ({
    name: 'source.mp4',
    size: 100,
    width: 64,
    height: 64,
    duration: 1,
    fps: 25,
    hasAudio: false,
  })),
}))

import {
  preparePreview,
  renderVideo,
  VideoRenderError,
} from '../../src/application/video-render.js'

const edit = {
  source: 'source.mp4',
  segments: [{ start: 0, end: 0.5 }],
  crop: { x: 0, y: 0, width: 64, height: 64 },
  outputName: 'result.mp4',
  muted: true,
} as const

afterEach(() => {
  state.accessError = systemError('ENOENT', 'missing')
  state.linkError = null
  state.unlinkError = null
  state.cacheStats.length = 0
  state.spawnMode = 'success'
  state.progress = ''
  state.linkCalls.length = 0
  state.unlinkCalls.length = 0
  state.spawnCalls.length = 0
})

describe('render filesystem failures', () => {
  it('fails before encoding when the output path cannot be inspected', async () => {
    state.accessError = systemError('EACCES', 'permission denied')
    const failure = renderVideo('/input', '/output', edit, () => undefined)
    await expect(failure).rejects.toMatchObject({
      name: 'VideoRenderError',
      message: 'cannot inspect output path: result.mp4',
      cause: expect.objectContaining({ code: 'EACCES' }),
    })
    expect(state.spawnCalls).toHaveLength(0)
    expect(state.linkCalls).toHaveLength(0)
  })

  it('preserves an existing output when no-replace publication loses a race', async () => {
    state.linkError = systemError('EEXIST', 'winner already published')
    await expect(
      renderVideo('/input', '/output', edit, () => undefined),
    ).rejects.toThrow('output already exists: /output/result.mp4')
    expect(state.linkCalls).toHaveLength(1)
    expect(state.unlinkCalls).toHaveLength(1)
    expect(state.unlinkCalls[0]).toMatch(
      /^\/output\/\.result\.mp4\..+\.tmp\.mp4$/u,
    )
    expect(state.unlinkCalls).not.toContain('/output/result.mp4')
  })

  it('reports a distinct typed error when failed-export cleanup also fails', async () => {
    state.spawnMode = 'failure'
    state.unlinkError = systemError('EACCES', 'cannot remove partial')
    const failure = renderVideo('/input', '/output', edit, () => undefined)
    await expect(failure).rejects.toMatchObject({
      name: 'VideoRenderError',
      message:
        'video export failed and its temporary file could not be removed',
      cause: expect.objectContaining({
        name: 'VideoRenderError',
        message: expect.stringContaining('could not remove temporary video'),
      }),
    })
    expect(state.unlinkCalls).toHaveLength(1)
  })

  it('cleans a failed partial when ffmpeg exits unsuccessfully', async () => {
    state.spawnMode = 'failure'
    await expect(
      renderVideo('/input', '/output', edit, () => undefined),
    ).rejects.toThrow('ffmpeg failed with exit code 1: encoding failed')
    expect(state.unlinkCalls).toHaveLength(1)
    expect(state.linkCalls).toHaveLength(0)
  })
})

describe('preview cache failures', () => {
  it.each(['directory', 'empty'] as const)(
    'rejects a corrupt %s cache entry without starting ffmpeg',
    async (entry) => {
      state.cacheStats.push(entry)
      await expect(
        preparePreview('/input', 'source.mp4', '/cache'),
      ).rejects.toThrow('preview cache entry is invalid')
      expect(state.spawnCalls).toHaveLength(0)
      expect(state.unlinkCalls).toHaveLength(0)
    },
  )

  it('accepts a valid winner after losing a concurrent publication race', async () => {
    state.cacheStats.push('missing', 'file')
    state.linkError = systemError('EEXIST', 'winner already published')
    await expect(
      preparePreview('/input', 'source.mp4', '/cache'),
    ).resolves.toMatch(/^\/cache\/[a-f0-9]{64}\.mp4$/u)
    expect(state.unlinkCalls).toHaveLength(1)
  })

  it('rejects an invalid winner after losing a concurrent publication race', async () => {
    state.cacheStats.push('missing', 'empty')
    state.linkError = systemError('EEXIST', 'invalid winner')
    await expect(
      preparePreview('/input', 'source.mp4', '/cache'),
    ).rejects.toThrow('concurrent preview cache entry is invalid')
    expect(state.unlinkCalls.length).toBeGreaterThanOrEqual(1)
  })
})

describe('progress safety', () => {
  it('never emits NaN, negative progress, or 1 before successful process completion', async () => {
    state.progress =
      'out_time_us=not-a-number\nout_time_us=-100000\nout_time=bad\nout_time_us=999999999\n'
    const progress: number[] = []
    await renderVideo('/input', '/output', edit, (fraction) =>
      progress.push(fraction),
    )
    expect(progress).toEqual([0, 0.999, 1])
    expect(progress.every(Number.isFinite)).toBe(true)
    expect(
      progress.slice(0, -1).every((fraction) => fraction >= 0 && fraction < 1),
    ).toBe(true)
  })

  it('does not report completion when the process later fails', async () => {
    state.progress = 'out_time_us=500000\n'
    state.spawnMode = 'failure'
    const progress: number[] = []
    await expect(
      renderVideo('/input', '/output', edit, (fraction) =>
        progress.push(fraction),
      ),
    ).rejects.toBeInstanceOf(VideoRenderError)
    expect(progress).toEqual([0, 0.999])
  })
})

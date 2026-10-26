import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface Fault {
  readonly thrown: unknown
}

type CacheEntry = 'missing' | 'directory' | 'empty' | 'file' | Fault

interface SpawnCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: unknown
}

const SOURCE_KEY = createHash('sha256')
  .update('/input/source.mp4')
  .update('\0')
  .update('123')
  .update('\0')
  .update('100')
  .digest('hex')

const state = vi.hoisted(() => ({
  access: {
    thrown: Object.assign(new Error('missing'), { code: 'ENOENT' }),
  } as Fault | undefined,
  link: undefined as Fault | undefined,
  unlink: undefined as Fault | undefined,
  cacheStats: [] as CacheEntry[],
  probeDuration: 1,
  spawnThrows: undefined as Fault | undefined,
  stdout: [] as string[],
  stderr: [] as string[],
  exit: { code: 0, signal: null } as {
    code: number | null
    signal: string | null
  },
  delayMilliseconds: 0,
  spawnCalls: [] as SpawnCall[],
  linkCalls: [] as [string, string][],
  unlinkCalls: [] as string[],
}))

vi.mock('node:fs/promises', () => ({
  access: vi.fn(async () => {
    if (state.access !== undefined) {
      throw state.access.thrown
    }
  }),
  mkdir: vi.fn(async () => undefined),
  realpath: vi.fn(async (path: string) => path),
  link: vi.fn(async (temporaryPath: string, finalPath: string) => {
    state.linkCalls.push([temporaryPath, finalPath])
    if (state.link !== undefined) {
      throw state.link.thrown
    }
  }),
  unlink: vi.fn(async (path: string) => {
    state.unlinkCalls.push(path)
    if (state.unlink !== undefined) {
      throw state.unlink.thrown
    }
  }),
  stat: vi.fn(async (path: string) => {
    if (path === '/input/source.mp4') {
      return { isFile: () => true, size: 100, mtimeMs: 123 }
    }
    if (path.startsWith('/cache/') && path.endsWith('.mp4')) {
      const entry: CacheEntry = state.cacheStats.shift() ?? 'missing'
      if (typeof entry === 'object') {
        throw entry.thrown
      }
      if (entry === 'missing') {
        throw Object.assign(new Error('missing cache entry'), {
          code: 'ENOENT',
        })
      }
      return {
        isFile: () => entry !== 'directory',
        size: entry === 'empty' ? 0 : 42,
        mtimeMs: 456,
      }
    }
    return { isFile: () => true, size: 42, mtimeMs: 456 }
  }),
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn((command: string, args: readonly string[], options: unknown) => {
    state.spawnCalls.push({ command, args: [...args], options })
    if (state.spawnThrows !== undefined) {
      throw state.spawnThrows.thrown
    }
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const complete = (): void => {
      for (const chunk of state.stdout) {
        child.stdout.emit('data', Buffer.from(chunk))
      }
      for (const chunk of state.stderr) {
        child.stderr.emit('data', Buffer.from(chunk))
      }
      child.emit('close', state.exit.code, state.exit.signal)
    }
    if (state.delayMilliseconds === 0) {
      queueMicrotask(complete)
    } else {
      setTimeout(complete, state.delayMilliseconds)
    }
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
    duration: state.probeDuration,
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
  overwrite: false,
} as const

const longEdit = {
  ...edit,
  segments: [{ start: 0, end: 5000 }],
} as const

const TEMPORARY_OUTPUT =
  /^\/output\/\.result\.mp4\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp\.mp4$/u
const TEMPORARY_PREVIEW = new RegExp(
  `^/cache/\\.${SOURCE_KEY}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp\\.mp4$`,
  'u',
)

afterEach(() => {
  state.access = {
    thrown: Object.assign(new Error('missing'), { code: 'ENOENT' }),
  }
  state.link = undefined
  state.unlink = undefined
  state.cacheStats.length = 0
  state.probeDuration = 1
  state.spawnThrows = undefined
  state.stdout.length = 0
  state.stderr.length = 0
  state.exit = { code: 0, signal: null }
  state.delayMilliseconds = 0
  state.spawnCalls.length = 0
  state.linkCalls.length = 0
  state.unlinkCalls.length = 0
})

async function failureOf(promise: Promise<unknown>): Promise<VideoRenderError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof VideoRenderError) {
      return error
    }
    throw error
  }
  throw new Error('expected the operation to reject')
}

function lastArgument(call: SpawnCall | undefined): string {
  const value = call?.args.at(-1)
  if (value === undefined) {
    throw new Error('ffmpeg was not started')
  }
  return value
}

describe('ffmpeg process wiring', () => {
  it('starts ffmpeg without a shell, ignoring stdin, and publishes the temporary file by link', async () => {
    await renderVideo('/input', '/output', edit, () => undefined)
    expect(state.spawnCalls).toHaveLength(1)
    expect(state.spawnCalls[0]?.command).toBe('ffmpeg')
    expect(state.spawnCalls[0]?.options).toEqual({
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const temporary = lastArgument(state.spawnCalls[0])
    expect(temporary).toMatch(TEMPORARY_OUTPUT)
    expect(state.linkCalls).toEqual([[temporary, '/output/result.mp4']])
    expect(state.unlinkCalls).toEqual([temporary])
  })
})

describe('progress records', () => {
  it('converts clock timestamps using hours, minutes, and seconds', async () => {
    state.probeDuration = 10_000
    state.stdout.push('out_time=01:02:03.500\n')
    const progress: number[] = []
    await renderVideo('/input', '/output', longEdit, (fraction) =>
      progress.push(fraction),
    )
    expect(progress).toEqual([0, 3723.5 / 5000, 1])
  })

  it('reassembles records split across chunks and accepts CRLF line ends', async () => {
    state.stdout.push('out_time_us=25', '000\r\nout_time_us=5', '0000\r\n')
    const progress: number[] = []
    await renderVideo('/input', '/output', edit, (fraction) =>
      progress.push(fraction),
    )
    expect(progress).toEqual([0, 0.05, 0.1, 1])
  })

  it('ignores unrelated keys, incomplete clock values, and unavailable timestamps', async () => {
    state.stdout.push(
      'frame=5\nabcdefgh=00:00:00.250\nout_time=00:01\nout_time=00:00:N/A\nprogress=continue\nout_time_us=N/A\nout_time=N/A\n',
    )
    const progress: number[] = []
    await renderVideo('/input', '/output', edit, (fraction) =>
      progress.push(fraction),
    )
    expect(progress).toEqual([0, 1])
  })
})

describe('ffmpeg failure reports', () => {
  it.each([
    ['no output', [], 'ffmpeg failed with exit code 1'],
    ['blank output', ['  \n\t '], 'ffmpeg failed with exit code 1'],
    [
      'padded output split across chunks',
      ['\n  boom', ' bang \n'],
      'ffmpeg failed with exit code 1: boom bang',
    ],
  ])(
    'summarizes an exit code failure with %s',
    async (_name, chunks, message) => {
      state.exit = { code: 1, signal: null }
      state.stderr.push(...chunks)
      const failure = await failureOf(
        renderVideo('/input', '/output', edit, () => undefined),
      )
      expect(failure.message).toBe(message)
      expect(failure.name).toBe('VideoRenderError')
      expect(failure.cause).toBeUndefined()
    },
  )

  it('reports the numeric exit code and a terminating signal distinctly', async () => {
    state.exit = { code: 137, signal: null }
    const byCode = await failureOf(
      renderVideo('/input', '/output', edit, () => undefined),
    )
    expect(byCode.message).toBe('ffmpeg failed with exit code 137')

    state.exit = { code: null, signal: 'SIGKILL' }
    state.stderr.push(' killed \n')
    const bySignal = await failureOf(
      renderVideo('/input', '/output', edit, () => undefined),
    )
    expect(bySignal.message).toBe('ffmpeg failed with signal SIGKILL: killed')
  })

  it.each([
    ['an Error', new Error('spawn exploded')],
    ['a string', 'spawn exploded'],
  ])(
    'wraps %s thrown while starting ffmpeg for an export',
    async (_name, thrown) => {
      state.spawnThrows = { thrown }
      const failure = await failureOf(
        renderVideo('/input', '/output', edit, () => undefined),
      )
      expect(failure.message).toBe('video export failed')
      expect(failure.cause).toBe(thrown)
      expect(state.unlinkCalls).toEqual([lastArgument(state.spawnCalls[0])])
      expect(state.linkCalls).toHaveLength(0)
    },
  )
})

describe('temporary file removal', () => {
  const failures: [string, unknown][] = [
    ['a string', 'boom'],
    ['null', null],
    ['an object without a code', {}],
    [
      'an unrelated system error',
      Object.assign(new Error('x'), { code: 'EACCES' }),
    ],
    [
      'an error whose code is EEXIST',
      Object.assign(new Error('x'), { code: 'EEXIST' }),
    ],
  ]

  it.each(failures)(
    'reports %s as a removal failure after a failed export',
    async (_name, thrown) => {
      state.exit = { code: 1, signal: null }
      state.unlink = { thrown }
      const failure = await failureOf(
        renderVideo('/input', '/output', edit, () => undefined),
      )
      const temporary = lastArgument(state.spawnCalls[0])
      expect(failure.message).toBe(
        'video export failed and its temporary file could not be removed',
      )
      expect(failure.cause).toBeInstanceOf(VideoRenderError)
      const cleanup = failure.cause as VideoRenderError
      expect(cleanup.message).toBe(
        `could not remove temporary video: ${temporary}`,
      )
      expect(cleanup.cause).toBe(thrown)
    },
  )

  it('treats an already missing temporary file as removed and keeps the original failure', async () => {
    state.exit = { code: 1, signal: null }
    state.stderr.push('encoding failed')
    state.unlink = {
      thrown: Object.assign(new Error('gone'), { code: 'ENOENT' }),
    }
    const failure = await failureOf(
      renderVideo('/input', '/output', edit, () => undefined),
    )
    expect(failure.message).toBe(
      'ffmpeg failed with exit code 1: encoding failed',
    )
  })

  it('reports a failed removal after successful publication', async () => {
    state.unlink = { thrown: 'stuck' }
    const failure = await failureOf(
      renderVideo('/input', '/output', edit, () => undefined),
    )
    expect(failure.message).toBe(
      'video export failed and its temporary file could not be removed',
    )
    expect((failure.cause as VideoRenderError).cause).toBe('stuck')
  })
})

describe('output publication', () => {
  it.each([
    [
      'an EEXIST error',
      Object.assign(new Error('exists'), { code: 'EEXIST' }),
      'output already exists: /output/result.mp4',
    ],
    [
      'an EEXIST object',
      { code: 'EEXIST' },
      'output already exists: /output/result.mp4',
    ],
    [
      'an EACCES error',
      Object.assign(new Error('denied'), { code: 'EACCES' }),
      'could not publish output: /output/result.mp4',
    ],
    ['a string', 'boom', 'could not publish output: /output/result.mp4'],
    ['null', null, 'could not publish output: /output/result.mp4'],
    [
      'an object without a code',
      {},
      'could not publish output: /output/result.mp4',
    ],
  ])(
    'maps %s to a typed error and removes the temporary file',
    async (_name, thrown, message) => {
      state.link = { thrown }
      const failure = await failureOf(
        renderVideo('/input', '/output', edit, () => undefined),
      )
      expect(failure.message).toBe(message)
      expect(failure.cause).toBe(thrown)
      expect(state.unlinkCalls).toEqual([lastArgument(state.spawnCalls[0])])
    },
  )
})

describe('output inspection', () => {
  it('rejects an existing output without a cause and without starting ffmpeg', async () => {
    state.access = undefined
    const failure = await failureOf(
      renderVideo('/input', '/output', edit, () => undefined),
    )
    expect(failure.message).toBe('output already exists: result.mp4')
    expect(failure.cause).toBeUndefined()
    expect(state.spawnCalls).toHaveLength(0)
  })

  it.each([
    ['a string', 'nope'],
    ['null', null],
    ['an object without a code', {}],
    ['a permission error', Object.assign(new Error('x'), { code: 'EACCES' })],
  ])('reports %s as an uninspectable output path', async (_name, thrown) => {
    state.access = { thrown }
    const failure = await failureOf(
      renderVideo('/input', '/output', edit, () => undefined),
    )
    expect(failure.message).toBe('cannot inspect output path: result.mp4')
    expect(failure.cause).toBe(thrown)
    expect(state.spawnCalls).toHaveLength(0)
  })
})

describe('preview generation', () => {
  it('encodes into a temporary file with the exact compatibility arguments and publishes it under a content key', async () => {
    const path = await preparePreview('/input', 'source.mp4', '/cache')
    expect(path).toBe(`/cache/${SOURCE_KEY}.mp4`)
    expect(state.spawnCalls).toHaveLength(1)
    const call = state.spawnCalls[0]
    expect(call?.command).toBe('ffmpeg')
    expect(call?.options).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] })
    const temporary = lastArgument(call)
    expect(temporary).toMatch(TEMPORARY_PREVIEW)
    expect(call?.args).toEqual([
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      '/input/source.mp4',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      "scale=w='min(1280\\,iw)':h='min(1280\\,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      '-threads',
      '2',
      '-progress',
      'pipe:1',
      '-nostats',
      temporary,
    ])
    expect(state.linkCalls).toEqual([[temporary, path]])
    expect(state.unlinkCalls).toEqual([temporary])
  })

  it('ignores progress records while encoding a preview', async () => {
    state.stdout.push('out_time_us=100000\nout_time=00:00:01.000\n')
    await expect(
      preparePreview('/input', 'source.mp4', '/cache'),
    ).resolves.toBe(`/cache/${SOURCE_KEY}.mp4`)
  })

  it('reuses a valid cache entry without starting ffmpeg', async () => {
    state.cacheStats.push('file')
    await expect(
      preparePreview('/input', 'source.mp4', '/cache'),
    ).resolves.toBe(`/cache/${SOURCE_KEY}.mp4`)
    expect(state.spawnCalls).toHaveLength(0)
  })

  it.each([
    ['a permission error', Object.assign(new Error('x'), { code: 'EACCES' })],
    ['a string', 'boom'],
    ['null', null],
    ['an object without a code', {}],
  ])(
    'reports %s while inspecting the cache as a typed error',
    async (_name, thrown) => {
      state.cacheStats.push({ thrown })
      const failure = await failureOf(
        preparePreview('/input', 'source.mp4', '/cache'),
      )
      expect(failure.message).toBe('cannot inspect the preview cache')
      expect(failure.cause).toBe(thrown)
      expect(state.spawnCalls).toHaveLength(0)
      expect(state.unlinkCalls).toHaveLength(0)
    },
  )

  it.each([
    ['an Error', new Error('spawn exploded')],
    ['a string', 'spawn exploded'],
  ])(
    'wraps %s thrown while starting the preview process',
    async (_name, thrown) => {
      state.spawnThrows = { thrown }
      const failure = await failureOf(
        preparePreview('/input', 'source.mp4', '/cache'),
      )
      expect(failure.message).toBe('preview generation failed')
      expect(failure.cause).toBe(thrown)
      expect(state.unlinkCalls).toEqual([lastArgument(state.spawnCalls[0])])
    },
  )

  it('does not treat a failed publication as a lost race even when a valid entry appears', async () => {
    state.cacheStats.push('missing', 'file')
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
    state.link = { thrown: denied }
    const failure = await failureOf(
      preparePreview('/input', 'source.mp4', '/cache'),
    )
    expect(failure.message).toBe(
      `could not publish output: /cache/${SOURCE_KEY}.mp4`,
    )
    expect(failure.cause).toBe(denied)
    expect(state.unlinkCalls).toEqual([lastArgument(state.spawnCalls[0])])
  })

  it('removes the temporary file and keeps the winner after losing a publication race', async () => {
    state.cacheStats.push('missing', 'file')
    state.link = {
      thrown: Object.assign(new Error('exists'), { code: 'EEXIST' }),
    }
    await expect(
      preparePreview('/input', 'source.mp4', '/cache'),
    ).resolves.toBe(`/cache/${SOURCE_KEY}.mp4`)
    expect(state.unlinkCalls).toEqual([lastArgument(state.spawnCalls[0])])
  })

  it('shares one encoding between simultaneous requests for the same source and cache', async () => {
    state.delayMilliseconds = 10
    const [first, second] = await Promise.all([
      preparePreview('/input', 'source.mp4', '/cache'),
      preparePreview('/input', 'source.mp4', '/cache'),
    ])
    expect(first).toBe(`/cache/${SOURCE_KEY}.mp4`)
    expect(second).toBe(first)
    expect(state.spawnCalls).toHaveLength(1)
    expect(state.linkCalls).toHaveLength(1)
  })

  it('shares a failed encoding with simultaneous requests and then allows a retry', async () => {
    state.delayMilliseconds = 10
    state.exit = { code: 1, signal: null }
    const outcomes = await Promise.allSettled([
      preparePreview('/input', 'source.mp4', '/cache'),
      preparePreview('/input', 'source.mp4', '/cache'),
    ])
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'rejected',
      'rejected',
    ])
    expect(state.spawnCalls).toHaveLength(1)

    state.exit = { code: 0, signal: null }
    await expect(
      preparePreview('/input', 'source.mp4', '/cache'),
    ).resolves.toBe(`/cache/${SOURCE_KEY}.mp4`)
    expect(state.spawnCalls).toHaveLength(2)
  })
})

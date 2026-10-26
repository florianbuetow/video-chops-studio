import { createHash } from 'node:crypto'
import type { RmOptions, Stats } from 'node:fs'
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FileSystem = typeof import('node:fs/promises')

const state = vi.hoisted(() => ({
  real: undefined as unknown as typeof import('node:fs/promises'),
  execCalls: [] as {
    command: string
    args: readonly string[]
    options: unknown
  }[],
  exec: undefined as
    | undefined
    | ((call: {
        command: string
        args: readonly string[]
        options: unknown
      }) => Promise<{ stdout: string; stderr: string }>),
  stat: undefined as undefined | ((path: string) => Promise<Stats>),
  mkdtemp: undefined as undefined | ((prefix: string) => Promise<string>),
  link: undefined as
    undefined | ((existing: string, target: string) => Promise<void>),
  rm: undefined as
    undefined | ((path: string, options?: RmOptions) => Promise<void>),
  writeFile: undefined as
    | undefined
    | ((file: string, data: Uint8Array, options?: unknown) => Promise<void>),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const mockedExecFile = vi.fn()
  Object.defineProperty(
    mockedExecFile,
    Symbol.for('nodejs.util.promisify.custom'),
    {
      value: async (
        command: string,
        args: readonly string[],
        options: unknown,
      ) => {
        const call = { command, args: [...args], options }
        state.execCalls.push(call)
        if (state.exec === undefined) {
          throw new Error(`unexpected ${command} invocation`)
        }
        return await state.exec(call)
      },
    },
  )
  return { ...original, execFile: mockedExecFile }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<FileSystem>()
  state.real = original
  return {
    ...original,
    stat: vi.fn(async (path: string) =>
      state.stat === undefined
        ? await original.stat(path)
        : await state.stat(path),
    ),
    mkdtemp: vi.fn(async (prefix: string) =>
      state.mkdtemp === undefined
        ? await original.mkdtemp(prefix)
        : await state.mkdtemp(prefix),
    ),
    link: vi.fn(async (existing: string, target: string) =>
      state.link === undefined
        ? await original.link(existing, target)
        : await state.link(existing, target),
    ),
    rm: vi.fn(async (path: string, options?: RmOptions) =>
      state.rm === undefined
        ? await original.rm(path, options)
        : await state.rm(path, options),
    ),
    writeFile: vi.fn(
      async (file: string, data: Uint8Array, options?: unknown) =>
        state.writeFile === undefined
          ? await original.writeFile(
              file,
              data,
              options as Parameters<FileSystem['writeFile']>[2],
            )
          : await state.writeFile(file, data, options),
    ),
  }
})

import {
  BackgroundImageError,
  importBackground,
  resolveBackground,
} from '../../src/application/background-images.js'

type Probe =
  | string
  | Error
  | {
      readonly codec_name?: unknown
      readonly width?: unknown
      readonly height?: unknown
    }

interface Tools {
  source?: Probe
  normalized?: Probe
  existing?: Probe
  ffmpeg?: Error
}

const PROCESS_OPTIONS = {
  encoding: 'utf8',
  timeout: 30_000,
  maxBuffer: 2 * 1024 * 1024,
  windowsHide: true,
}
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await state.real.mkdtemp(
    join(tmpdir(), 'background-pipeline-'),
  )
  temporaryDirectories.push(directory)
  return await state.real.realpath(directory)
}

function lastArgument(args: readonly string[]): string {
  const value = args.at(-1)
  if (value === undefined) throw new Error('command without arguments')
  return value
}

function probeOutput(probe: Probe): string {
  return typeof probe === 'string'
    ? probe
    : JSON.stringify({ streams: [probe] })
}

function png(width: number, height: number): Probe {
  return { codec_name: 'png', width, height }
}

function installTools(tools: Tools): void {
  state.exec = async ({ command, args }) => {
    const file = lastArgument(args)
    if (command === 'ffprobe') {
      const name = basename(file)
      const role = name.startsWith('source-')
        ? 'source'
        : name.startsWith('normalized-')
          ? 'normalized'
          : 'existing'
      const probe = tools[role]
      if (probe === undefined) throw new Error(`no probe result for ${name}`)
      if (probe instanceof Error) throw probe
      return { stdout: probeOutput(probe), stderr: '' }
    }
    if (command === 'ffmpeg') {
      if (tools.ffmpeg !== undefined) throw tools.ffmpeg
      await state.real.writeFile(file, 'normalized image bytes')
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected command ${command}`)
  }
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
}

function hashOf(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected the operation to fail')
    },
    (error: unknown) => error,
  )
}

function commands(): string[] {
  return state.execCalls.map((call) => call.command)
}

beforeEach(() => {
  state.execCalls.length = 0
  state.exec = undefined
  state.stat = undefined
  state.mkdtemp = undefined
  state.link = undefined
  state.rm = undefined
  state.writeFile = undefined
  vi.clearAllMocks()
})

afterEach(async () => {
  state.stat = undefined
  state.mkdtemp = undefined
  state.link = undefined
  state.rm = undefined
  state.writeFile = undefined
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        state.real.rm(directory, { recursive: true, force: true }),
      ),
  )
})

describe('background image import pipeline', () => {
  it('probes, normalizes, and probes again with exact tool invocations', async () => {
    const directory = await temporaryDirectory()
    const body = Buffer.from('original jpeg bytes')
    installTools({
      source: { codec_name: 'mjpeg', width: 640, height: 480 },
      normalized: png(320, 240),
    })

    const result = await importBackground(directory, 'Holiday.JPEG', body)

    const savedName = `background-${hashOf(body)}.png`
    expect(result).toEqual({ name: savedName, width: 320, height: 240 })
    expect(await state.real.readdir(directory)).toEqual([savedName])
    expect(await state.real.readFile(join(directory, savedName), 'utf8')).toBe(
      'normalized image bytes',
    )

    expect(vi.mocked(mkdtemp)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(mkdtemp)).toHaveBeenCalledWith(
      join(directory, '.background-import-'),
    )
    const [writeCall] = vi.mocked(writeFile).mock.calls
    expect(writeCall).toBeDefined()
    const [sourcePath, writtenBody, writeOptions] = writeCall ?? []
    expect(String(sourcePath)).toMatch(
      new RegExp(
        `^${escapeRegExp(join(directory, '.background-import-'))}[A-Za-z0-9]{6}/source-[0-9a-f-]{36}\\.jpeg$`,
        'u',
      ),
    )
    expect(writtenBody).toBe(body)
    expect(writeOptions).toEqual({ flag: 'wx' })

    expect(state.execCalls).toHaveLength(3)
    const [firstProbe, ffmpeg, secondProbe] = state.execCalls
    const temporaryPath = String(sourcePath).replace(/\/source-[^/]+$/u, '')
    const normalizedPath = lastArgument(ffmpeg?.args ?? [])
    expect(normalizedPath).toMatch(
      new RegExp(
        `^${escapeRegExp(temporaryPath)}/normalized-[0-9a-f-]{36}\\.png$`,
        'u',
      ),
    )
    expect(firstProbe).toEqual({
      command: 'ffprobe',
      args: [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height',
        '-of',
        'json',
        String(sourcePath),
      ],
      options: PROCESS_OPTIONS,
    })
    expect(ffmpeg).toEqual({
      command: 'ffmpeg',
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        String(sourcePath),
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-vf',
        "scale=w='min(4096,iw)':h='min(4096,ih)':force_original_aspect_ratio=decrease",
        '-map_metadata',
        '-1',
        '-c:v',
        'png',
        '-pix_fmt',
        'rgba',
        '-threads',
        '2',
        normalizedPath,
      ],
      options: PROCESS_OPTIONS,
    })
    expect(secondProbe).toEqual({
      command: 'ffprobe',
      args: [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height',
        '-of',
        'json',
        normalizedPath,
      ],
      options: PROCESS_OPTIONS,
    })

    expect(vi.mocked(link)).toHaveBeenCalledWith(
      normalizedPath,
      join(directory, savedName),
    )
    expect(vi.mocked(rm)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(rm)).toHaveBeenCalledWith(temporaryPath, {
      recursive: true,
      force: true,
    })
  })

  it.each([
    ['photo.png', '.png'],
    ['photo.JPG', '.jpg'],
    ['photo.webp', '.webp'],
  ])(
    'keeps the lower-cased extension of %s on the source file',
    async (name, extension) => {
      const directory = await temporaryDirectory()
      installTools({ source: png(2, 2), normalized: png(2, 2) })
      await importBackground(directory, name, Buffer.from(name))
      const [writeCall] = vi.mocked(writeFile).mock.calls
      expect(String(writeCall?.[0])).toMatch(
        new RegExp(`/source-[0-9a-f-]{36}\\${extension}$`, 'u'),
      )
    },
  )

  it('accepts a body of exactly 20 MiB and rejects one byte more before any work', async () => {
    const directory = await temporaryDirectory()
    installTools({ source: png(2, 2), normalized: png(2, 2) })
    const exact = Buffer.alloc(20 * 1024 * 1024, 7)
    await expect(
      importBackground(directory, 'exact.png', exact),
    ).resolves.toEqual({
      name: `background-${hashOf(exact)}.png`,
      width: 2,
      height: 2,
    })

    state.execCalls.length = 0
    vi.clearAllMocks()
    const failure = await failureOf(
      importBackground(
        directory,
        'over.png',
        Buffer.alloc(20 * 1024 * 1024 + 1),
      ),
    )
    expect(failure).toBeInstanceOf(BackgroundImageError)
    expect(failure).toMatchObject({
      message: 'background image exceeds 20 MiB',
    })
    expect(state.execCalls).toEqual([])
    expect(vi.mocked(mkdtemp)).not.toHaveBeenCalled()
  })

  it('rejects an empty body with the exact message and no side effects', async () => {
    const directory = await temporaryDirectory()
    const failure = await failureOf(
      importBackground(directory, 'empty.png', new Uint8Array()),
    )
    expect(failure).toBeInstanceOf(BackgroundImageError)
    expect(failure).toMatchObject({ message: 'background image is empty' })
    expect(state.execCalls).toEqual([])
    expect(vi.mocked(mkdtemp)).not.toHaveBeenCalled()
  })

  it.each([
    ['8000x5000 (exactly 40 megapixels)', 8000, 5000, true],
    ['5000x8000 (exactly 40 megapixels)', 5000, 8000, true],
    ['40000000x1', 40_000_000, 1, true],
    ['1x40000000', 1, 40_000_000, true],
    ['8001x5000', 8001, 5000, false],
    ['5000x8001', 5000, 8001, false],
    ['40000001x1', 40_000_001, 1, false],
    ['1x40000001', 1, 40_000_001, false],
  ])(
    'applies the megapixel limit to %s',
    async (_label, width, height, accepted) => {
      const directory = await temporaryDirectory()
      installTools({ source: png(width, height), normalized: png(10, 5) })
      const attempt = importBackground(directory, 'big.png', Buffer.from('big'))
      if (accepted) {
        await expect(attempt).resolves.toMatchObject({ width: 10, height: 5 })
        expect(commands()).toEqual(['ffprobe', 'ffmpeg', 'ffprobe'])
      } else {
        const failure = await failureOf(attempt)
        expect(failure).toBeInstanceOf(BackgroundImageError)
        expect(failure).toMatchObject({
          message: 'background image exceeds 40 megapixels: big.png',
        })
        expect(commands()).toEqual(['ffprobe'])
        expect(await state.real.readdir(directory)).toEqual([])
      }
    },
  )
})

describe('background image metadata validation', () => {
  it.each([
    ['no streams key', '{}'],
    ['empty streams', '{"streams":[]}'],
    ['streams is not an array', '{"streams":"png"}'],
    ['first stream is null', '{"streams":[null]}'],
    ['missing width', '{"streams":[{"codec_name":"png","height":4}]}'],
    ['missing height', '{"streams":[{"codec_name":"png","width":4}]}'],
    ['missing dimensions', '{"streams":[{"codec_name":"png"}]}'],
    ['missing codec', '{"streams":[{"width":4,"height":4}]}'],
    ['numeric codec', '{"streams":[{"codec_name":5,"width":4,"height":4}]}'],
    [
      'unsupported codec',
      '{"streams":[{"codec_name":"gif","width":4,"height":4}]}',
    ],
    ['video codec', '{"streams":[{"codec_name":"h264","width":4,"height":4}]}'],
    [
      'fractional width',
      '{"streams":[{"codec_name":"png","width":1.5,"height":4}]}',
    ],
    [
      'fractional height',
      '{"streams":[{"codec_name":"png","width":4,"height":1.5}]}',
    ],
    ['zero width', '{"streams":[{"codec_name":"png","width":0,"height":4}]}'],
    ['zero height', '{"streams":[{"codec_name":"png","width":4,"height":0}]}'],
    [
      'negative width',
      '{"streams":[{"codec_name":"png","width":-4,"height":4}]}',
    ],
    [
      'string width',
      '{"streams":[{"codec_name":"png","width":"4","height":4}]}',
    ],
    [
      'null height',
      '{"streams":[{"codec_name":"png","width":4,"height":null}]}',
    ],
    [
      'unsafe integer width',
      '{"streams":[{"codec_name":"png","width":9007199254740992,"height":1}]}',
    ],
  ])('rejects source metadata with %s', async (_label, stdout) => {
    const directory = await temporaryDirectory()
    installTools({ source: stdout })
    const failure = await failureOf(
      importBackground(directory, 'photo.png', Buffer.from('photo')),
    )
    expect(failure).toBeInstanceOf(BackgroundImageError)
    expect(failure).toMatchObject({
      message: 'file is not a supported background image: photo.png',
    })
    expect(commands()).toEqual(['ffprobe'])
    expect(await state.real.readdir(directory)).toEqual([])
  })

  it.each(['png', 'mjpeg', 'webp'])(
    'accepts the %s codec for sources',
    async (codec) => {
      const directory = await temporaryDirectory()
      installTools({
        source: { codec_name: codec, width: 3, height: 2 },
        normalized: png(3, 2),
      })
      await expect(
        importBackground(directory, 'photo.png', Buffer.from(codec)),
      ).resolves.toMatchObject({ width: 3, height: 2 })
    },
  )

  it('reports unparsable probe output with the parse error as cause', async () => {
    const directory = await temporaryDirectory()
    installTools({ source: 'this is not json' })
    const failure = await failureOf(
      importBackground(directory, 'photo.png', Buffer.from('photo')),
    )
    expect(failure).toBeInstanceOf(BackgroundImageError)
    expect(failure).toMatchObject({
      message: 'background image metadata is invalid for "photo.png"',
      cause: expect.any(SyntaxError),
    })
    expect(await state.real.readdir(directory)).toEqual([])
  })

  it('reports a failing ffprobe with the process error as cause', async () => {
    const directory = await temporaryDirectory()
    const cause = new Error('ffprobe exploded')
    installTools({ source: cause })
    const failure = await failureOf(
      importBackground(directory, 'photo.png', Buffer.from('photo')),
    )
    expect(failure).toBeInstanceOf(BackgroundImageError)
    expect(failure).toMatchObject({
      message: 'cannot read background image "photo.png"',
      cause,
    })
    expect(await state.real.readdir(directory)).toEqual([])
  })

  it('reports a failing ffmpeg normalization with the process error as cause', async () => {
    const directory = await temporaryDirectory()
    const cause = new Error('ffmpeg exploded')
    installTools({ source: png(2, 2), ffmpeg: cause })
    const failure = await failureOf(
      importBackground(directory, 'photo.png', Buffer.from('photo')),
    )
    expect(failure).toBeInstanceOf(BackgroundImageError)
    expect(failure).toMatchObject({
      message: 'could not normalize background image "photo.png"',
      cause,
    })
    expect(commands()).toEqual(['ffprobe', 'ffmpeg'])
    expect(await state.real.readdir(directory)).toEqual([])
  })

  it.each([
    ['a JPEG', { codec_name: 'mjpeg', width: 2, height: 2 }],
    ['unparsable metadata', '{"streams":[{}]}'],
  ] as const)(
    'rejects a normalized output that is %s and names the saved file',
    async (_label, normalized) => {
      const directory = await temporaryDirectory()
      const body = Buffer.from('photo')
      installTools({ source: png(2, 2), normalized })
      const failure = await failureOf(
        importBackground(directory, 'photo.png', body),
      )
      expect(failure).toBeInstanceOf(BackgroundImageError)
      expect(failure).toMatchObject({
        message: `file is not a supported background image: background-${hashOf(body)}.png`,
      })
      expect(vi.mocked(link)).not.toHaveBeenCalled()
      expect(await state.real.readdir(directory)).toEqual([])
    },
  )

  it('reports a normalized output that cannot be probed under the saved name', async () => {
    const directory = await temporaryDirectory()
    const body = Buffer.from('photo')
    const cause = new Error('probe crashed')
    installTools({ source: png(2, 2), normalized: cause })
    const failure = await failureOf(
      importBackground(directory, 'photo.png', body),
    )
    expect(failure).toMatchObject({
      message: `cannot read background image "background-${hashOf(body)}.png"`,
      cause,
    })
  })
})

describe('background image cache reuse', () => {
  async function seedCache(directory: string, body: Buffer): Promise<string> {
    const savedName = `background-${hashOf(body)}.png`
    await state.real.writeFile(join(directory, savedName), 'cached bytes')
    return savedName
  }

  it('returns the cached image after a single probe without importing again', async () => {
    const directory = await temporaryDirectory()
    const body = Buffer.from('cached photo')
    const savedName = await seedCache(directory, body)
    installTools({ existing: png(7, 6) })

    await expect(
      importBackground(directory, 'photo.jpg', body),
    ).resolves.toEqual({
      name: savedName,
      width: 7,
      height: 6,
    })

    expect(state.execCalls).toHaveLength(1)
    expect(state.execCalls[0]).toEqual({
      command: 'ffprobe',
      args: [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height',
        '-of',
        'json',
        join(directory, savedName),
      ],
      options: PROCESS_OPTIONS,
    })
    expect(vi.mocked(mkdtemp)).not.toHaveBeenCalled()
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled()
    expect(vi.mocked(link)).not.toHaveBeenCalled()
    expect(await state.real.readdir(directory)).toEqual([savedName])
  })

  it.each([
    ['4096x4096', 4096, 4096, true],
    ['4096x1', 4096, 1, true],
    ['1x4096', 1, 4096, true],
    ['4097x1', 4097, 1, false],
    ['1x4097', 1, 4097, false],
    ['4097x4097', 4097, 4097, false],
  ])(
    'enforces the 4096px edge limit on a cached %s image',
    async (_label, width, height, accepted) => {
      const directory = await temporaryDirectory()
      const body = Buffer.from('cached photo')
      const savedName = await seedCache(directory, body)
      installTools({ existing: png(width, height) })
      const attempt = importBackground(directory, 'photo.jpg', body)
      if (accepted) {
        await expect(attempt).resolves.toEqual({
          name: savedName,
          width,
          height,
        })
      } else {
        const failure = await failureOf(attempt)
        expect(failure).toBeInstanceOf(BackgroundImageError)
        expect(failure).toMatchObject({
          message: `cached background image exceeds 4096px: ${savedName}`,
        })
      }
      expect(vi.mocked(mkdtemp)).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['a JPEG', { codec_name: 'mjpeg', width: 2, height: 2 }],
    ['a WebP', { codec_name: 'webp', width: 2, height: 2 }],
  ] as const)(
    'rejects a cached file that is %s instead of a PNG',
    async (_label, existing) => {
      const directory = await temporaryDirectory()
      const body = Buffer.from('cached photo')
      const savedName = await seedCache(directory, body)
      installTools({ existing })
      const failure = await failureOf(
        importBackground(directory, 'photo.jpg', body),
      )
      expect(failure).toBeInstanceOf(BackgroundImageError)
      expect(failure).toMatchObject({
        message: `file is not a supported background image: ${savedName}`,
      })
      expect(vi.mocked(mkdtemp)).not.toHaveBeenCalled()
    },
  )

  it('rethrows probe failures of the cached file instead of re-importing', async () => {
    const directory = await temporaryDirectory()
    const body = Buffer.from('cached photo')
    const savedName = await seedCache(directory, body)
    const cause = new Error('corrupt cache')
    installTools({ existing: cause })
    const failure = await failureOf(
      importBackground(directory, 'photo.jpg', body),
    )
    expect(failure).toMatchObject({
      message: `cannot read background image "${savedName}"`,
      cause,
    })
    expect(vi.mocked(mkdtemp)).not.toHaveBeenCalled()
  })

  it('rethrows unsafe cache entries such as symlinks that leave the directory', async () => {
    const directory = await temporaryDirectory()
    const outside = await temporaryDirectory()
    const body = Buffer.from('cached photo')
    const savedName = `background-${hashOf(body)}.png`
    await state.real.writeFile(join(outside, 'target.png'), 'outside')
    await state.real.symlink(
      join(outside, 'target.png'),
      join(directory, savedName),
    )
    installTools({ existing: png(2, 2) })
    const failure = await failureOf(
      importBackground(directory, 'photo.jpg', body),
    )
    expect(failure).toMatchObject({
      message: `background image resolves outside the input directory: ${savedName}`,
    })
    expect(vi.mocked(mkdtemp)).not.toHaveBeenCalled()
  })
})

describe('background image publishing races and failures', () => {
  it('uses the image that won a publishing race and reports its dimensions', async () => {
    const directory = await temporaryDirectory()
    const body = Buffer.from('raced photo')
    const savedName = `background-${hashOf(body)}.png`
    installTools({
      source: png(9, 9),
      normalized: png(5, 4),
      existing: png(8, 7),
    })
    state.link = async (_existing, target) => {
      await state.real.writeFile(target, 'winner bytes')
      throw Object.assign(new Error('target exists'), { code: 'EEXIST' })
    }

    await expect(
      importBackground(directory, 'photo.png', body),
    ).resolves.toEqual({
      name: savedName,
      width: 8,
      height: 7,
    })

    expect(commands()).toEqual(['ffprobe', 'ffmpeg', 'ffprobe', 'ffprobe'])
    const winnerProbe = state.execCalls[3]
    expect(lastArgument(winnerProbe?.args ?? [])).toBe(
      join(directory, savedName),
    )
    expect(await state.real.readdir(directory)).toEqual([savedName])
  })

  it('rejects a race winner that is not a valid cached PNG', async () => {
    const directory = await temporaryDirectory()
    const body = Buffer.from('raced photo')
    installTools({
      source: png(9, 9),
      normalized: png(5, 4),
      existing: { codec_name: 'mjpeg', width: 8, height: 7 },
    })
    state.link = async (_existing, target) => {
      await state.real.writeFile(target, 'winner bytes')
      throw Object.assign(new Error('target exists'), { code: 'EEXIST' })
    }
    const failure = await failureOf(
      importBackground(directory, 'photo.png', body),
    )
    expect(failure).toMatchObject({
      message: `file is not a supported background image: background-${hashOf(body)}.png`,
    })
  })

  it('reports a vanished race winner with the link error as cause', async () => {
    const directory = await temporaryDirectory()
    const body = Buffer.from('raced photo')
    const cause = Object.assign(new Error('target exists'), { code: 'EEXIST' })
    installTools({ source: png(9, 9), normalized: png(5, 4) })
    state.link = async () => {
      throw cause
    }
    const failure = await failureOf(
      importBackground(directory, 'photo.png', body),
    )
    expect(failure).toBeInstanceOf(BackgroundImageError)
    expect(failure).toMatchObject({
      message: 'background image cache disappeared while importing "photo.png"',
      cause,
    })
    expect(await state.real.readdir(directory)).toEqual([])
  })

  it.each([
    [
      'a permission error',
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    ],
    [
      'a missing-file error',
      Object.assign(new Error('gone'), { code: 'ENOENT' }),
    ],
    ['an error without a code', new Error('no code')],
    ['an object without a code', { message: 'no code' }],
    ['a string that looks like the code', 'EEXIST'],
    ['null', null],
    ['a number', 17],
  ])('reports %s while linking as a save failure', async (_label, cause) => {
    const directory = await temporaryDirectory()
    installTools({ source: png(9, 9), normalized: png(5, 4) })
    state.link = async () => {
      throw cause
    }
    const failure = await failureOf(
      importBackground(directory, 'photo.png', Buffer.from('photo')),
    )
    expect(failure).toBeInstanceOf(BackgroundImageError)
    expect(failure).toMatchObject({
      message: 'could not save background image "photo.png"',
    })
    expect((failure as BackgroundImageError).cause).toBe(cause)
    expect(commands()).toEqual(['ffprobe', 'ffmpeg', 'ffprobe'])
    expect(await state.real.readdir(directory)).toEqual([])
  })

  it('reports temporary directory creation failures with the cause', async () => {
    const directory = await temporaryDirectory()
    const cause = new Error('no space left')
    installTools({ source: png(2, 2), normalized: png(2, 2) })
    state.mkdtemp = async () => {
      throw cause
    }
    const failure = await failureOf(
      importBackground(directory, 'photo.png', Buffer.from('photo')),
    )
    expect(failure).toBeInstanceOf(BackgroundImageError)
    expect(failure).toMatchObject({
      message:
        'could not create temporary files for background image "photo.png"',
      cause,
    })
    expect(state.execCalls).toEqual([])
  })

  it.each([
    ['an Error', new Error('disk full')],
    ['a string', 'disk full'],
  ])(
    'wraps %s thrown while writing the source in a typed error',
    async (_label, cause) => {
      const directory = await temporaryDirectory()
      installTools({ source: png(2, 2), normalized: png(2, 2) })
      state.writeFile = async () => {
        throw cause
      }
      const failure = await failureOf(
        importBackground(directory, 'photo.png', Buffer.from('photo')),
      )
      expect(failure).toBeInstanceOf(BackgroundImageError)
      expect(failure).toMatchObject({
        name: 'BackgroundImageError',
        message: 'could not import background image "photo.png"',
      })
      expect((failure as BackgroundImageError).cause).toBe(cause)
      expect(state.execCalls).toEqual([])
      expect(await state.real.readdir(directory)).toEqual([])
    },
  )

  it('passes typed errors from inside the import through unchanged', async () => {
    const directory = await temporaryDirectory()
    const typed = new BackgroundImageError('custom failure')
    installTools({ source: png(2, 2), normalized: png(2, 2) })
    state.writeFile = async () => {
      throw typed
    }
    const failure = await failureOf(
      importBackground(directory, 'photo.png', Buffer.from('photo')),
    )
    expect(failure).toBe(typed)
  })

  it('reports cleanup failures after a successful import with the cause', async () => {
    const directory = await temporaryDirectory()
    const cause = new Error('busy')
    installTools({ source: png(2, 2), normalized: png(2, 2) })
    state.rm = async () => {
      throw cause
    }
    const failure = await failureOf(
      importBackground(directory, 'photo.png', Buffer.from('photo')),
    )
    expect(failure).toBeInstanceOf(BackgroundImageError)
    expect(failure).toMatchObject({
      message:
        'could not clean temporary files for background image "photo.png"',
      cause,
    })
  })

  it('lets a cleanup failure replace the import failure it follows', async () => {
    const directory = await temporaryDirectory()
    const cause = new Error('busy')
    installTools({ source: 'not json' })
    state.rm = async () => {
      throw cause
    }
    const failure = await failureOf(
      importBackground(directory, 'photo.png', Buffer.from('photo')),
    )
    expect(failure).toMatchObject({
      message:
        'could not clean temporary files for background image "photo.png"',
      cause,
    })
  })
})

describe('background image file inspection failures', () => {
  it('wraps stat failures after a successful lookup with the cause', async () => {
    const directory = await temporaryDirectory()
    await state.real.writeFile(join(directory, 'inside.png'), 'png')
    const cause = new Error('input/output error')
    state.stat = async (path) => {
      if (basename(path) === 'inside.png') throw cause
      return await state.real.stat(path)
    }
    const failure = await failureOf(resolveBackground(directory, 'inside.png'))
    expect(failure).toBeInstanceOf(BackgroundImageError)
    expect(failure).toMatchObject({
      name: 'BackgroundImageError',
      message: 'cannot inspect background image: inside.png',
      cause,
    })
  })

  it('keeps typed errors raised by the regular-file check untouched', async () => {
    const directory = await temporaryDirectory()
    await state.real.mkdir(join(directory, 'folder.png'))
    const failure = (await failureOf(
      resolveBackground(directory, 'folder.png'),
    )) as BackgroundImageError
    expect(failure.message).toBe(
      'background image is not a regular file: folder.png',
    )
    expect(failure.cause).toBeUndefined()
  })

  it('wraps stat failures of the input directory as inaccessible', async () => {
    const directory = await temporaryDirectory()
    const cause = new Error('stat denied')
    state.stat = async () => {
      throw cause
    }
    const failure = await failureOf(resolveBackground(directory, 'inside.png'))
    expect(failure).toMatchObject({
      message: `cannot access input directory: ${directory}`,
      cause,
    })
  })
})

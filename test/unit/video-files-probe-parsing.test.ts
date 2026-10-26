import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execState = vi.hoisted(() => ({
  stdout: '{}',
  calls: [] as {
    command: string
    args: readonly string[]
    options: unknown
  }[],
}))

vi.mock('node:child_process', () => {
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
        execState.calls.push({ command, args, options })
        return {
          stdout: command === 'ffprobe' ? execState.stdout : 'version',
          stderr: '',
        }
      },
    },
  )
  return { execFile: mockedExecFile }
})

import {
  checkVideoTools,
  probeVideo,
} from '../../src/application/video-files.js'

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'video-files-probe-'))
  await writeFile(join(directory, 'source.mp4'), 'fixture')
})

afterEach(async () => {
  execState.stdout = '{}'
  execState.calls.length = 0
  await rm(directory, { recursive: true, force: true })
})

function probeJson(value: unknown): void {
  execState.stdout = JSON.stringify(value)
}

function videoStream(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    codec_type: 'video',
    width: 320,
    height: 240,
    duration: '1',
    avg_frame_rate: '25/1',
    ...overrides,
  }
}

const incomplete = {
  name: 'VideoFileError',
  message: 'video metadata is incomplete: source.mp4',
}

describe('ffprobe invocation', () => {
  it('runs ffprobe on the resolved path with bounded output and time', async () => {
    probeJson({ streams: [videoStream()] })
    await probeVideo(directory, 'source.mp4')
    expect(execState.calls).toEqual([
      {
        command: 'ffprobe',
        args: [
          '-v',
          'error',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          join(await realpath(directory), 'source.mp4'),
        ],
        options: {
          encoding: 'utf8',
          timeout: 15_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      },
    ])
  })

  it('checks both tools with a five second timeout and a bounded buffer', async () => {
    await checkVideoTools()
    expect(execState.calls).toEqual([
      {
        command: 'ffmpeg',
        args: ['-version'],
        options: { encoding: 'utf8', timeout: 5_000, maxBuffer: 256 * 1024 },
      },
      {
        command: 'ffprobe',
        args: ['-version'],
        options: { encoding: 'utf8', timeout: 5_000, maxBuffer: 256 * 1024 },
      },
    ])
  })
})

describe('positive number parsing', () => {
  it.each(['width', 'height'])(
    'rejects a %s that is not a finite positive number or numeric string',
    async (field) => {
      for (const value of [0, -5, 'abc', 'Infinity', true, [320], null, {}]) {
        probeJson({ streams: [videoStream({ [field]: value })] })
        await expect(probeVideo(directory, 'source.mp4')).rejects.toMatchObject(
          incomplete,
        )
      }
    },
  )

  it('rejects a stream duration that is not positive when no format duration exists', async () => {
    for (const value of [0, -1, 'abc', 'Infinity', true, [2], null, {}]) {
      probeJson({ streams: [videoStream({ duration: value })] })
      await expect(probeVideo(directory, 'source.mp4')).rejects.toMatchObject(
        incomplete,
      )
    }
  })

  it('falls back to a positive format duration when the stream duration is unusable', async () => {
    for (const value of [0, -1, 'abc', 'N/A', 'Infinity', true, null]) {
      probeJson({
        streams: [videoStream({ duration: value })],
        format: { duration: '2.5' },
      })
      await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
        duration: 2.5,
      })
    }
  })

  it('rejects an unusable format duration when the stream has none', async () => {
    for (const duration of [0, -1, 'abc', 'Infinity', true, {}]) {
      probeJson({
        streams: [videoStream({ duration: undefined })],
        format: { duration },
      })
      await expect(probeVideo(directory, 'source.mp4')).rejects.toMatchObject(
        incomplete,
      )
    }
  })

  it('accepts numeric and numeric-string dimensions and durations', async () => {
    probeJson({
      streams: [videoStream({ width: '641', height: 481, duration: 1.5 })],
    })
    await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
      width: 641,
      height: 481,
      duration: 1.5,
    })
  })

  it.each([undefined, null, 'text', 5, []])(
    'ignores a non-object format %j when the stream carries a duration',
    async (format) => {
      probeJson({ streams: [videoStream()], format })
      await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
        duration: 1,
      })
    },
  )

  it.each([undefined, null, 'text', 5])(
    'reports incomplete metadata for a non-object format %j without a stream duration',
    async (format) => {
      probeJson({ streams: [videoStream({ duration: undefined })], format })
      await expect(probeVideo(directory, 'source.mp4')).rejects.toMatchObject(
        incomplete,
      )
    },
  )
})

describe('frame rate parsing', () => {
  it.each([
    ['a zero fraction', '0/1'],
    ['a negative fraction', '-5/1'],
    ['a zero denominator', '1/0'],
    ['an undefined ratio', '0/0'],
    ['a non-numeric fraction', 'abc/1'],
    ['a zero number', '0'],
    ['a negative number', '-25'],
    ['a non-numeric text', 'N/A'],
  ])('falls back to r_frame_rate for %s', async (_description, average) => {
    probeJson({
      streams: [videoStream({ avg_frame_rate: average, r_frame_rate: '30/1' })],
    })
    await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
      fps: 30,
    })
  })

  it('falls back to r_frame_rate when avg_frame_rate is not a string', async () => {
    probeJson({
      streams: [videoStream({ avg_frame_rate: 25, r_frame_rate: '30/1' })],
    })
    await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
      fps: 30,
    })
  })

  it('prefers a valid avg_frame_rate over r_frame_rate', async () => {
    probeJson({
      streams: [
        videoStream({ avg_frame_rate: '24000/1001', r_frame_rate: '30/1' }),
      ],
    })
    await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
      fps: 24000 / 1001,
    })
  })

  it.each(['0/1', '1/0', '-1/1', 'x', 30])(
    'rejects metadata when neither frame rate is usable (r_frame_rate %j)',
    async (rate) => {
      probeJson({
        streams: [videoStream({ avg_frame_rate: '0/0', r_frame_rate: rate })],
      })
      await expect(probeVideo(directory, 'source.mp4')).rejects.toMatchObject(
        incomplete,
      )
    },
  )
})

describe('rotation parsing', () => {
  it('skips non-object and rotation-less side data before using a later rotation', async () => {
    probeJson({
      streams: [
        videoStream({
          side_data_list: [
            'rotation',
            5,
            null,
            {},
            { rotation: 'bad' },
            { rotation: -90 },
          ],
        }),
      ],
    })
    await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
      width: 240,
      height: 320,
    })
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'rotate'],
    ['a number', 5],
    ['an empty object', {}],
    ['an unparsable rotate tag', { rotate: 'bad' }],
  ])('ignores tags that are %s', async (_description, tags) => {
    probeJson({ streams: [videoStream({ tags })] })
    await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
      width: 320,
      height: 240,
    })
  })

  it.each([
    [0, false],
    [90, true],
    [-90, true],
    [180, false],
    [270, true],
    [450, true],
    [360, false],
  ])(
    'treats a %d degree rotation tag as quarter turn: %s',
    async (rotate, swapped) => {
      probeJson({
        streams: [videoStream({ tags: { rotate: String(rotate) } })],
      })
      await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
        width: swapped ? 240 : 320,
        height: swapped ? 320 : 240,
      })
    },
  )

  it('prefers side data rotation over the rotate tag', async () => {
    probeJson({
      streams: [
        videoStream({
          side_data_list: [{ rotation: 0 }],
          tags: { rotate: '90' },
        }),
      ],
    })
    await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
      width: 320,
      height: 240,
    })
  })

  it('falls back to the rotate tag when side data has no usable rotation', async () => {
    probeJson({
      streams: [
        videoStream({
          side_data_list: [{ rotation: 'bad' }],
          tags: { rotate: '90' },
        }),
      ],
    })
    await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
      width: 240,
      height: 320,
    })
  })
})

describe('stream selection', () => {
  it('uses the first video stream and detects audio anywhere', async () => {
    probeJson({
      streams: [
        { codec_type: 'audio' },
        videoStream({ width: 100, height: 50 }),
        videoStream({ width: 999, height: 999 }),
        { codec_type: 'subtitle' },
      ],
    })
    await expect(probeVideo(directory, 'source.mp4')).resolves.toEqual({
      name: 'source.mp4',
      size: 7,
      width: 100,
      height: 50,
      duration: 1,
      fps: 25,
      hasAudio: true,
    })
  })

  it('reports no audio when only non-audio streams accompany the video', async () => {
    probeJson({ streams: [videoStream(), { codec_type: 'subtitle' }] })
    await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
      hasAudio: false,
    })
  })
})

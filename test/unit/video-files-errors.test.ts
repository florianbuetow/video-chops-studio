import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const probeState = vi.hoisted(() => ({
  stdout: '{}',
  failedCommand: null as string | null,
  calls: [] as { command: string; args: readonly string[] }[],
}))

vi.mock('node:child_process', () => {
  const execute = (command: string, args: readonly string[]): string => {
    probeState.calls.push({ command, args })
    if (probeState.failedCommand === command) {
      throw new Error(`${command} failed`)
    }
    return command === 'ffprobe' ? probeState.stdout : `${command} version`
  }
  const mockedExecFile = vi.fn(
    (
      command: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      queueMicrotask(() => {
        try {
          callback(null, execute(command, args), '')
        } catch (error) {
          callback(
            error instanceof Error ? error : new Error(String(error)),
            '',
            '',
          )
        }
      })
    },
  )
  Object.defineProperty(
    mockedExecFile,
    Symbol.for('nodejs.util.promisify.custom'),
    {
      value: async (command: string, args: readonly string[]) => ({
        stdout: execute(command, args),
        stderr: '',
      }),
    },
  )
  return { execFile: mockedExecFile }
})

import {
  checkVideoTools,
  probeVideo,
  VideoFileError,
} from '../../src/application/video-files.js'

const temporaryDirectories: string[] = []

async function inputFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'video-file-errors-'))
  temporaryDirectories.push(directory)
  await writeFile(join(directory, 'source.mp4'), 'fixture')
  return directory
}

function probeJson(value: unknown): void {
  probeState.stdout = JSON.stringify(value)
}

afterEach(async () => {
  probeState.stdout = '{}'
  probeState.failedCommand = null
  probeState.calls.length = 0
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('ffprobe response validation', () => {
  it('rejects process failures and malformed JSON as typed file errors', async () => {
    const directory = await inputFixture()
    probeState.failedCommand = 'ffprobe'
    await expect(probeVideo(directory, 'source.mp4')).rejects.toMatchObject({
      name: 'VideoFileError',
      message: 'ffprobe could not inspect "source.mp4"',
      cause: expect.any(Error),
    })

    probeState.failedCommand = null
    probeState.stdout = '{not json'
    await expect(probeVideo(directory, 'source.mp4')).rejects.toMatchObject({
      name: 'VideoFileError',
      message: 'ffprobe returned invalid data for "source.mp4"',
      cause: expect.any(Error),
    })
  })

  it.each([
    [{}, 'video has no readable streams'],
    [{ streams: [] }, 'file has no video stream'],
    [
      {
        streams: [
          {
            codec_type: 'video',
            height: 240,
            avg_frame_rate: '25/1',
            duration: '1',
          },
        ],
      },
      'video metadata is incomplete',
    ],
    [
      {
        streams: [
          {
            codec_type: 'video',
            width: 320,
            avg_frame_rate: '25/1',
            duration: '1',
          },
        ],
      },
      'video metadata is incomplete',
    ],
    [
      {
        streams: [
          {
            codec_type: 'video',
            width: 320,
            height: 240,
            avg_frame_rate: '0/0',
            duration: '1',
          },
        ],
      },
      'video metadata is incomplete',
    ],
    [
      {
        streams: [
          {
            codec_type: 'video',
            width: 320,
            height: 240,
            avg_frame_rate: '25/1',
          },
        ],
      },
      'video metadata is incomplete',
    ],
  ])('rejects incomplete probe response %#', async (response, message) => {
    const directory = await inputFixture()
    probeJson(response)
    await expect(probeVideo(directory, 'source.mp4')).rejects.toThrow(message)
  })

  it('uses fallback rate and format duration, tag rotation, and audio detection', async () => {
    const directory = await inputFixture()
    probeJson({
      streams: [
        {
          codec_type: 'video',
          width: 320,
          height: 240,
          avg_frame_rate: null,
          r_frame_rate: '30000/1001',
          tags: { rotate: '-90' },
          side_data_list: [{ rotation: 'not-a-number' }],
        },
        { codec_type: 'audio' },
      ],
      format: { duration: '2.5' },
    })
    await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
      name: 'source.mp4',
      size: 7,
      width: 240,
      height: 320,
      duration: 2.5,
      fps: 30000 / 1001,
      hasAudio: true,
    })
  })

  it('accepts a direct numeric frame-rate string and ignores invalid rotation structures', async () => {
    const directory = await inputFixture()
    probeJson({
      streams: [
        {
          codec_type: 'video',
          width: '320',
          height: '240',
          duration: '1.25',
          avg_frame_rate: '25',
          side_data_list: [null, { rotation: 0 }],
          tags: { rotate: 'invalid' },
        },
      ],
      format: null,
    })
    await expect(probeVideo(directory, 'source.mp4')).resolves.toMatchObject({
      width: 320,
      height: 240,
      duration: 1.25,
      fps: 25,
      hasAudio: false,
    })
  })
})

describe('video tool checks', () => {
  it('checks ffmpeg and ffprobe with bounded version commands', async () => {
    await expect(checkVideoTools()).resolves.toBeUndefined()
    expect(probeState.calls).toEqual([
      { command: 'ffmpeg', args: ['-version'] },
      { command: 'ffprobe', args: ['-version'] },
    ])
  })

  it.each(['ffmpeg', 'ffprobe'])(
    'reports an actionable %s failure',
    async (command) => {
      probeState.failedCommand = command
      await expect(checkVideoTools()).rejects.toMatchObject({
        name: 'VideoFileError',
        message: `${command} is unavailable; install FFmpeg and ensure both ffmpeg and ffprobe are on PATH`,
        cause: expect.any(Error),
      })
    },
  )

  it('uses the exported typed error class', () => {
    expect(new VideoFileError('failed')).toMatchObject({
      name: 'VideoFileError',
      message: 'failed',
    })
  })
})

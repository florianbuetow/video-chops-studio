import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { probeVideo } from '../../src/application/video-files.js'
import {
  preparePreview,
  renderVideo,
  VideoRenderError,
} from '../../src/application/video-render.js'

const execFileAsync = promisify(execFile)

async function withFixture(
  run: (paths: {
    root: string
    input: string
    output: string
    cache: string
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'video-render-test-'))
  const input = join(root, 'input')
  const output = join(root, 'output')
  const cache = join(root, 'cache')
  await mkdir(input)
  const source = join(input, 'source.mp4')
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=25:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      source,
    ])
    await run({ root, input, output, cache })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('renderVideo', () => {
  it('renders multiple retained segments with the requested crop and reports progress', async () => {
    await withFixture(async ({ input, output }) => {
      const progress: number[] = []
      const result = await renderVideo(
        input,
        output,
        {
          source: 'source.mp4',
          segments: [
            { start: 0.1, end: 0.5 },
            { start: 0.9, end: 1.4 },
          ],
          crop: { x: 20, y: 20, width: 200, height: 100 },
          outputName: 'result.mp4',
          muted: false,
        },
        (fraction) => progress.push(fraction),
      )
      expect(result.name).toBe('result.mp4')
      expect(result.width).toBe(200)
      expect(result.height).toBe(100)
      expect(result.duration).toBeCloseTo(0.9, 6)
      expect(result.size).toBeGreaterThan(0)
      expect(progress[0]).toBe(0)
      expect(progress.at(-1)).toBe(1)
      expect(
        progress.every(
          (value, index) => index === 0 || value >= (progress[index - 1] ?? 0),
        ),
      ).toBe(true)

      const rendered = await probeVideo(output, 'result.mp4')
      expect(rendered.width).toBe(200)
      expect(rendered.height).toBe(100)
      expect(rendered.duration).toBeCloseTo(0.9, 1)
      expect(rendered.hasAudio).toBe(true)
    })
  }, 20_000)

  it('does not overwrite an existing export', async () => {
    await withFixture(async ({ input, output }) => {
      const request = {
        source: 'source.mp4',
        segments: [{ start: 0, end: 0.2 }],
        crop: { x: 0, y: 0, width: 320, height: 240 },
        outputName: 'same.mp4',
        muted: true,
      } as const
      await renderVideo(input, output, request, () => undefined)
      const before = await stat(join(output, 'same.mp4'))
      await expect(
        renderVideo(input, output, request, () => undefined),
      ).rejects.toBeInstanceOf(VideoRenderError)
      const after = await stat(join(output, 'same.mp4'))
      expect(after.size).toBe(before.size)
    })
  }, 20_000)

  it('trims relative to media start when input timestamps are nonzero', async () => {
    await withFixture(async ({ input, output }) => {
      await execFileAsync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-itsoffset',
        '5',
        '-i',
        join(input, 'source.mp4'),
        '-c',
        'copy',
        join(input, 'shifted.mp4'),
      ])
      const result = await renderVideo(
        input,
        output,
        {
          source: 'shifted.mp4',
          segments: [{ start: 0.1, end: 0.5 }],
          crop: { x: 0, y: 0, width: 320, height: 240 },
          outputName: 'shifted-result.mp4',
          muted: false,
        },
        () => undefined,
      )
      expect(result.duration).toBeCloseTo(0.4, 6)
      const rendered = await probeVideo(output, 'shifted-result.mp4')
      expect(rendered.duration).toBeCloseTo(0.4, 1)
      expect(rendered.hasAudio).toBe(true)
    })
  }, 20_000)
})

describe('preparePreview', () => {
  it('creates and reuses a browser-compatible cached preview', async () => {
    await withFixture(async ({ input, cache }) => {
      const [first, simultaneous] = await Promise.all([
        preparePreview(input, 'source.mp4', cache),
        preparePreview(input, 'source.mp4', cache),
      ])
      expect(simultaneous).toBe(first)
      expect(await preparePreview(input, 'source.mp4', cache)).toBe(first)
      const preview = await probeVideo(cache, first.split('/').at(-1) ?? '')
      expect(preview.width).toBeLessThanOrEqual(1280)
      expect(preview.height).toBeLessThanOrEqual(1280)
      expect(preview.hasAudio).toBe(true)
    })
  }, 20_000)
})

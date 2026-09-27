import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { probeVideo } from '../../src/application/video-files.js'
import { renderVideo } from '../../src/application/video-render.js'

const execFileAsync = promisify(execFile)

async function samplePixel(
  video: string,
  x: number,
  y: number,
): Promise<readonly [number, number, number]> {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      '0.2',
      '-i',
      video,
      '-vf',
      `crop=2:2:${x}:${y},scale=1:1,format=rgb24`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { encoding: 'buffer' },
  )
  const bytes = stdout
  return [bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0]
}

function expectRgbNear(
  actual: readonly [number, number, number],
  expected: readonly [number, number, number],
  tolerance = 4,
): void {
  expected.forEach((channel, index) => {
    expect(actual[index], JSON.stringify(actual)).toBeGreaterThanOrEqual(
      channel - tolerance,
    )
    expect(actual[index], JSON.stringify(actual)).toBeLessThanOrEqual(
      channel + tolerance,
    )
  })
}

describe('composition rendering', () => {
  it('renders two independent source regions onto a colored output canvas', async () => {
    const root = await mkdtemp(join(tmpdir(), 'composition-render-test-'))
    const input = join(root, 'input')
    const output = join(root, 'output')
    await mkdir(input)
    const source = join(input, 'source.mp4')
    const background = join(input, 'background.png')
    try {
      await execFileAsync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=160x60:d=1[r];color=c=blue:s=160x60:d=1[b];[r][b]vstack',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-color_primaries',
        'bt709',
        '-color_trc',
        'bt709',
        '-colorspace',
        'bt709',
        '-color_range',
        'tv',
        '-c:a',
        'aac',
        '-shortest',
        source,
      ])
      await execFileAsync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=yellow@0.5:s=100x160,format=rgba',
        '-frames:v',
        '1',
        background,
      ])

      const result = await renderVideo(
        input,
        output,
        {
          source: 'source.mp4',
          segments: [{ start: 0.1, end: 0.8 }],
          crop: { x: 0, y: 0, width: 160, height: 120 },
          outputName: 'result.mp4',
          muted: false,
          composition: {
            width: 200,
            height: 120,
            background: '#00FF00',
            backgroundImage: 'background.png',
            frame: { target: 'regions', color: '#FFFFFF', width: 4 },
            regions: [
              {
                crop: { x: 0, y: 0, width: 80, height: 40 },
                x: 10,
                y: 10,
                scale: 1,
              },
              {
                crop: { x: 40, y: 60, width: 80, height: 40 },
                x: 10,
                y: 10,
                scale: 0.5,
              },
            ],
          },
        },
        () => undefined,
      )

      expect(result).toMatchObject({
        name: 'result.mp4',
        width: 200,
        height: 120,
      })
      expect(result.duration).toBeCloseTo(0.7, 6)
      const rendered = await probeVideo(output, 'result.mp4')
      expect(rendered).toMatchObject({
        width: 200,
        height: 120,
        hasAudio: true,
      })
      expect(rendered.duration).toBeCloseTo(0.7, 1)

      const renderedPath = join(output, 'result.mp4')
      expectRgbNear(
        await samplePixel(renderedPath, 60, 30),
        await samplePixel(source, 60, 30),
      )
      const regionFrame = await samplePixel(renderedPath, 11, 35)
      expect(regionFrame.every((channel) => channel > 180)).toBe(true)
      expectRgbNear(
        await samplePixel(renderedPath, 20, 20),
        await samplePixel(source, 60, 80),
      )
      const imageBackground = await samplePixel(renderedPath, 190, 110)
      expect(imageBackground[0]).toBeGreaterThan(80)
      expect(imageBackground[1]).toBeGreaterThan(180)
      expect(imageBackground[2]).toBeLessThan(80)

      await renderVideo(
        input,
        output,
        {
          source: 'source.mp4',
          segments: [{ start: 0.1, end: 0.8 }],
          crop: { x: 0, y: 0, width: 160, height: 120 },
          outputName: 'canvas-frame.mp4',
          muted: false,
          composition: {
            width: 200,
            height: 120,
            background: '#335577',
            frame: { target: 'canvas', color: '#F03020', width: 8 },
            regions: [
              {
                crop: { x: 0, y: 0, width: 80, height: 40 },
                x: 10,
                y: 10,
                scale: 1,
              },
              {
                crop: { x: 40, y: 60, width: 80, height: 40 },
                x: 100,
                y: 80,
                scale: 0.5,
              },
            ],
          },
        },
        () => undefined,
      )
      const canvasFramePath = join(output, 'canvas-frame.mp4')
      expectRgbNear(await samplePixel(canvasFramePath, 4, 4), [240, 48, 32])
      expectRgbNear(await samplePixel(canvasFramePath, 170, 60), [51, 85, 119])
      const { stdout: colorMetadata } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=color_space,color_transfer,color_primaries',
        '-of',
        'default=noprint_wrappers=1',
        canvasFramePath,
      ])
      expect(colorMetadata).toContain('color_space=bt709')
      expect(colorMetadata).toContain('color_transfer=bt709')
      expect(colorMetadata).toContain('color_primaries=bt709')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})

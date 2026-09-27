import { describe, expect, it } from 'vitest'

import {
  buildExportArgs,
  editDuration,
  validateEdit,
  VideoValidationError,
  type EditRequest,
  type VideoMetadata,
} from '../../src/domain/video.js'

const metadata: VideoMetadata = {
  name: 'source.mp4',
  size: 123,
  width: 1920,
  height: 1080,
  duration: 10,
  fps: 25,
  hasAudio: true,
}

const edit: EditRequest = {
  source: 'source.mp4',
  segments: [
    { start: 0.25, end: 1.5 },
    { start: 3, end: 4.25 },
  ],
  crop: { x: 10, y: 20, width: 800, height: 600 },
  outputName: 'edited.mp4',
  muted: false,
}

describe('validateEdit', () => {
  it('accepts a strict valid edit and preserves its values', () => {
    expect(validateEdit(edit, metadata)).toEqual(edit)
  })

  it('accepts exact inclusive boundaries and touching segments', () => {
    const segments = new Array(128).fill(undefined).map((_value, index) => ({
      start: index * 0.05,
      end: (index + 1) * 0.05,
    }))
    const result = validateEdit(
      { ...edit, segments, crop: { x: 0, y: 0, width: 2, height: 2 } },
      metadata,
    )
    expect(result.segments).toHaveLength(128)
    expect(result.crop).toEqual({ x: 0, y: 0, width: 2, height: 2 })
  })

  it.each([
    [{ ...edit, extra: true }, 'edit must contain exactly'],
    [{ ...edit, source: '../source.mp4' }, 'source must be a single file name'],
    [
      { ...edit, outputName: 'edited.mov' },
      'outputName must be a non-hidden .mp4',
    ],
    [{ ...edit, segments: [] }, 'segments must contain between'],
    [{ ...edit, segments: [{ start: 1, end: 1.01 }] }, 'at least 0.05 seconds'],
    [
      {
        ...edit,
        segments: [
          { start: 2, end: 3 },
          { start: 2.5, end: 4 },
        ],
      },
      'sorted and must not overlap',
    ],
    [
      { ...edit, crop: { x: 1, y: 0, width: 800, height: 600 } },
      'origin and dimensions must be even',
    ],
    [
      { ...edit, crop: { x: 0, y: 0, width: 1922, height: 600 } },
      'fit within the video frame',
    ],
  ])('rejects invalid edits', (candidate, message) => {
    expect(() => validateEdit(candidate, metadata)).toThrow(
      VideoValidationError,
    )
    expect(() => validateEdit(candidate, metadata)).toThrow(message)
  })

  it('allows an end timestamp within one frame of rounded metadata duration', () => {
    expect(
      validateEdit({ ...edit, segments: [{ start: 9, end: 10.04 }] }, metadata)
        .segments,
    ).toEqual([{ start: 9, end: 10.04 }])
    expect(() =>
      validateEdit(
        { ...edit, segments: [{ start: 9, end: 10.041 }] },
        metadata,
      ),
    ).toThrow('exceeds the video duration')
  })

  it.each([
    [null, 'edit must be an object'],
    [{ ...edit, source: '' }, 'source must be a single file name'],
    [{ ...edit, source: '.' }, 'source must be a single file name'],
    [{ ...edit, source: '..' }, 'source must be a single file name'],
    [{ ...edit, source: 42 }, 'source must be a single file name'],
    [{ ...edit, source: 'bad/name.mp4' }, 'source must be a single file name'],
    [{ ...edit, source: 'bad\\name.mp4' }, 'source must be a single file name'],
    [{ ...edit, source: 'bad\nname.mp4' }, 'source must be a single file name'],
    [{ ...edit, outputName: '.hidden.mp4' }, 'non-hidden .mp4'],
    [{ ...edit, muted: 'false' }, 'muted must be a boolean'],
    [{ ...edit, segments: 'all' }, 'segments must contain between'],
    [
      { ...edit, segments: new Array(129).fill({ start: 0, end: 1 }) },
      'segments must contain between',
    ],
    [{ ...edit, segments: [null] }, 'segment 0 must be an object'],
    [
      { ...edit, segments: [{ start: 0, end: 1, note: '' }] },
      'segment 0 must contain exactly',
    ],
    [
      { ...edit, segments: [{ start: Number.NaN, end: 1 }] },
      'start must be a finite number',
    ],
    [
      { ...edit, segments: [{ start: 0, end: Number.POSITIVE_INFINITY }] },
      'end must be a finite number',
    ],
    [
      { ...edit, segments: [{ start: -0.1, end: 1 }] },
      'start must be non-negative',
    ],
    [{ ...edit, crop: null }, 'crop must be an object'],
    [
      { ...edit, crop: { ...edit.crop, extra: 1 } },
      'crop must contain exactly',
    ],
    [
      { ...edit, crop: { ...edit.crop, width: 1.5 } },
      'crop values must be integers',
    ],
    [{ ...edit, crop: { ...edit.crop, x: -2 } }, 'non-negative origin'],
    [{ ...edit, crop: { ...edit.crop, y: -2 } }, 'non-negative origin'],
    [{ ...edit, crop: { ...edit.crop, width: 1 } }, 'dimensions of at least 2'],
    [
      { ...edit, crop: { ...edit.crop, width: 801 } },
      'origin and dimensions must be even',
    ],
    [
      { ...edit, crop: { ...edit.crop, height: 601 } },
      'origin and dimensions must be even',
    ],
    [
      { ...edit, crop: { ...edit.crop, y: 1 } },
      'origin and dimensions must be even',
    ],
    [
      { ...edit, crop: { x: 0, y: 600, width: 800, height: 600 } },
      'fit within the video frame',
    ],
  ])('rejects malformed boundary input %#', (candidate, message) => {
    expect(() => validateEdit(candidate, metadata)).toThrow(message)
  })

  it.each([
    [{ ...metadata, duration: Number.NaN }],
    [{ ...metadata, duration: 0 }],
    [{ ...metadata, width: 1.5 }],
    [{ ...metadata, width: 0 }],
    [{ ...metadata, height: 1.5 }],
    [{ ...metadata, height: 0 }],
    [{ ...metadata, fps: Number.NaN }],
    [{ ...metadata, fps: 0 }],
  ])('rejects invalid video metadata %#', (candidateMetadata) => {
    expect(() => validateEdit(edit, candidateMetadata)).toThrow(
      'video metadata is invalid',
    )
  })
})

describe('editDuration', () => {
  it('adds only retained ranges', () => {
    expect(editDuration(edit.segments)).toBe(2.5)
  })
})

describe('buildExportArgs', () => {
  it('trims and resets each stream, concatenates, crops, and maps audio', () => {
    const args = buildExportArgs(edit, metadata, '/input.mp4', '/output.mp4')
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter).toContain(
      '[0:v:0]setpts=PTS-STARTPTS,trim=start=0.25:end=1.5,setpts=PTS-STARTPTS[v0]',
    )
    expect(filter).toContain(
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[joinedv][outa]',
    )
    expect(filter).toContain('[joinedv]crop=800:600:10:20[outv]')
    expect(args).toContain('[outa]')
    expect(args).toContain('aac')
    expect(args).toContain('yuv420p')
    expect(args).toContain('+faststart')
    expect(args.slice(-1)).toEqual(['/output.mp4'])
  })

  it.each([
    [{ ...edit, muted: true }, metadata],
    [edit, { ...metadata, hasAudio: false }],
  ])(
    'emits a video-only graph for muted or silent input',
    (request, sourceMetadata) => {
      const args = buildExportArgs(
        request,
        sourceMetadata,
        '/input.mp4',
        '/output.mp4',
      )
      const filter = args[args.indexOf('-filter_complex') + 1]
      expect(filter).toContain('concat=n=2:v=1:a=0[joinedv]')
      expect(filter).not.toContain('atrim')
      expect(args).toContain('-an')
      expect(args).not.toContain('[outa]')
    },
  )
})

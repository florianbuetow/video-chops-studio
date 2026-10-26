import { describe, expect, it } from 'vitest'

import {
  buildExportArgs,
  validateEdit,
  VideoValidationError,
  type EditRequest,
  type VideoMetadata,
} from '../../src/domain/video.js'

const metadata: VideoMetadata = {
  name: 'source.mp4',
  size: 1,
  width: 640,
  height: 480,
  duration: 5,
  fps: 25,
  hasAudio: true,
}

const baseEdit = {
  source: 'source.mp4',
  segments: [{ start: 0, end: 1 }],
  crop: { x: 0, y: 0, width: 640, height: 480 },
  outputName: 'composition.mp4',
  muted: false,
  overwrite: false,
}

const baseComposition = {
  width: 600,
  height: 600,
  background: '#102030',
  regions: [
    {
      crop: { x: 0, y: 0, width: 600, height: 200 },
      x: 0,
      y: 20,
      scale: 0.5,
    },
    {
      crop: { x: 40, y: 200, width: 400, height: 240 },
      x: 200,
      y: 300,
      scale: 1,
    },
  ],
}

const tinyRegion = {
  crop: { x: 0, y: 0, width: 2, height: 2 },
  x: 0,
  y: 0,
  scale: 1,
}

function withComposition(patch: Record<string, unknown>): unknown {
  return { ...baseEdit, composition: { ...baseComposition, ...patch } }
}

function withTinyComposition(width: number, height: number): unknown {
  return withComposition({ width, height, regions: [tinyRegion, tinyRegion] })
}

function withRegion(index: 0 | 1, patch: Record<string, unknown>): unknown {
  const regions = baseComposition.regions.map((region, position) =>
    position === index ? { ...region, ...patch } : region,
  )
  return withComposition({ regions })
}

function expectInvalid(
  candidate: unknown,
  message: string,
  sourceMetadata: VideoMetadata = metadata,
): void {
  let caught: unknown
  try {
    validateEdit(candidate, sourceMetadata)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(VideoValidationError)
  expect((caught as VideoValidationError).name).toBe('VideoValidationError')
  expect((caught as VideoValidationError).message).toBe(message)
}

describe('edit and composition key sets', () => {
  it.each([
    [
      'an extra edit key',
      { ...baseEdit, extra: 1 },
      'edit must contain exactly: source, segments, crop, outputName, muted, overwrite',
    ],
    [
      'an extra key next to a composition',
      { ...baseEdit, composition: baseComposition, extra: 1 },
      'edit must contain exactly: source, segments, crop, outputName, muted, overwrite, composition',
    ],
    [
      'a missing key that sorts last',
      {
        segments: baseEdit.segments,
        crop: baseEdit.crop,
        outputName: baseEdit.outputName,
        muted: false,
        overwrite: false,
      },
      'edit must contain exactly: source, segments, crop, outputName, muted, overwrite',
    ],
    [
      'a misnamed key with the same key count',
      {
        source: baseEdit.source,
        segments: baseEdit.segments,
        crop: baseEdit.crop,
        outputName: baseEdit.outputName,
        mute: false,
        overwrite: false,
      },
      'edit must contain exactly: source, segments, crop, outputName, muted, overwrite',
    ],
    [
      'an extra composition key',
      withComposition({ extra: 1 }),
      'composition must contain exactly: width, height, background, regions',
    ],
    [
      'an extra key next to backgroundImage',
      withComposition({ backgroundImage: 'a.png', extra: 1 }),
      'composition must contain exactly: width, height, background, regions, backgroundImage',
    ],
    [
      'an extra key next to frame',
      withComposition({
        frame: { target: 'canvas', color: '#000000', width: 1 },
        extra: 1,
      }),
      'composition must contain exactly: width, height, background, regions, frame',
    ],
    [
      'an extra key next to backgroundImage and frame',
      withComposition({
        backgroundImage: 'a.png',
        frame: { target: 'canvas', color: '#000000', width: 1 },
        extra: 1,
      }),
      'composition must contain exactly: width, height, background, regions, backgroundImage, frame',
    ],
    [
      'an extra frame key',
      withComposition({
        frame: { target: 'canvas', color: '#000000', width: 1, extra: 1 },
      }),
      'composition frame must contain exactly: target, color, width',
    ],
    [
      'an extra region key',
      withRegion(0, { extra: 1 }),
      'composition region 0 must contain exactly: crop, x, y, scale',
    ],
    [
      'an extra region crop key',
      withRegion(1, { crop: { x: 0, y: 0, width: 2, height: 2, extra: 1 } }),
      'composition region 1 crop must contain exactly: x, y, width, height',
    ],
    [
      'an extra segment key',
      { ...baseEdit, segments: [{ start: 0, end: 1, extra: 1 }] },
      'segment 0 must contain exactly: start, end',
    ],
    [
      'an extra crop key',
      { ...baseEdit, crop: { ...baseEdit.crop, extra: 1 } },
      'crop must contain exactly: x, y, width, height',
    ],
  ])(
    'rejects %s with the exact expected key list',
    (_label, candidate, text) => {
      expectInvalid(candidate, text)
    },
  )
})

describe('non-object inputs', () => {
  it.each([
    ['a string edit', 'abc', 'edit must be an object'],
    ['a numeric edit', 42, 'edit must be an object'],
    ['an array edit', [], 'edit must be an object'],
    [
      'a string composition',
      { ...baseEdit, composition: 'abc' },
      'composition must be an object',
    ],
    ['a string crop', { ...baseEdit, crop: 'abc' }, 'crop must be an object'],
    [
      'a string frame',
      withComposition({ frame: 'abc' }),
      'composition frame must be an object',
    ],
    [
      'a string region',
      withComposition({ regions: [baseComposition.regions[0], 'abc'] }),
      'composition region 1 must be an object',
    ],
    [
      'a string segment',
      { ...baseEdit, segments: ['abc'] },
      'segment 0 must be an object',
    ],
    [
      'a string region crop',
      withRegion(0, { crop: 'abc' }),
      'composition region 0 crop must be an object',
    ],
  ])('rejects %s', (_label, candidate, message) => {
    expectInvalid(candidate, message)
  })
})

describe('crop validation messages', () => {
  it.each([
    ['x', 'crop x must be a finite number'],
    ['y', 'crop y must be a finite number'],
    ['width', 'crop width must be a finite number'],
    ['height', 'crop height must be a finite number'],
  ])('names the crop %s when it is not finite', (field, message) => {
    expectInvalid(
      { ...baseEdit, crop: { ...baseEdit.crop, [field]: Number.NaN } },
      message,
    )
  })

  it.each([
    ['x', 'composition region 0 crop x must be a finite number'],
    ['y', 'composition region 0 crop y must be a finite number'],
    ['width', 'composition region 0 crop width must be a finite number'],
    ['height', 'composition region 0 crop height must be a finite number'],
  ])('names the region crop %s when it is not finite', (field, message) => {
    expectInvalid(
      withRegion(0, {
        crop: { ...baseComposition.regions[0]?.crop, [field]: Number.NaN },
      }),
      message,
    )
  })

  it.each([
    ['x', { x: -2 }],
    ['y', { y: -2 }],
    ['width', { width: 0 }],
    ['height', { height: 0 }],
    ['height', { height: 1 }],
    ['negative height', { height: -2 }],
  ])('rejects a crop with a bad %s', (_field, patch) => {
    expectInvalid(
      { ...baseEdit, crop: { ...baseEdit.crop, ...patch } },
      'crop must have a non-negative origin and dimensions of at least 2 pixels',
    )
  })

  it('accepts a crop that exactly touches the far corner of the frame', () => {
    const result = validateEdit(
      { ...baseEdit, crop: { x: 600, y: 440, width: 40, height: 40 } },
      metadata,
    )
    expect(result.crop).toEqual({ x: 600, y: 440, width: 40, height: 40 })
    expectInvalid(
      { ...baseEdit, crop: { x: 602, y: 440, width: 40, height: 40 } },
      'crop must fit within the video frame',
    )
    expectInvalid(
      { ...baseEdit, crop: { x: 600, y: 442, width: 40, height: 40 } },
      'crop must fit within the video frame',
    )
  })
})

describe('file name validation', () => {
  it.each([
    ['a unit separator', 'a\u001fb.mp4'],
    ['a null character', 'a\u0000b.mp4'],
    ['a delete character', 'a\u007fb.mp4'],
  ])('rejects a source containing %s', (_label, source) => {
    expectInvalid({ ...baseEdit, source }, 'source must be a single file name')
  })

  it('accepts spaces and printable characters in names', () => {
    expect(
      validateEdit({ ...baseEdit, source: 'my clip ~1.mp4' }, metadata).source,
    ).toBe('my clip ~1.mp4')
  })

  it.each([
    ['a number', 42],
    ['an empty string', ''],
    ['a slash', 'a/b.mp4'],
  ])('names outputName when it is %s', (_label, outputName) => {
    expectInvalid(
      { ...baseEdit, outputName },
      'outputName must be a single file name',
    )
  })

  it('requires the .mp4 extension at the end of outputName', () => {
    expectInvalid(
      { ...baseEdit, outputName: 'clip.mp4.txt' },
      'outputName must be a non-hidden .mp4 file name',
    )
    expect(
      validateEdit({ ...baseEdit, outputName: 'CLIP.MP4' }, metadata)
        .outputName,
    ).toBe('CLIP.MP4')
  })
})

describe('segment timing boundaries', () => {
  it('accepts the exact minimum duration including the floating point tolerance', () => {
    const minimum = 0.05 - 1e-9
    expect(
      validateEdit(
        { ...baseEdit, segments: [{ start: 0, end: minimum }] },
        metadata,
      ).segments,
    ).toEqual([{ start: 0, end: minimum }])
    expect(
      validateEdit(
        { ...baseEdit, segments: [{ start: 0.1, end: 0.15 }] },
        metadata,
      ).segments,
    ).toEqual([{ start: 0.1, end: 0.15 }])
  })

  it('rejects segments below the minimum duration and names the segment', () => {
    expectInvalid(
      {
        ...baseEdit,
        segments: [{ start: 0, end: 0.05 - 2e-9 }],
      },
      'segment 0 must be at least 0.05 seconds long',
    )
    expectInvalid(
      {
        ...baseEdit,
        segments: [
          { start: 0, end: 1 },
          { start: 2, end: 2.01 },
        ],
      },
      'segment 1 must be at least 0.05 seconds long',
    )
  })

  it('accepts touching segments and rejects overlaps by name', () => {
    expect(
      validateEdit(
        {
          ...baseEdit,
          segments: [
            { start: 0, end: 1 },
            { start: 1, end: 2 },
          ],
        },
        metadata,
      ).segments,
    ).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ])
    expectInvalid(
      {
        ...baseEdit,
        segments: [
          { start: 0, end: 1 },
          { start: 0.5, end: 2 },
        ],
      },
      'segments must be sorted and must not overlap',
    )
  })
})

describe('composition dimension and color validation', () => {
  it.each([
    [2, 2],
    [4096, 4096],
    [2, 4096],
    [4096, 2],
  ])('accepts a %ix%i canvas', (width, height) => {
    const result = validateEdit(withTinyComposition(width, height), metadata)
    expect(result.composition?.width).toBe(width)
    expect(result.composition?.height).toBe(height)
  })

  it.each([
    ['zero width', { width: 0 }],
    ['zero height', { height: 0 }],
    ['negative width', { width: -2 }],
    ['negative height', { height: -2 }],
    ['oversized width', { width: 4098 }],
    ['oversized height', { height: 4098 }],
    ['odd oversized width', { width: 4097 }],
    ['odd width', { width: 3 }],
    ['odd height', { height: 601 }],
  ])('rejects a canvas with %s', (_label, patch) => {
    expectInvalid(
      withComposition({ ...patch, regions: [tinyRegion, tinyRegion] }),
      'composition dimensions must be even and between 2 and 4096 pixels',
    )
  })

  it('names a non-finite composition width and non-integer dimensions', () => {
    expectInvalid(
      withComposition({ width: Number.NaN }),
      'composition width must be a finite number',
    )
    expectInvalid(
      withComposition({ height: 600.5 }),
      'composition dimensions must be integers',
    )
  })

  it.each([
    ['a prefix', 'x#102030'],
    ['a suffix', '#102030ff'],
    ['too few digits', '#10203'],
    ['non-hex digits', '#gggggg'],
    ['a single-element array', ['#102030']],
    ['a number', 102030],
  ])('rejects a background color with %s', (_label, background) => {
    expectInvalid(
      withComposition({ background }),
      'composition background must be a #RRGGBB color',
    )
  })

  it.each([
    ['a prefix', 'x#102030'],
    ['a suffix', '#102030ff'],
    ['non-hex digits', '#12345g'],
    ['a single-element array', ['#102030']],
  ])('rejects a frame color with %s', (_label, color) => {
    expectInvalid(
      withComposition({ frame: { target: 'regions', color, width: 2 } }),
      'composition frame color must be a #RRGGBB color',
    )
  })

  it.each(['#aBcDeF', '#000000', '#FFFFFF'])('accepts color %s', (color) => {
    const result = validateEdit(
      withComposition({
        background: color,
        frame: { target: 'regions', color, width: 2 },
      }),
      metadata,
    )
    expect(result.composition?.background).toBe(color)
    expect(result.composition?.frame?.color).toBe(color)
  })

  it.each(['a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'A.JPG', 'a.b.PNG'])(
    'accepts background image %s',
    (backgroundImage) => {
      expect(
        validateEdit(withComposition({ backgroundImage }), metadata).composition
          ?.backgroundImage,
      ).toBe(backgroundImage)
    },
  )

  it.each(['a.png.txt', 'a.jpgx', 'a.webp.bak', 'png', 'a.jp'])(
    'rejects background image %s',
    (backgroundImage) => {
      expectInvalid(
        withComposition({ backgroundImage }),
        'composition backgroundImage must be a PNG, JPEG, or WebP file name',
      )
    },
  )

  it.each([1, 64])('accepts frame width %i', (width) => {
    expect(
      validateEdit(
        withComposition({
          frame: { target: 'canvas', color: '#000000', width },
        }),
        metadata,
      ).composition?.frame,
    ).toEqual({ target: 'canvas', color: '#000000', width })
  })

  it.each([0, -1, 65, 2.5, 100])('rejects frame width %f', (width) => {
    expectInvalid(
      withComposition({ frame: { target: 'canvas', color: '#000000', width } }),
      'composition frame width must be an integer between 1 and 64',
    )
  })
})

describe('composition region validation', () => {
  it.each([0, 1] as const)(
    'names region %i for non-integer and misplaced positions',
    (index) => {
      expectInvalid(
        withRegion(index, { x: 2.5 }),
        `composition region ${index} position must use integers`,
      )
      expectInvalid(
        withRegion(index, { y: 2.5 }),
        `composition region ${index} position must use integers`,
      )
      for (const patch of [{ x: -2 }, { y: -2 }, { x: 1 }, { y: 1 }]) {
        expectInvalid(
          withRegion(index, patch),
          `composition region ${index} position must be even and non-negative`,
        )
      }
    },
  )

  it('names region coordinates that are not finite', () => {
    expectInvalid(
      withRegion(1, { x: Number.NaN }),
      'composition region 1 x must be a finite number',
    )
    expectInvalid(
      withRegion(1, { y: Number.NaN }),
      'composition region 1 y must be a finite number',
    )
  })

  it('accepts an origin of zero on both axes', () => {
    const result = validateEdit(withRegion(0, { x: 0, y: 0 }), metadata)
    expect(result.composition?.regions[0]).toMatchObject({ x: 0, y: 0 })
  })

  it('accepts regions that exactly touch the canvas edge and rejects one pixel more', () => {
    const exactRight = validateEdit(withRegion(0, { x: 300 }), metadata)
    expect(exactRight.composition?.regions[0].x).toBe(300)
    const exactBottom = validateEdit(withRegion(1, { y: 360 }), metadata)
    expect(exactBottom.composition?.regions[1].y).toBe(360)
    const exactFirstBottom = validateEdit(withRegion(0, { y: 500 }), metadata)
    expect(exactFirstBottom.composition?.regions[0].y).toBe(500)

    expectInvalid(
      withRegion(0, { x: 302 }),
      'composition region 0 must fit within the output frame',
    )
    expectInvalid(
      withRegion(0, { y: 502 }),
      'composition region 0 must fit within the output frame',
    )
    expectInvalid(
      withRegion(1, { y: 362 }),
      'composition region 1 must fit within the output frame',
    )
    expectInvalid(
      withRegion(1, { x: 202 }),
      'composition region 1 must fit within the output frame',
    )
  })

  it('omits optional composition keys entirely when they are absent', () => {
    const plain = validateEdit(withComposition({}), metadata).composition
    expect(plain).toStrictEqual({
      width: 600,
      height: 600,
      background: '#102030',
      regions: baseComposition.regions,
    })
    const image = validateEdit(
      withComposition({ backgroundImage: 'a.png' }),
      metadata,
    ).composition
    expect(Object.keys(image ?? {})).toEqual([
      'width',
      'height',
      'background',
      'backgroundImage',
      'regions',
    ])
    const frame = validateEdit(
      withComposition({
        frame: { target: 'canvas', color: '#000000', width: 3 },
      }),
      metadata,
    ).composition
    expect(Object.keys(frame ?? {})).toEqual([
      'width',
      'height',
      'background',
      'frame',
      'regions',
    ])
  })
})

describe('export argument list', () => {
  const edit: EditRequest = {
    source: 'source.mp4',
    segments: [
      { start: 0.25, end: 1.5 },
      { start: 3, end: 4.25 },
    ],
    crop: { x: 10, y: 20, width: 400, height: 300 },
    outputName: 'edited.mp4',
    muted: false,
    overwrite: false,
  }
  const longMetadata: VideoMetadata = { ...metadata, duration: 10 }

  it('builds the exact argument vector for an audio crop export', () => {
    expect(buildExportArgs(edit, longMetadata, '/in.mp4', '/out.mp4')).toEqual([
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      '/in.mp4',
      '-filter_complex',
      [
        '[0:v:0]setpts=PTS-STARTPTS,trim=start=0.25:end=1.5,setpts=PTS-STARTPTS[v0]',
        '[0:a:0]asetpts=PTS-STARTPTS,atrim=start=0.25:end=1.5,asetpts=PTS-STARTPTS[a0]',
        '[0:v:0]setpts=PTS-STARTPTS,trim=start=3:end=4.25,setpts=PTS-STARTPTS[v1]',
        '[0:a:0]asetpts=PTS-STARTPTS,atrim=start=3:end=4.25,asetpts=PTS-STARTPTS[a1]',
        '[v0][a0][v1][a1]concat=n=2:v=1:a=1[joinedv][outa]',
        '[joinedv]crop=400:300:10:20[outv]',
      ].join(';'),
      '-map',
      '[outv]',
      '-map',
      '[outa]',
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
      '/out.mp4',
    ])
  })

  it('builds the exact argument vector for a muted crop export', () => {
    expect(
      buildExportArgs(
        { ...edit, muted: true },
        longMetadata,
        '/in.mp4',
        '/out.mp4',
      ),
    ).toEqual([
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      '/in.mp4',
      '-filter_complex',
      [
        '[0:v:0]setpts=PTS-STARTPTS,trim=start=0.25:end=1.5,setpts=PTS-STARTPTS[v0]',
        '[0:v:0]setpts=PTS-STARTPTS,trim=start=3:end=4.25,setpts=PTS-STARTPTS[v1]',
        '[v0][v1]concat=n=2:v=1:a=0[joinedv]',
        '[joinedv]crop=400:300:10:20[outv]',
      ].join(';'),
      '-map',
      '[outv]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-movflags',
      '+faststart',
      '-threads',
      '2',
      '-progress',
      'pipe:1',
      '-nostats',
      '/out.mp4',
    ])
  })
})

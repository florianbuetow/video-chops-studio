import { describe, expect, it } from 'vitest'

import {
  buildExportArgs,
  regionSize,
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

const edit = {
  source: 'source.mp4',
  segments: [{ start: 0, end: 1 }],
  crop: { x: 0, y: 0, width: 640, height: 480 },
  outputName: 'composition.mp4',
  muted: false,
  composition: {
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
  },
} as const satisfies EditRequest

describe('composition validation', () => {
  it('accepts and clones a strict two-region composition', () => {
    const validated = validateEdit(edit, metadata)
    expect(validated).toEqual(edit)
    expect(validated).not.toBe(edit)
    expect(validated.composition).not.toBe(edit.composition)
    expect(validated.composition?.regions).not.toBe(edit.composition?.regions)
    expect(validated.composition?.regions[0].crop).not.toBe(
      edit.composition?.regions[0].crop,
    )
  })

  it('rounds scaled dimensions down to even pixels without dropping below two', () => {
    expect(
      regionSize({
        crop: { x: 0, y: 0, width: 100, height: 50 },
        x: 0,
        y: 0,
        scale: 0.333,
      }),
    ).toEqual({ width: 32, height: 16 })
    expect(
      regionSize({
        crop: { x: 0, y: 0, width: 2, height: 4 },
        x: 0,
        y: 0,
        scale: 0.01,
      }),
    ).toEqual({ width: 2, height: 2 })
  })

  it('accepts and clones optional background image and frame settings', () => {
    const candidate = {
      ...edit,
      composition: {
        ...edit.composition,
        backgroundImage: 'backdrop.webp',
        frame: { target: 'regions', color: '#ABCDEF', width: 12 },
      },
    } as const
    const validated = validateEdit(candidate, metadata)
    expect(validated).toEqual(candidate)
    expect(validated.composition?.frame).not.toBe(candidate.composition.frame)
  })

  it.each([
    [{ ...edit, composition: null }, 'composition must be an object'],
    [
      { ...edit, composition: { ...edit.composition, extra: true } },
      'composition must contain exactly',
    ],
    [
      { ...edit, composition: { ...edit.composition, width: 601 } },
      'dimensions must be even and between 2 and 4096',
    ],
    [
      { ...edit, composition: { ...edit.composition, height: 4098 } },
      'dimensions must be even and between 2 and 4096',
    ],
    [
      { ...edit, composition: { ...edit.composition, width: 600.5 } },
      'dimensions must be integers',
    ],
    [
      {
        ...edit,
        composition: { ...edit.composition, height: Number.NaN },
      },
      'composition height must be a finite number',
    ],
    [
      { ...edit, composition: { ...edit.composition, background: 'black' } },
      'background must be a #RRGGBB color',
    ],
    [
      { ...edit, composition: { ...edit.composition, backgroundImage: null } },
      'composition backgroundImage must be a single file name',
    ],
    [
      {
        ...edit,
        composition: { ...edit.composition, backgroundImage: '../image.png' },
      },
      'composition backgroundImage must be a single file name',
    ],
    [
      {
        ...edit,
        composition: { ...edit.composition, backgroundImage: 'image.gif' },
      },
      'composition backgroundImage must be a PNG, JPEG, or WebP file name',
    ],
    [
      { ...edit, composition: { ...edit.composition, frame: null } },
      'composition frame must be an object',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          frame: { target: 'canvas', color: '#000000', width: 1, extra: true },
        },
      },
      'composition frame must contain exactly',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          frame: { target: 'video', color: '#000000', width: 1 },
        },
      },
      'composition frame target must be regions or canvas',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          frame: { target: 'canvas', color: 'black', width: 1 },
        },
      },
      'composition frame color must be a #RRGGBB color',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          frame: { target: 'canvas', color: '#000000', width: Number.NaN },
        },
      },
      'composition frame width must be a finite number',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          frame: { target: 'canvas', color: '#000000', width: 65 },
        },
      },
      'composition frame width must be an integer between 1 and 64',
    ],
    [
      { ...edit, composition: { ...edit.composition, regions: [] } },
      'regions must contain exactly 2 entries',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          regions: [edit.composition?.regions[0], null],
        },
      },
      'composition region 1 must be an object',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          regions: [
            { ...edit.composition?.regions[0], extra: true },
            edit.composition?.regions[1],
          ],
        },
      },
      'composition region 0 must contain exactly',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          regions: [
            { ...edit.composition?.regions[0], scale: Number.NaN },
            edit.composition?.regions[1],
          ],
        },
      },
      'composition region 0 scale must be a finite number',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          regions: [
            { ...edit.composition?.regions[0], scale: 1.01 },
            edit.composition?.regions[1],
          ],
        },
      },
      'scale must be greater than 0 and at most 1',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          regions: [
            { ...edit.composition?.regions[0], scale: 0 },
            edit.composition?.regions[1],
          ],
        },
      },
      'scale must be greater than 0 and at most 1',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          regions: [
            { ...edit.composition?.regions[0], x: 1 },
            edit.composition?.regions[1],
          ],
        },
      },
      'position must be even and non-negative',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          regions: [
            { ...edit.composition?.regions[0], y: Number.NaN },
            edit.composition?.regions[1],
          ],
        },
      },
      'composition region 0 y must be a finite number',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          regions: [
            { ...edit.composition?.regions[0], x: 302 },
            edit.composition?.regions[1],
          ],
        },
      },
      'composition region 0 must fit within the output frame',
    ],
    [
      {
        ...edit,
        composition: {
          ...edit.composition,
          regions: [
            {
              ...edit.composition?.regions[0],
              crop: { x: 0, y: 0, width: 642, height: 200 },
            },
            edit.composition?.regions[1],
          ],
        },
      },
      'composition region 0 crop must fit within the video frame',
    ],
  ])('rejects malformed composition input %#', (candidate, message) => {
    expect(() => validateEdit(candidate, metadata)).toThrow(
      VideoValidationError,
    )
    expect(() => validateEdit(candidate, metadata)).toThrow(message)
  })

  it('allows source and destination overlap', () => {
    const first = edit.composition?.regions[0]
    expect(first).toBeDefined()
    const candidate = {
      ...edit,
      composition: {
        ...edit.composition,
        regions: [first, { ...first, x: 0, y: 20 }],
      },
    }
    expect(validateEdit(candidate, metadata).composition?.regions).toHaveLength(
      2,
    )
  })
})

describe('composition export graph', () => {
  it('splits the joined edit and builds two independently placed regions', () => {
    const args = buildExportArgs(edit, metadata, '/input.mp4', '/output.mp4')
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter).toContain(
      '[joinedv]setpts=PTS-STARTPTS,split=3[clock][region0input][region1input]',
    )
    expect(filter).toContain(
      '[clock]crop=w=2:h=2:x=0:y=0:exact=1,scale=w=600:h=600,format=rgba,drawbox=x=0:y=0:w=iw:h=ih:color=0x102030:t=fill,setsar=1[colorcanvas]',
    )
    expect(filter).toContain(
      '[region0input]crop=w=600:h=200:x=0:y=0:exact=1,scale=w=300:h=100:flags=lanczos:reset_sar=1,format=rgba[region0]',
    )
    expect(filter).toContain(
      '[region1input]crop=w=400:h=240:x=40:y=200:exact=1,scale=w=400:h=240:flags=lanczos:reset_sar=1,format=rgba[region1]',
    )
    expect(filter).toContain(
      '[colorcanvas][region0]overlay=x=0:y=20:shortest=1:eof_action=endall:format=rgb[region0canvas]',
    )
    expect(filter).toContain(
      '[region0canvas][region1]overlay=x=200:y=300:shortest=1:eof_action=endall:format=rgb[composed]',
    )
    expect(filter).toContain(
      '[composed]format=rgb24,scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[outv]',
    )
    expect(args).toContain('-color_primaries')
  })

  it('requires and configures a looped background image input', () => {
    const composed = {
      ...edit,
      composition: { ...edit.composition, backgroundImage: 'image.png' },
    }
    expect(() =>
      buildExportArgs(composed, metadata, '/input.mp4', '/output.mp4'),
    ).toThrow('backgroundPath is required')

    const args = buildExportArgs(
      composed,
      metadata,
      '/input.mp4',
      '/output.mp4',
      '/image.png',
    )
    expect(args).toContain('-loop')
    expect(args).toContain('/image.png')
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter).toContain(
      '[1:v:0]scale=w=600:h=600:force_original_aspect_ratio=increase',
    )
    expect(filter).toContain(
      '[colorcanvas][backgroundimage]overlay=x=0:y=0:shortest=1:eof_action=endall:format=rgb[backgroundcanvas]',
    )
  })

  it.each(['regions', 'canvas'] as const)(
    'draws the %s frame inside the selected target',
    (target) => {
      const framed = {
        ...edit,
        composition: {
          ...edit.composition,
          frame: { target, color: '#FEDCBA', width: 7 },
        },
      }
      const args = buildExportArgs(
        framed,
        metadata,
        '/input.mp4',
        '/output.mp4',
      )
      const filter = args[args.indexOf('-filter_complex') + 1]
      const frameFilter = 'drawbox=x=0:y=0:w=iw:h=ih:color=0xFEDCBA:t=7'
      expect(filter?.split(frameFilter)).toHaveLength(
        target === 'regions' ? 3 : 2,
      )
      if (target === 'canvas') {
        expect(filter).toContain(`[composed]${frameFilter}[styled]`)
      }
    },
  )
})

import { describe, expect, it } from 'vitest'

import type { Composition, Crop, VideoRegion } from '../../src/domain/video.js'
import {
  changePreset,
  CompositionGeometryError,
  initialComposition,
  maxStackGap,
  moveRegion,
  normalizeStackGap,
  resizeRegion,
  scaleRegion,
  stackRegions,
  updateRegionCrop,
  type ResizeCorner,
} from '../../src/web/composition.js'

const firstRegion: VideoRegion = {
  crop: { x: 0, y: 0, width: 400, height: 200 },
  x: 100,
  y: 100,
  scale: 0.5,
}

const secondRegion: VideoRegion = {
  crop: { x: 0, y: 200, width: 400, height: 200 },
  x: 100,
  y: 400,
  scale: 0.5,
}

function canvas(
  overrides: Partial<Composition> = {},
  first: Partial<VideoRegion> = {},
  second: Partial<VideoRegion> = {},
): Composition {
  return {
    width: 800,
    height: 600,
    background: '#000000',
    regions: [
      { ...firstRegion, ...first },
      { ...secondRegion, ...second },
    ],
    ...overrides,
  }
}

function withCrop(index: 0 | 1, patch: Partial<Crop>): Composition {
  const source = index === 0 ? firstRegion : secondRegion
  const region = { crop: { ...source.crop, ...patch } }
  return index === 0 ? canvas({}, region) : canvas({}, {}, region)
}

function geometryError(operation: () => unknown): CompositionGeometryError {
  try {
    operation()
  } catch (error) {
    if (error instanceof CompositionGeometryError) return error
    throw error
  }
  throw new Error('Expected the operation to throw CompositionGeometryError')
}

function expectGeometryMessage(
  operation: () => unknown,
  message: string,
): void {
  const error = geometryError(operation)
  expect(error.name).toBe('CompositionGeometryError')
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toBe(message)
}

const DIMENSION_MESSAGE =
  'Composition dimensions must be positive even integers of at least 2 pixels'
const VIDEO_MESSAGE =
  'Video dimensions must be positive integers of at least 2 pixels'
const CROP_MESSAGE =
  'Crop geometry must use non-negative even origins and even dimensions of at least 2 pixels'

describe('composition geometry error contract', () => {
  it('names unknown output presets in the message', () => {
    expectGeometryMessage(
      () => initialComposition({ width: 640, height: 480 }, 'cinema'),
      'Unknown output preset: cinema',
    )
    expectGeometryMessage(
      () => changePreset(canvas(), '7:5', 'vertical', 0),
      'Unknown output preset: 7:5',
    )
  })

  it('names unknown stack directions in the message', () => {
    const diagonal = 'diagonal' as 'vertical'
    expectGeometryMessage(
      () => stackRegions(canvas(), diagonal, 0),
      'Unknown stack direction: diagonal',
    )
    expectGeometryMessage(
      () => maxStackGap(canvas(), diagonal),
      'Unknown stack direction: diagonal',
    )
    expectGeometryMessage(
      () => normalizeStackGap(canvas(), diagonal, 0),
      'Unknown stack direction: diagonal',
    )
    expectGeometryMessage(
      () => changePreset(canvas(), '1:1', diagonal, 0),
      'Unknown stack direction: diagonal',
    )
  })

  it('checks the stack direction before any other stack argument', () => {
    const diagonal = 'diagonal' as 'vertical'
    const message = 'Unknown stack direction: diagonal'
    expectGeometryMessage(
      () => maxStackGap(canvas({ width: 3 }), diagonal),
      message,
    )
    expectGeometryMessage(
      () => stackRegions(canvas({ width: 3 }), diagonal, 0),
      message,
    )
    expectGeometryMessage(
      () => normalizeStackGap(canvas(), diagonal, Number.NaN),
      message,
    )
  })

  it.each([
    ['maxStackGap', (value: Composition) => maxStackGap(value, 'vertical')],
    [
      'normalizeStackGap',
      (value: Composition) => normalizeStackGap(value, 'vertical', 0),
    ],
    [
      'stackRegions',
      (value: Composition) => stackRegions(value, 'vertical', 0),
    ],
    [
      'changePreset',
      (value: Composition) => changePreset(value, '1:1', 'vertical', 0),
    ],
    [
      'updateRegionCrop',
      (value: Composition) =>
        updateRegionCrop(value, 0, { x: 0, y: 0, width: 100, height: 100 }),
    ],
    ['moveRegion', (value: Composition) => moveRegion(value, 0, 0, 0)],
    ['scaleRegion', (value: Composition) => scaleRegion(value, 0, 0.5)],
    [
      'resizeRegion',
      (value: Composition) => resizeRegion(value, 0, 'se', 0, 0),
    ],
  ] as const)(
    '%s rejects a non-finite composition width before anything else',
    (_name, operation) => {
      expectGeometryMessage(
        () => operation(canvas({ width: Number.NaN })),
        'Composition width must be finite',
      )
      expectGeometryMessage(
        () => operation(canvas({ height: Number.POSITIVE_INFINITY })),
        'Composition height must be finite',
      )
    },
  )

  it.each([
    [0, 'x', 'Region 1 x must be finite'],
    [0, 'y', 'Region 1 y must be finite'],
    [0, 'scale', 'Region 1 scale must be finite'],
    [1, 'x', 'Region 2 x must be finite'],
    [1, 'y', 'Region 2 y must be finite'],
    [1, 'scale', 'Region 2 scale must be finite'],
  ] as const)(
    'names region %i field %s when it is not finite',
    (index, field, message) => {
      const patch = { [field]: Number.NaN }
      const value = index === 0 ? canvas({}, patch) : canvas({}, {}, patch)
      expectGeometryMessage(() => moveRegion(value, 0, 0, 0), message)
      expectGeometryMessage(() => maxStackGap(value, 'vertical'), message)
    },
  )

  it.each([
    [0, 'x', 'Region 1 crop x must be finite'],
    [0, 'y', 'Region 1 crop y must be finite'],
    [0, 'width', 'Region 1 crop width must be finite'],
    [0, 'height', 'Region 1 crop height must be finite'],
    [1, 'x', 'Region 2 crop x must be finite'],
    [1, 'y', 'Region 2 crop y must be finite'],
    [1, 'width', 'Region 2 crop width must be finite'],
    [1, 'height', 'Region 2 crop height must be finite'],
  ] as const)(
    'names region %i crop %s when it is not finite',
    (index, field, message) => {
      const value = withCrop(index, { [field]: Number.NEGATIVE_INFINITY })
      expectGeometryMessage(() => moveRegion(value, 0, 0, 0), message)
      expectGeometryMessage(() => maxStackGap(value, 'vertical'), message)
    },
  )

  it('names each non-finite scalar argument', () => {
    expectGeometryMessage(
      () => moveRegion(canvas(), 0, Number.NaN, 0),
      'Region x must be finite',
    )
    expectGeometryMessage(
      () => moveRegion(canvas(), 0, 0, Number.NaN),
      'Region y must be finite',
    )
    expectGeometryMessage(
      () => scaleRegion(canvas(), 0, Number.POSITIVE_INFINITY),
      'Region scale must be finite',
    )
    expectGeometryMessage(
      () => resizeRegion(canvas(), 0, 'se', Number.NaN, 0),
      'Resize x delta must be finite',
    )
    expectGeometryMessage(
      () => resizeRegion(canvas(), 0, 'se', 0, Number.NaN),
      'Resize y delta must be finite',
    )
    expectGeometryMessage(
      () => normalizeStackGap(canvas(), 'vertical', Number.NaN),
      'Stack gap must be finite',
    )
    expectGeometryMessage(
      () => stackRegions(canvas(), 'vertical', Number.POSITIVE_INFINITY),
      'Stack gap must be finite',
    )
    expectGeometryMessage(
      () => initialComposition({ width: Number.NaN, height: 480 }, '1:1'),
      'Video width must be finite',
    )
    expectGeometryMessage(
      () => initialComposition({ width: 640, height: Number.NaN }, '1:1'),
      'Video height must be finite',
    )
    expectGeometryMessage(
      () => initialComposition({ width: Number.NaN, height: 1 }, '1:1'),
      'Video width must be finite',
    )
  })

  it('checks composition finiteness before the preset and crop arguments', () => {
    expectGeometryMessage(
      () =>
        changePreset(
          canvas({}, { x: Number.NaN }),
          'cinema',
          'vertical',
          Number.NaN,
        ),
      'Region 1 x must be finite',
    )
    expectGeometryMessage(
      () =>
        updateRegionCrop(canvas({ width: Number.NaN }), 0, {
          x: 0,
          y: 0,
          width: Number.NaN,
          height: 2,
        }),
      'Composition width must be finite',
    )
    expectGeometryMessage(
      () =>
        stackRegions(canvas({ width: 3 }, { x: Number.NaN }), 'vertical', 0),
      'Region 1 x must be finite',
    )
    expectGeometryMessage(
      () => stackRegions(canvas({ width: 3 }), 'vertical', Number.NaN),
      DIMENSION_MESSAGE,
    )
  })

  it.each([
    ['x', { x: Number.NaN, y: 0, width: 2, height: 2 }],
    ['y', { x: 0, y: Number.POSITIVE_INFINITY, width: 2, height: 2 }],
    ['width', { x: 0, y: 0, width: Number.NaN, height: 2 }],
    ['height', { x: 0, y: 0, width: 2, height: Number.NEGATIVE_INFINITY }],
  ] as const)('rejects a non-finite crop %s', (_field, crop) => {
    expectGeometryMessage(
      () => updateRegionCrop(canvas(), 0, crop),
      'Crop geometry must be finite',
    )
  })

  it.each([
    ['odd x', { x: 2, y: 0, width: 100, height: 100 }, { x: 3 }],
    ['odd y', { x: 0, y: 0, width: 100, height: 100 }, { y: 5 }],
    ['odd width', { x: 0, y: 0, width: 100, height: 100 }, { width: 101 }],
    ['odd height', { x: 0, y: 0, width: 100, height: 100 }, { height: 99 }],
    ['fractional x', { x: 0, y: 0, width: 100, height: 100 }, { x: 2.5 }],
    [
      'fractional width',
      { x: 0, y: 0, width: 100, height: 100 },
      { width: 3.5 },
    ],
    ['negative x', { x: 0, y: 0, width: 100, height: 100 }, { x: -2 }],
    ['negative y', { x: 0, y: 0, width: 100, height: 100 }, { y: -2 }],
    ['zero width', { x: 0, y: 0, width: 100, height: 100 }, { width: 0 }],
    ['zero height', { x: 0, y: 0, width: 100, height: 100 }, { height: 0 }],
    ['negative width', { x: 0, y: 0, width: 100, height: 100 }, { width: -2 }],
    [
      'negative height',
      { x: 0, y: 0, width: 100, height: 100 },
      { height: -2 },
    ],
  ] as const)('rejects crop with %s', (_label, base, patch) => {
    expectGeometryMessage(
      () => updateRegionCrop(canvas(), 0, { ...base, ...patch }),
      CROP_MESSAGE,
    )
  })

  it.each([
    ['width 1', { width: 1, height: 100 }],
    ['height 1', { width: 100, height: 1 }],
    ['width 0', { width: 0, height: 100 }],
    ['height 0', { width: 100, height: 0 }],
    ['negative width', { width: -4, height: 100 }],
    ['negative height', { width: 100, height: -4 }],
    ['fractional width', { width: 640.5, height: 480 }],
    ['fractional height', { width: 640, height: 480.5 }],
  ])('rejects video dimensions with %s', (_label, dimensions) => {
    expectGeometryMessage(
      () => initialComposition(dimensions, '1:1'),
      VIDEO_MESSAGE,
    )
  })

  it.each([
    ['odd width', { width: 3 }],
    ['odd height', { height: 3 }],
    ['odd large height', { height: 601 }],
    ['fractional width', { width: 800.5 }],
    ['fractional height', { height: 600.5 }],
    ['zero width', { width: 0 }],
    ['zero height', { height: 0 }],
    ['width 1', { width: 1 }],
    ['height 1', { height: 1 }],
    ['negative width', { width: -2 }],
    ['negative height', { height: -2 }],
  ] as const)('rejects a stack canvas with %s', (_label, patch) => {
    expectGeometryMessage(
      () => maxStackGap(canvas(patch), 'vertical'),
      DIMENSION_MESSAGE,
    )
    expectGeometryMessage(
      () => stackRegions(canvas(patch), 'horizontal', 0),
      DIMENSION_MESSAGE,
    )
  })

  it.each([
    [0, 'zero width', { width: 0 }],
    [0, 'zero height', { height: 0 }],
    [0, 'odd width', { width: 401 }],
    [0, 'odd height', { height: 201 }],
    [0, 'fractional width', { width: 400.5 }],
    [0, 'fractional height', { height: 200.5 }],
    [0, 'negative width', { width: -2 }],
    [0, 'negative height', { height: -2 }],
    [1, 'zero width', { width: 0 }],
    [1, 'zero height', { height: 0 }],
    [1, 'odd width', { width: 401 }],
    [1, 'odd height', { height: 201 }],
  ] as const)(
    'rejects region %i crop with %s and names the region',
    (index, _label, patch) => {
      expectGeometryMessage(
        () => maxStackGap(withCrop(index, patch), 'vertical'),
        `Region ${index + 1} crop dimensions must be positive even integers of at least 2 pixels`,
      )
    },
  )

  it('names the stacking direction when the canvas is too small', () => {
    expectGeometryMessage(
      () => maxStackGap(canvas({ height: 2 }), 'vertical'),
      'Composition is too small to stack both regions vertically',
    )
    expectGeometryMessage(
      () => maxStackGap(canvas({ width: 2 }), 'horizontal'),
      'Composition is too small to stack both regions horizontally',
    )
    expectGeometryMessage(
      () => stackRegions(canvas({ height: 2 }), 'vertical', 0),
      'Composition is too small to stack both regions vertically',
    )
  })
})

describe('composition geometry exact boundaries', () => {
  it('accepts the smallest even canvas that still fits both minimum-scale regions', () => {
    expect(maxStackGap(canvas({ width: 2 }), 'vertical')).toBe(596)
    expect(maxStackGap(canvas({ height: 2 }), 'horizontal')).toBe(792)
    expect(maxStackGap(canvas({ height: 4 }), 'vertical')).toBe(0)
    const narrow = {
      crop: { x: 0, y: 0, width: 100, height: 200 },
    } as const
    expect(
      maxStackGap(canvas({ width: 4 }, narrow, narrow), 'horizontal'),
    ).toBe(0)
    expect(
      maxStackGap(canvas({ width: 6 }, narrow, narrow), 'horizontal'),
    ).toBe(2)
  })

  it('accepts two-pixel region crops', () => {
    const tiny = { crop: { x: 0, y: 0, width: 2, height: 2 } } as const
    expect(maxStackGap(canvas({}, tiny, tiny), 'vertical')).toBe(596)
    expect(maxStackGap(canvas({}, tiny, tiny), 'horizontal')).toBe(796)
  })

  it('accepts a two-pixel crop update and keeps placement', () => {
    expect(
      updateRegionCrop(canvas(), 0, { x: 0, y: 0, width: 2, height: 2 })
        .regions[0],
    ).toEqual({
      crop: { x: 0, y: 0, width: 2, height: 2 },
      x: 100,
      y: 100,
      scale: 0.5,
    })
  })

  it('accepts a two-pixel source video', () => {
    const result = initialComposition({ width: 2, height: 2 }, '1:1')
    expect(result.regions).toEqual([
      { crop: { x: 0, y: 0, width: 2, height: 2 }, x: 538, y: 538, scale: 1 },
      { crop: { x: 0, y: 0, width: 2, height: 2 }, x: 538, y: 540, scale: 1 },
    ])
  })

  it.each([
    [2, 2, 2, 0],
    [3, 3, 2, 0],
    [4, 4, 2, 2],
    [5, 5, 2, 2],
    [6, 6, 2, 4],
    [8, 8, 4, 4],
    [1082, 1082, 540, 542],
  ])(
    'splits a %ix%i source into %i-pixel-high crops starting at 0 and %i',
    (width, height, cropHeight, secondCropY) => {
      const result = initialComposition({ width, height }, '16:9')
      const evenWidth = Math.floor(width / 2) * 2
      expect(result.regions[0].crop).toEqual({
        x: 0,
        y: 0,
        width: evenWidth,
        height: cropHeight,
      })
      expect(result.regions[1].crop).toEqual({
        x: 0,
        y: secondCropY,
        width: evenWidth,
        height: cropHeight,
      })
    },
  )
})

describe('composition crop fitting', () => {
  it('shrinks the scale to the room left to the right edge', () => {
    const start = canvas({}, { x: 600, y: 100 })
    const result = updateRegionCrop(start, 0, {
      x: 0,
      y: 0,
      width: 800,
      height: 100,
    })
    expect(result.regions[0]).toEqual({
      crop: { x: 0, y: 0, width: 800, height: 100 },
      x: 600,
      y: 100,
      scale: 0.25,
    })
    expect(result.regions[1]).toEqual(start.regions[1])
  })

  it('shrinks the scale to the room left to the bottom edge', () => {
    const start = canvas({}, { x: 100, y: 500 })
    const result = updateRegionCrop(start, 0, {
      x: 0,
      y: 0,
      width: 100,
      height: 400,
    })
    expect(result.regions[0]).toEqual({
      crop: { x: 0, y: 0, width: 100, height: 400 },
      x: 100,
      y: 500,
      scale: 0.25,
    })
  })

  it('pulls an origin beyond the right edge back to width minus two', () => {
    const result = updateRegionCrop(canvas({}, { x: 1000, y: 100 }), 0, {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })
    expect(result.regions[0]).toEqual({
      crop: { x: 0, y: 0, width: 100, height: 100 },
      x: 798,
      y: 100,
      scale: 0.02,
    })
  })

  it('pulls an origin beyond the bottom edge back to height minus two', () => {
    const result = updateRegionCrop(canvas({}, { x: 100, y: 1000 }), 0, {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })
    expect(result.regions[0]).toEqual({
      crop: { x: 0, y: 0, width: 100, height: 100 },
      x: 100,
      y: 598,
      scale: 0.02,
    })
  })

  it('limits explicit scaling by the room to each edge independently', () => {
    expect(
      scaleRegion(canvas({}, { x: 600, y: 100 }), 0, 1).regions[0],
    ).toMatchObject({ x: 600, y: 100, scale: 0.5 })
    expect(
      scaleRegion(canvas({}, { x: 100, y: 500 }), 0, 1).regions[0],
    ).toMatchObject({ x: 100, y: 500, scale: 0.5 })
    expect(
      scaleRegion(canvas({}, { x: 200, y: 100 }), 0, 1).regions[0],
    ).toMatchObject({ x: 200, y: 100, scale: 1 })
  })
})

describe('composition corner resizing', () => {
  const unchangedSecond = canvas().regions[1]

  it.each([
    ['se', 50, 10, 100, 100, 0.625],
    ['se', 8, 50, 100, 100, 0.75],
    ['nw', -50, -10, 50, 76, 0.625],
    ['nw', -8, -50, 0, 50, 0.75],
    ['ne', 50, -10, 100, 76, 0.625],
    ['ne', 8, -50, 100, 50, 0.75],
    ['sw', -50, 10, 50, 100, 0.625],
    ['sw', -8, 50, 0, 100, 0.75],
    ['se', -50, -10, 100, 100, 0.375],
    ['nw', 50, 10, 150, 126, 0.375],
    ['ne', -50, 10, 100, 126, 0.375],
    ['sw', 50, -10, 150, 100, 0.375],
  ] as const)(
    'resizes from %s by (%f, %f) to x=%i y=%i scale=%f following the dominant delta',
    (corner: ResizeCorner, dx, dy, x, y, scale) => {
      const result = resizeRegion(canvas(), 0, corner, dx, dy)
      expect(result.regions[0]).toEqual({
        crop: firstRegion.crop,
        x,
        y,
        scale,
      })
      expect(result.regions[1]).toEqual(unchangedSecond)
      expect(result.width).toBe(800)
      expect(result.height).toBe(600)
    },
  )

  it.each([
    ['se', 50, -25, 100, 100, 0.625],
    ['nw', -50, 25, 50, 76, 0.625],
    ['ne', 50, 25, 100, 76, 0.625],
    ['sw', -50, -25, 50, 100, 0.625],
  ] as const)(
    'prefers the horizontal delta on a tie when resizing from %s',
    (corner: ResizeCorner, dx, dy, x, y, scale) => {
      expect(resizeRegion(canvas(), 0, corner, dx, dy).regions[0]).toEqual({
        crop: firstRegion.crop,
        x,
        y,
        scale,
      })
    },
  )

  it('resizes the second region and leaves the first untouched', () => {
    const result = resizeRegion(canvas(), 1, 'nw', -50, 0)
    expect(result.regions[0]).toEqual(firstRegion)
    expect(result.regions[1]).toEqual({
      crop: secondRegion.crop,
      x: 50,
      y: 376,
      scale: 0.625,
    })
  })

  it('clamps growth to the room between the anchor and the far canvas edge', () => {
    const start = canvas({}, { x: 600, y: 100 })
    const result = resizeRegion(start, 0, 'se', 400, 0)
    expect(result.regions[0]).toEqual({
      crop: firstRegion.crop,
      x: 600,
      y: 100,
      scale: 0.5,
    })
    const west = resizeRegion(canvas({}, { x: 0, y: 100 }), 0, 'nw', -400, 0)
    expect(west.regions[0].scale).toBe(0.5)
    expect(west.regions[0].x).toBe(0)
  })
})

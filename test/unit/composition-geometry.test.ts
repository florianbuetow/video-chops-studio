import { describe, expect, it } from 'vitest'

import type { Composition, VideoRegion } from '../../src/domain/video.js'
import { regionSize } from '../../src/domain/video.js'
import {
  changePreset,
  CompositionGeometryError,
  initialComposition,
  maxStackGap,
  moveRegion,
  normalizeStackGap,
  OUTPUT_PRESETS,
  resizeRegion,
  scaleRegion,
  stackRegions,
  updateRegionCrop,
} from '../../src/web/composition.js'

const expectedPresets = [
  ['9:16', 1080, 1920],
  ['16:9', 1920, 1080],
  ['1:1', 1080, 1080],
  ['3:2', 1620, 1080],
  ['2:3', 1080, 1620],
  ['4:3', 1440, 1080],
  ['3:4', 1080, 1440],
  ['4:5', 1080, 1350],
  ['5:4', 1350, 1080],
  ['21:9', 2520, 1080],
] as const

function composition(region?: Partial<VideoRegion>): Composition {
  const first = {
    crop: { x: 0, y: 0, width: 400, height: 200 },
    x: 100,
    y: 100,
    scale: 0.5,
    ...region,
  }
  return {
    width: 800,
    height: 600,
    background: '#000000',
    regions: [
      first,
      {
        crop: { x: 0, y: 200, width: 400, height: 200 },
        x: 100,
        y: 400,
        scale: 0.5,
      },
    ],
  }
}

function expectInsideCanvas(value: Composition): void {
  for (const region of value.regions) {
    const size = regionSize(region)
    expect(region.x % 2).toBe(0)
    expect(region.y % 2).toBe(0)
    expect(size.width % 2).toBe(0)
    expect(size.height % 2).toBe(0)
    expect(region.x).toBeGreaterThanOrEqual(0)
    expect(region.y).toBeGreaterThanOrEqual(0)
    expect(region.x + size.width).toBeLessThanOrEqual(value.width)
    expect(region.y + size.height).toBeLessThanOrEqual(value.height)
    expect(size.width).toBeLessThanOrEqual(region.crop.width)
    expect(size.height).toBeLessThanOrEqual(region.crop.height)
    expect(region.scale).toBeLessThanOrEqual(1)
  }
}

describe('composition presets and initial layout', () => {
  it('provides the exact common output dimensions', () => {
    expect(
      OUTPUT_PRESETS.map(({ id, width, height }) => [id, width, height]),
    ).toEqual(expectedPresets)
  })

  it('selects even top and bottom source crops and stacks them without upscaling', () => {
    const result = initialComposition({ width: 1920, height: 1082 }, '9:16')
    expect(result.background).toBe('#000000')
    expect(result.regions[0].crop).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 540,
    })
    expect(result.regions[1].crop).toEqual({
      x: 0,
      y: 542,
      width: 1920,
      height: 540,
    })
    expectInsideCanvas(result)
    const first = regionSize(result.regions[0])
    const second = regionSize(result.regions[1])
    expect(result.regions[0].y + first.height).toBeLessThanOrEqual(
      result.height / 2,
    )
    expect(result.regions[1].y).toBeGreaterThanOrEqual(result.height / 2)
    expect(result.regions[0].y + first.height).toBeLessThanOrEqual(
      result.regions[1].y,
    )
    expect(second.height).toBe(first.height)
  })

  it('uses the full source twice when it is too short to split', () => {
    const result = initialComposition({ width: 640, height: 2 }, '1:1')
    expect(result.regions[0].crop).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 2,
    })
    expect(result.regions[1].crop).toEqual(result.regions[0].crop)
  })

  it('resets custom placement when changing the output preset', () => {
    const original = composition({ x: 600, y: 500, scale: 0.1 })
    const changed = changePreset(original, '2:3', 'horizontal', 32)
    expect(changed).toEqual(
      stackRegions(
        { ...original, width: 1080, height: 1620 },
        'horizontal',
        32,
      ),
    )
    expect(original.regions[0]).toMatchObject({ x: 600, y: 500, scale: 0.1 })
    expectInsideCanvas(changed)
  })
})

describe('stacked composition layouts', () => {
  it('centers a vertical group with exact zero and non-zero gaps', () => {
    const zeroGap = stackRegions(composition(), 'vertical', 0)
    expect(zeroGap.regions).toMatchObject([
      { x: 200, y: 100, scale: 1 },
      { x: 200, y: 300, scale: 1 },
    ])

    const spaced = stackRegions(composition(), 'vertical', 40)
    expect(spaced.regions).toMatchObject([
      { x: 200, y: 80, scale: 1 },
      { x: 200, y: 320, scale: 1 },
    ])
    expect(spaced.regions[1].y).toBe(
      spaced.regions[0].y + regionSize(spaced.regions[0]).height + 40,
    )
  })

  it('centers a horizontal group in left-to-right order with an exact gap', () => {
    const result = stackRegions(composition(), 'horizontal', 40)
    expect(result.regions).toMatchObject([
      { x: 0, y: 204, scale: 0.95 },
      { x: 420, y: 204, scale: 0.95 },
    ])
    expect(result.regions[1].x).toBe(
      result.regions[0].x + regionSize(result.regions[0]).width + 40,
    )
  })

  it('uses one scale for unequal crops and aligns their cross-axis centers', () => {
    const original = composition({
      crop: { x: 0, y: 0, width: 600, height: 300 },
    })
    const result = stackRegions(original, 'vertical', 20)
    const firstSize = regionSize(result.regions[0])
    const secondSize = regionSize(result.regions[1])
    expect(result.regions[0].scale).toBe(1)
    expect(result.regions[1].scale).toBe(1)
    expect(result.regions[0].x + firstSize.width / 2).toBe(
      result.regions[1].x + secondSize.width / 2,
    )
    expect(result.regions[1].y).toBe(
      result.regions[0].y + firstSize.height + 20,
    )
  })

  it('never upscales small crops', () => {
    const result = stackRegions(
      composition({ crop: { x: 0, y: 0, width: 40, height: 20 } }),
      'vertical',
      0,
    )
    expect(result.regions[0].scale).toBe(1)
    expect(result.regions[1].scale).toBe(1)
  })

  it('normalizes gaps to even canvas-bounded values', () => {
    const original = composition()
    expect(normalizeStackGap(original, 'vertical', -20)).toBe(0)
    expect(normalizeStackGap(original, 'vertical', 41)).toBe(40)
    expect(maxStackGap(original, 'vertical')).toBe(596)
    expect(maxStackGap(original, 'horizontal')).toBe(792)
    expect(normalizeStackGap(original, 'vertical', 100_000)).toBe(596)

    const packed = stackRegions(original, 'vertical', 100_000)
    expect(regionSize(packed.regions[0]).height).toBe(2)
    expect(regionSize(packed.regions[1]).height).toBe(2)
    expect(packed.regions[1].y).toBe(
      packed.regions[0].y + regionSize(packed.regions[0]).height + 596,
    )
    expectInsideCanvas(packed)
  })

  it('preserves background image and frame settings without mutating input', () => {
    const original: Composition = {
      ...composition(),
      background: '#123456',
      backgroundImage: 'paper.jpg',
      frame: { target: 'regions', color: '#abcdef', width: 6 },
    }
    const before = structuredClone(original)
    const result = stackRegions(original, 'horizontal', 24)
    expect(result).toMatchObject({
      background: '#123456',
      backgroundImage: 'paper.jpg',
      frame: { target: 'regions', color: '#abcdef', width: 6 },
    })
    expect(original).toEqual(before)
  })

  it('keeps direction, gap, background, and frame when changing ratios', () => {
    const original: Composition = {
      ...composition(),
      background: '#123456',
      backgroundImage: 'paper.jpg',
      frame: { target: 'canvas', color: '#abcdef', width: 4 },
    }
    const result = changePreset(original, '9:16', 'horizontal', 50)
    const firstSize = regionSize(result.regions[0])
    expect(result).toMatchObject({
      width: 1080,
      height: 1920,
      background: '#123456',
      backgroundImage: 'paper.jpg',
      frame: { target: 'canvas', color: '#abcdef', width: 4 },
    })
    expect(result.regions[1].x).toBe(result.regions[0].x + firstSize.width + 50)
  })

  it.each([
    () => normalizeStackGap(composition(), 'vertical', Number.NaN),
    () => stackRegions(composition(), 'diagonal' as 'vertical', 0),
    () => maxStackGap({ ...composition(), width: 3 }, 'vertical'),
    () =>
      maxStackGap(
        composition({ crop: { x: 0, y: 0, width: 0, height: 200 } }),
        'vertical',
      ),
    () => maxStackGap({ ...composition(), height: 2 }, 'vertical'),
  ])('fails fast for invalid stack geometry', (operation) => {
    expect(operation).toThrow(CompositionGeometryError)
  })
})

describe('composition region geometry', () => {
  it('moves on even pixels and clamps the rendered region to the canvas', () => {
    expect(moveRegion(composition(), 0, 777, -19).regions[0]).toMatchObject({
      x: 600,
      y: 0,
    })
  })

  it('preserves crop placement and scale when the new crop fits', () => {
    const original = composition()
    const next = updateRegionCrop(original, 0, {
      x: 20,
      y: 40,
      width: 300,
      height: 100,
    })
    expect(next.regions[0]).toEqual({
      crop: { x: 20, y: 40, width: 300, height: 100 },
      x: 100,
      y: 100,
      scale: 0.5,
    })
    expect(original.regions[0].crop).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 200,
    })
  })

  it('limits scaling at the current origin and never upscales', () => {
    const atEdge = composition({ x: 600, y: 500 })
    const enlarged = scaleRegion(atEdge, 0, 20)
    expect(enlarged.regions[0]).toMatchObject({ x: 600, y: 500, scale: 0.5 })
    expect(scaleRegion(composition(), 0, -5).regions[0].scale).toBe(0.01)
    expectInsideCanvas(enlarged)
  })

  it.each([
    ['nw', -40, -20],
    ['ne', 40, -20],
    ['sw', -40, 20],
    ['se', 40, 20],
  ] as const)(
    'resizes from %s while preserving the opposite corner',
    (corner, dx, dy) => {
      const original = composition()
      const before = original.regions[0]
      const beforeSize = regionSize(before)
      const after = resizeRegion(original, 0, corner, dx, dy).regions[0]
      const afterSize = regionSize(after)
      const west = corner === 'nw' || corner === 'sw'
      const north = corner === 'nw' || corner === 'ne'
      expect(west ? after.x + afterSize.width : after.x).toBe(
        west ? before.x + beforeSize.width : before.x,
      )
      expect(north ? after.y + afterSize.height : after.y).toBe(
        north ? before.y + beforeSize.height : before.y,
      )
      expect(afterSize.width / afterSize.height).toBe(
        before.crop.width / before.crop.height,
      )
      expect(after.scale).toBeLessThanOrEqual(1)
    },
  )

  it('keeps an already rounded region unchanged for a zero-delta resize', () => {
    const original = composition({ scale: 0.337 })
    expect(resizeRegion(original, 0, 'se', 0, 0)).toEqual(original)
  })

  it('rounds rendered dimensions down to even pixels', () => {
    const result = scaleRegion(composition(), 0, 0.337)
    expect(regionSize(result.regions[0])).toEqual({ width: 134, height: 66 })
  })

  it.each([
    () => initialComposition({ width: 640, height: 480 }, 'cinema'),
    () => initialComposition({ width: Number.NaN, height: 480 }, '1:1'),
    () => moveRegion(composition(), 0, Number.POSITIVE_INFINITY, 0),
    () => scaleRegion(composition(), 0, Number.NaN),
    () => resizeRegion(composition(), 0, 'se', 0, Number.NaN),
    () =>
      updateRegionCrop(composition(), 0, {
        x: 0,
        y: 0,
        width: Number.NaN,
        height: 20,
      }),
  ])('fails fast for unknown presets or non-finite geometry', (operation) => {
    expect(operation).toThrow(CompositionGeometryError)
  })
})

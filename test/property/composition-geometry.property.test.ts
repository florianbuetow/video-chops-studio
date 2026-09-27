import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { Composition } from '../../src/domain/video.js'
import { regionSize } from '../../src/domain/video.js'
import {
  initialComposition,
  maxStackGap,
  moveRegion,
  normalizeStackGap,
  OUTPUT_PRESETS,
  resizeRegion,
  scaleRegion,
  stackRegions,
  type StackDirection,
} from '../../src/web/composition.js'

function expectBoundedEvenRegions(composition: Composition): void {
  for (const region of composition.regions) {
    const size = regionSize(region)
    expect(region.x).toBeGreaterThanOrEqual(0)
    expect(region.y).toBeGreaterThanOrEqual(0)
    expect(region.x % 2).toBe(0)
    expect(region.y % 2).toBe(0)
    expect(size.width % 2).toBe(0)
    expect(size.height % 2).toBe(0)
    expect(region.x + size.width).toBeLessThanOrEqual(composition.width)
    expect(region.y + size.height).toBeLessThanOrEqual(composition.height)
    expect(size.width).toBeLessThanOrEqual(region.crop.width)
    expect(size.height).toBeLessThanOrEqual(region.crop.height)
    expect(region.scale).toBeGreaterThan(0)
    expect(region.scale).toBeLessThanOrEqual(1)
  }
}

describe('composition geometry properties', () => {
  it('keeps generated layouts even, bounded, and at or below native size', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2048 }),
        fc.integer({ min: 1, max: 2048 }),
        fc.integer({ min: 0, max: OUTPUT_PRESETS.length - 1 }),
        fc.integer({ min: -8000, max: 8000 }),
        fc.integer({ min: -8000, max: 8000 }),
        fc.double({ min: -2, max: 3, noNaN: true, noDefaultInfinity: true }),
        fc.constantFrom('nw', 'ne', 'sw', 'se'),
        fc.integer({ min: -8000, max: 8000 }),
        fc.integer({ min: -8000, max: 8000 }),
        (widthHalf, heightHalf, presetIndex, x, y, scale, corner, dx, dy) => {
          const selectedPreset = OUTPUT_PRESETS[presetIndex]
          if (selectedPreset === undefined)
            throw new Error('Generated preset is missing')
          const initial = initialComposition(
            { width: widthHalf * 2, height: heightHalf * 2 },
            selectedPreset.id,
          )
          const moved = moveRegion(initial, 0, x, y)
          const scaled = scaleRegion(moved, 0, scale)
          const resized = resizeRegion(scaled, 0, corner, dx, dy)
          expectBoundedEvenRegions(initial)
          expectBoundedEvenRegions(moved)
          expectBoundedEvenRegions(scaled)
          expectBoundedEvenRegions(resized)
        },
      ),
    )
  })

  it('packs either orientation with the normalized exact gap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2048 }),
        fc.integer({ min: 1, max: 2048 }),
        fc.integer({ min: 1, max: 2048 }),
        fc.integer({ min: 1, max: 2048 }),
        fc.integer({ min: 1, max: 2048 }),
        fc.integer({ min: 1, max: 2048 }),
        fc.constantFrom<StackDirection>('vertical', 'horizontal'),
        fc.integer({ min: -10_000, max: 10_000 }),
        (
          canvasWidthHalf,
          canvasHeightHalf,
          firstWidthHalf,
          firstHeightHalf,
          secondWidthHalf,
          secondHeightHalf,
          direction,
          gap,
        ) => {
          const original: Composition = {
            width: canvasWidthHalf * 2,
            height: canvasHeightHalf * 2,
            background: '#123456',
            backgroundImage: 'backdrop.png',
            frame: { target: 'regions', color: '#abcdef', width: 3 },
            regions: [
              {
                crop: {
                  x: 0,
                  y: 0,
                  width: firstWidthHalf * 2,
                  height: firstHeightHalf * 2,
                },
                x: 0,
                y: 0,
                scale: 0.5,
              },
              {
                crop: {
                  x: 0,
                  y: 0,
                  width: secondWidthHalf * 2,
                  height: secondHeightHalf * 2,
                },
                x: 0,
                y: 0,
                scale: 0.5,
              },
            ],
          }
          const before = structuredClone(original)
          let maximumGap: number
          try {
            maximumGap = maxStackGap(original, direction)
          } catch {
            return
          }
          const normalizedGap = normalizeStackGap(original, direction, gap)
          const result = stackRegions(original, direction, gap)
          const firstSize = regionSize(result.regions[0])
          const secondSize = regionSize(result.regions[1])
          const vertical = direction === 'vertical'
          const firstStart = vertical
            ? result.regions[0].y
            : result.regions[0].x
          const secondStart = vertical
            ? result.regions[1].y
            : result.regions[1].x
          const firstPrimary = vertical ? firstSize.height : firstSize.width
          const firstCrossCenter = vertical
            ? result.regions[0].x + firstSize.width / 2
            : result.regions[0].y + firstSize.height / 2
          const secondCrossCenter = vertical
            ? result.regions[1].x + secondSize.width / 2
            : result.regions[1].y + secondSize.height / 2

          expect(normalizedGap).toBeGreaterThanOrEqual(0)
          expect(normalizedGap).toBeLessThanOrEqual(maximumGap)
          expect(normalizedGap % 2).toBe(0)
          expect(secondStart).toBe(firstStart + firstPrimary + normalizedGap)
          expect(
            Math.abs(firstCrossCenter - secondCrossCenter),
          ).toBeLessThanOrEqual(2)
          expect(result.regions[0].scale).toBe(result.regions[1].scale)
          expectBoundedEvenRegions(result)
          expect(result).toMatchObject({
            background: '#123456',
            backgroundImage: 'backdrop.png',
            frame: { target: 'regions', color: '#abcdef', width: 3 },
          })
          expect(original).toEqual(before)
        },
      ),
    )
  })
})

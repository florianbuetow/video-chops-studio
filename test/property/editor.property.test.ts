import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  aspectCrop,
  fitCrop,
  splitClip,
  totalDuration,
} from '../../src/web/editor.js'

describe('editor properties', () => {
  it('splitting a clip preserves total duration and sorted order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 10, max: 10_000 }),
        fc.integer({ min: 5, max: 9_995 }),
        (startTicks, lengthTicks, offsetTicks) => {
          const boundedOffset = Math.min(offsetTicks, lengthTicks - 5)
          fc.pre(boundedOffset >= 5)
          const start = startTicks / 100
          const end = (startTicks + lengthTicks) / 100
          const time = (startTicks + boundedOffset) / 100
          const original = [{ start, end }]
          const result = splitClip(original, time)
          expect(result).toHaveLength(2)
          expect(result[0]?.start).toBe(start)
          expect(result[0]?.end).toBe(time)
          expect(result[1]?.start).toBe(time)
          expect(result[1]?.end).toBe(end)
          expect(totalDuration(result)).toBeCloseTo(totalDuration(original), 10)
        },
      ),
    )
  })

  it('fitCrop always returns an even crop within an even frame', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4096 }),
        fc.integer({ min: 2, max: 4096 }),
        fc.record({
          x: fc.integer({ min: -8192, max: 8192 }),
          y: fc.integer({ min: -8192, max: 8192 }),
          width: fc.integer({ min: -8192, max: 8192 }),
          height: fc.integer({ min: -8192, max: 8192 }),
        }),
        (rawWidth, rawHeight, crop) => {
          const metadata = {
            width: rawWidth + (rawWidth % 2),
            height: rawHeight + (rawHeight % 2),
          }
          const fitted = fitCrop(crop, metadata)
          expect(fitted.x).toBeGreaterThanOrEqual(0)
          expect(fitted.y).toBeGreaterThanOrEqual(0)
          expect(fitted.width).toBeGreaterThanOrEqual(2)
          expect(fitted.height).toBeGreaterThanOrEqual(2)
          expect(fitted.x % 2).toBe(0)
          expect(fitted.y % 2).toBe(0)
          expect(fitted.width % 2).toBe(0)
          expect(fitted.height % 2).toBe(0)
          expect(fitted.x + fitted.width).toBeLessThanOrEqual(metadata.width)
          expect(fitted.y + fitted.height).toBeLessThanOrEqual(metadata.height)
        },
      ),
    )
  })

  it('aspectCrop stays centered, even, and inside the frame', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4096 }),
        fc.integer({ min: 2, max: 4096 }),
        fc.double({ min: 0.1, max: 10, noNaN: true }),
        (rawWidth, rawHeight, ratio) => {
          const metadata = {
            width: rawWidth + (rawWidth % 2),
            height: rawHeight + (rawHeight % 2),
          }
          const crop = aspectCrop(metadata, ratio)
          expect(crop.width).toBeGreaterThanOrEqual(2)
          expect(crop.height).toBeGreaterThanOrEqual(2)
          expect(crop.x % 2).toBe(0)
          expect(crop.y % 2).toBe(0)
          expect(crop.width % 2).toBe(0)
          expect(crop.height % 2).toBe(0)
          expect(crop.x + crop.width).toBeLessThanOrEqual(metadata.width)
          expect(crop.y + crop.height).toBeLessThanOrEqual(metadata.height)
          expect(
            Math.abs((metadata.width - crop.width) / 2 - crop.x),
          ).toBeLessThan(2)
          expect(
            Math.abs((metadata.height - crop.height) / 2 - crop.y),
          ).toBeLessThan(2)
        },
      ),
    )
  })
})

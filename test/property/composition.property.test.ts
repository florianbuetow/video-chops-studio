import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { regionSize } from '../../src/domain/video.js'

describe('composition properties', () => {
  it('always produces even region sizes within the selected source crop', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2048 }),
        fc.integer({ min: 1, max: 2048 }),
        fc.double({ min: 0.000_001, max: 1, noNaN: true }),
        (halfWidth, halfHeight, scale) => {
          const crop = {
            x: 0,
            y: 0,
            width: halfWidth * 2,
            height: halfHeight * 2,
          }
          const size = regionSize({ crop, x: 0, y: 0, scale })
          expect(size.width).toBeGreaterThanOrEqual(2)
          expect(size.height).toBeGreaterThanOrEqual(2)
          expect(size.width).toBeLessThanOrEqual(crop.width)
          expect(size.height).toBeLessThanOrEqual(crop.height)
          expect(size.width % 2).toBe(0)
          expect(size.height % 2).toBe(0)
        },
      ),
    )
  })
})

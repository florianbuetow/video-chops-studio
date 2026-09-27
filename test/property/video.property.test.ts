import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  editDuration,
  validateEdit,
  type VideoMetadata,
} from '../../src/domain/video.js'

const metadata: VideoMetadata = {
  name: 'input.mp4',
  size: 1,
  width: 640,
  height: 480,
  duration: 1000,
  fps: 30,
  hasAudio: true,
}

describe('video edit properties', () => {
  it('duration equals the sum of every retained interval', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 5, max: 100 }), {
          minLength: 1,
          maxLength: 128,
        }),
        (lengths) => {
          let cursor = 0
          const segments = lengths.map((length) => {
            const segment = {
              start: cursor / 100,
              end: (cursor + length) / 100,
            }
            cursor += length + 1
            return segment
          })
          const expected = lengths.reduce(
            (sum, length) => sum + length / 100,
            0,
          )
          expect(editDuration(segments)).toBeCloseTo(expected, 10)
        },
      ),
    )
  })

  it('accepts sorted non-overlapping segments generated within the video', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 5, max: 50 }), {
          minLength: 1,
          maxLength: 50,
        }),
        (lengths) => {
          let cursor = 0
          const segments = lengths.map((length) => {
            const segment = { start: cursor / 10, end: (cursor + length) / 10 }
            cursor += length + 2
            return segment
          })
          const result = validateEdit(
            {
              source: 'input.mp4',
              segments,
              crop: { x: 0, y: 0, width: 640, height: 480 },
              outputName: 'result.mp4',
              muted: false,
            },
            metadata,
          )
          expect(result.segments).toEqual(segments)
        },
      ),
    )
  })
})

import { describe, expect, it } from 'vitest'

import {
  EditError,
  fitCrop,
  MIN_CLIP,
  nextKeptTime,
  splitClip,
  trimClip,
} from '../../src/web/editor.js'

const minimum = MIN_CLIP - 1e-9

function editError(operation: () => unknown): EditError {
  try {
    operation()
  } catch (error) {
    if (error instanceof EditError) return error
    throw error
  }
  throw new Error('Expected the operation to throw EditError')
}

describe('editor error contract', () => {
  it('names split failures precisely', () => {
    const error = editError(() => splitClip([{ start: 0, end: 2 }], 5))
    expect(error.name).toBe('EditError')
    expect(error.message).toBe('Move the playhead inside a clip to split it.')
  })

  it('names an unselected clip precisely', () => {
    const error = editError(() => trimClip([{ start: 0, end: 2 }], 1, 0, 1, 2))
    expect(error.name).toBe('EditError')
    expect(error.message).toBe('Select a clip first.')
  })

  it('names the allowed trim range in minutes and seconds', () => {
    const segments = [
      { start: 0, end: 2 },
      { start: 3, end: 6 },
      { start: 8, end: 70.5 },
    ]
    expect(editError(() => trimClip(segments, 1, 1.5, 5, 100)).message).toBe(
      'Keep this clip between 00:02.00 and 00:08.00, at least 0.05 seconds long.',
    )
    expect(editError(() => trimClip(segments, 2, 5, 70.5, 100)).message).toBe(
      'Keep this clip between 00:06.00 and 01:40.00, at least 0.05 seconds long.',
    )
    expect(editError(() => trimClip(segments, 0, 0, 0.01, 100)).message).toBe(
      'Keep this clip between 00:00.00 and 00:03.00, at least 0.05 seconds long.',
    )
  })
})

describe('split and trim boundaries', () => {
  it('splits exactly at the minimum distance from the clip start', () => {
    expect(splitClip([{ start: 0, end: 1 }], minimum)).toEqual([
      { start: 0, end: minimum },
      { start: minimum, end: 1 },
    ])
  })

  it('splits exactly at the minimum distance from the clip end', () => {
    const time = 0.1 - minimum
    expect(0.1 - time).toBe(minimum)
    expect(splitClip([{ start: 0, end: 0.1 }], time)).toEqual([
      { start: 0, end: time },
      { start: time, end: 0.1 },
    ])
  })

  it('rejects splits just inside the minimum distance from either clip edge', () => {
    expect(() => splitClip([{ start: 0, end: 1 }], 0.049)).toThrow(EditError)
    expect(() => splitClip([{ start: 0, end: 1 }], 0.951)).toThrow(EditError)
  })

  it('keeps the segments before and after the split clip', () => {
    expect(
      splitClip(
        [
          { start: 0, end: 1 },
          { start: 2, end: 4 },
          { start: 5, end: 6 },
        ],
        3,
      ),
    ).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
      { start: 5, end: 6 },
    ])
  })

  it('accepts a trim of exactly the minimum length', () => {
    expect(trimClip([{ start: 0, end: 1 }], 0, 0, minimum, 1)).toEqual([
      { start: 0, end: minimum },
    ])
  })

  it('accepts trims that touch both neighbours exactly', () => {
    const source = [
      { start: 0, end: 2 },
      { start: 3, end: 6 },
      { start: 8, end: 10 },
    ]
    expect(trimClip(source, 1, 2, 8, 10)).toEqual([
      source[0],
      { start: 2, end: 8 },
      source[2],
    ])
    expect(trimClip(source, 2, 6, 10, 10)).toEqual([
      source[0],
      source[1],
      { start: 6, end: 10 },
    ])
  })
})

describe('crop fitting with aspect ratios', () => {
  const frame = { width: 640, height: 480 }

  it.each([undefined, null])(
    'never rescales the crop when the ratio is %s',
    (ratio) => {
      expect(
        fitCrop({ x: 0, y: 0, width: 853.333, height: 480 }, frame, ratio),
      ).toEqual({ x: 0, y: 0, width: 640, height: 480 })
    },
  )

  it('never rescales a crop when no ratio argument is given', () => {
    expect(fitCrop({ x: 0, y: 0, width: 853.333, height: 480 }, frame)).toEqual(
      { x: 0, y: 0, width: 640, height: 480 },
    )
  })

  it('scales a too-tall crop down uniformly to the frame height', () => {
    expect(fitCrop({ x: 0, y: 0, width: 100, height: 600 }, frame, 1)).toEqual({
      x: 0,
      y: 0,
      width: 80,
      height: 480,
    })
  })

  it('scales a too-wide crop down uniformly to the frame width', () => {
    expect(fitCrop({ x: 0, y: 0, width: 800, height: 100 }, frame, 8)).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 80,
    })
  })

  it('leaves a crop that already fits unscaled when a ratio is given', () => {
    expect(
      fitCrop({ x: 10, y: 20, width: 200, height: 100 }, frame, 2),
    ).toEqual({ x: 10, y: 20, width: 200, height: 100 })
  })
})

describe('next retained time boundaries', () => {
  const segments = [
    { start: 1, end: 2 },
    { start: 4, end: 6 },
  ]

  it('skips a position exactly at the last playable tail of a clip', () => {
    expect(nextKeptTime(segments, 2 - 0.015)).toBe(4)
    expect(nextKeptTime(segments, 2 - 0.016)).toBe(2 - 0.016)
  })

  it('skips a clip that is shorter than the tail even at its start', () => {
    expect(
      nextKeptTime(
        [
          { start: 1, end: 1.01 },
          { start: 4, end: 6 },
        ],
        1,
      ),
    ).toBe(4)
  })
})

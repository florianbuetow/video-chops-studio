import { describe, expect, it } from 'vitest'

import {
  aspectCrop,
  EditError,
  even,
  fitCrop,
  formatTime,
  fullCrop,
  nextKeptTime,
  outputTime,
  splitClip,
  totalDuration,
  trimClip,
} from '../../src/web/editor.js'

describe('timeline editing', () => {
  const segments = [
    { start: 0, end: 2 },
    { start: 4, end: 8 },
  ]

  it.each([
    [0, 0],
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 2],
    [6, 3],
    [7, 4],
    [10, 4],
  ])('maps source time %s to edited time %s', (source, edited) => {
    expect(
      outputTime(
        [
          { start: 1, end: 3 },
          { start: 5, end: 7 },
        ],
        source,
      ),
    ).toBe(edited)
  })

  it('splits the containing clip without changing duration or order', () => {
    const split = splitClip(segments, 5.5)
    expect(split).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 5.5 },
      { start: 5.5, end: 8 },
    ])
    expect(totalDuration(split)).toBe(totalDuration(segments))
    expect(segments).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 8 },
    ])
  })

  it.each([3, 4.049, 7.951, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a split outside the interior clip boundary at %s',
    (time) => {
      expect(() => splitClip(segments, time)).toThrow(EditError)
    },
  )

  it('trims within adjacent clips while preserving other entries', () => {
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
    expect(source[1]).toEqual({ start: 3, end: 6 })
  })

  it.each([
    [1, 1.99, 5],
    [1, 3, 8.01],
    [1, Number.NaN, 5],
    [1, 3, Number.POSITIVE_INFINITY],
    [1, 4, 4.049],
    [9, 0, 1],
  ])(
    'rejects overlapping, invalid, too-short, or unselected trims',
    (index, start, end) => {
      const source = [
        { start: 0, end: 2 },
        { start: 3, end: 6 },
        { start: 8, end: 10 },
      ]
      expect(() => trimClip(source, index, start, end, 10)).toThrow(EditError)
      expect(source).toHaveLength(3)
    },
  )

  it('does not silently remove the last clip when a trim collapses it', () => {
    const only = [{ start: 0, end: 1 }]
    expect(() => trimClip(only, 0, 0.5, 0.5, 1)).toThrow(
      'at least 0.05 seconds long',
    )
    expect(only).toEqual([{ start: 0, end: 1 }])
  })

  it('accepts a clip exactly 0.05 seconds long despite decimal rounding', () => {
    expect(trimClip([{ start: 0, end: 1 }], 0, 0.1, 0.15, 1)).toEqual([
      { start: 0.1, end: 0.15 },
    ])
  })
})

describe('crop geometry', () => {
  it('rounds full-frame and arbitrary crops to fitted even pixel coordinates', () => {
    expect(fullCrop({ width: 641, height: 481 })).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    })
    expect(
      fitCrop(
        { x: 639, y: -3, width: 999, height: 1 },
        { width: 641, height: 481 },
      ),
    ).toEqual({ x: 0, y: 0, width: 640, height: 2 })
    expect(even(17.9)).toBe(16)
  })

  it('uniformly shrinks an overflowing aspect-locked crop to fit the frame', () => {
    expect(
      fitCrop(
        { x: 0, y: 0, width: 853.333, height: 480 },
        { width: 640, height: 480 },
        16 / 9,
      ),
    ).toEqual({ x: 0, y: 0, width: 640, height: 360 })
  })

  it.each([
    [16 / 9, 640, 360],
    [9 / 16, 270, 480],
    [1, 480, 480],
    [4 / 5, 384, 480],
  ])('centers a %s aspect crop inside the frame', (ratio, width, height) => {
    const crop = aspectCrop({ width: 640, height: 480 }, ratio)
    expect(crop.width).toBe(width)
    expect(crop.height).toBe(height)
    expect(crop.x % 2).toBe(0)
    expect(crop.y % 2).toBe(0)
    expect(crop.x + crop.width).toBeLessThanOrEqual(640)
    expect(crop.y + crop.height).toBeLessThanOrEqual(480)
  })
})

describe('preview navigation', () => {
  const segments = [
    { start: 1, end: 2 },
    { start: 4, end: 6 },
  ]

  it.each([
    [0, 1],
    [1, 1],
    [1.5, 1.5],
    [1.99, 4],
    [3, 4],
    [5, 5],
    [5.99, null],
    [6, null],
    [20, null],
  ])('maps %s to the next retained time %s', (time, expected) => {
    expect(nextKeptTime(segments, time)).toBe(expected)
  })

  it('returns null when every clip has been removed', () => {
    expect(nextKeptTime([], 0)).toBeNull()
    expect(totalDuration([])).toBe(0)
  })
})

describe('formatTime', () => {
  it.each([
    [-1, '00:00.00'],
    [0, '00:00.00'],
    [1.25, '00:01.25'],
    [59.99, '00:59.99'],
    [60, '01:00.00'],
    [61.2, '01:01.20'],
    [3600, '60:00.00'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatTime(seconds)).toBe(expected)
  })

  it('carries rounded seconds into the next minute', () => {
    expect(formatTime(59.999)).toBe('01:00.00')
  })
})

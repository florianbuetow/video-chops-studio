import { describe, expect, it } from 'vitest'

import {
  InvalidNumberLineError,
  parseNumbers,
} from '../../src/application/parse-numbers.js'
import { parseArguments, UsageError } from '../../src/cli/arguments.js'
import {
  EmptySampleError,
  NonFiniteSampleError,
  summarize,
} from '../../src/domain/statistics.js'

function caught(operation: () => unknown): unknown {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error('Expected the operation to throw')
}

describe('typed error identity', () => {
  it('names the empty sample error', () => {
    const error = caught(() => summarize([]))
    expect(error).toBeInstanceOf(EmptySampleError)
    expect(error).toBeInstanceOf(Error)
    expect((error as EmptySampleError).name).toBe('EmptySampleError')
    expect((error as EmptySampleError).message).toBe(
      'cannot summarize an empty sample',
    )
  })

  it('names the non-finite sample error and reports the first offending index', () => {
    const error = caught(() =>
      summarize([1, 2, Number.NaN, Number.POSITIVE_INFINITY]),
    )
    expect(error).toBeInstanceOf(NonFiniteSampleError)
    expect((error as NonFiniteSampleError).name).toBe('NonFiniteSampleError')
    expect((error as NonFiniteSampleError).index).toBe(2)
    expect((error as NonFiniteSampleError).message).toBe(
      'sample value at index 2 is not a finite number',
    )
  })

  it('names the invalid number line error and exposes the trimmed line text', () => {
    const error = caught(() => parseNumbers('1\n\n  oops  \n3'))
    expect(error).toBeInstanceOf(InvalidNumberLineError)
    expect((error as InvalidNumberLineError).name).toBe(
      'InvalidNumberLineError',
    )
    expect((error as InvalidNumberLineError).line).toBe(3)
    expect((error as InvalidNumberLineError).text).toBe('oops')
    expect((error as InvalidNumberLineError).message).toBe(
      'line 3 is not a number: "oops"',
    )
  })

  it('names the usage error', () => {
    const error = caught(() => parseArguments([]))
    expect(error).toBeInstanceOf(UsageError)
    expect((error as UsageError).name).toBe('UsageError')
    expect((error as UsageError).message).toBe('missing command')
  })
})

describe('summary arithmetic', () => {
  it('tracks the minimum, maximum, and mean of an unordered sample exactly', () => {
    expect(summarize([4, -2, 9, 1.5])).toEqual({
      count: 4,
      min: -2,
      max: 9,
      mean: 3.125,
    })
  })

  it('does not treat the first value specially for minimum and maximum', () => {
    expect(summarize([-7, -3])).toEqual({
      count: 2,
      min: -7,
      max: -3,
      mean: -5,
    })
    expect(summarize([3, 7])).toEqual({ count: 2, min: 3, max: 7, mean: 5 })
  })
})

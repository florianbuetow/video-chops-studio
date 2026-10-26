import { describe, expect, it } from 'vitest'

import { parseArguments, UsageError } from '../../src/cli/arguments.js'

const PORT_MESSAGE = '--port must be an integer from 1 to 65535'

function studio(...options: readonly string[]): readonly string[] {
  return ['studio', ...options]
}

function usageMessage(argv: readonly string[]): string {
  try {
    parseArguments(argv)
  } catch (error) {
    if (error instanceof UsageError) return error.message
    throw error
  }
  throw new Error('Expected parseArguments to throw UsageError')
}

describe('studio option values', () => {
  it.each([' ', '   ', '\t', ' \n '])(
    'treats the whitespace-only value %j as missing',
    (value) => {
      expect(usageMessage(studio('--input', value))).toBe(
        'missing value for --input',
      )
      expect(usageMessage(studio('--output', value))).toBe(
        'missing value for --output',
      )
    },
  )

  it('treats a value that looks like another flag as missing', () => {
    expect(usageMessage(studio('--input', '--output', 'out'))).toBe(
      'missing value for --input',
    )
    expect(usageMessage(studio('--port', '--input', 'in'))).toBe(
      'missing value for --port',
    )
  })

  it('keeps a value with surrounding whitespace untouched', () => {
    expect(
      parseArguments(
        studio('--input', ' in ', '--output', 'out', '--port', '80'),
      ),
    ).toEqual({
      kind: 'studio',
      inputDirectory: ' in ',
      outputDirectory: 'out',
      port: 80,
    })
  })
})

describe('studio port syntax', () => {
  it.each([
    ' 80',
    '80 ',
    '0x50',
    '1e3',
    '+80',
    '8_0',
    '80.0',
    '-80',
    'x80',
    '80x',
    '0b101',
  ])(
    'rejects the port text %j even though it would coerce to a number',
    (port) => {
      expect(
        usageMessage(
          studio('--input', 'in', '--output', 'out', '--port', port),
        ),
      ).toBe(PORT_MESSAGE)
    },
  )

  it.each([
    ['080', 80],
    ['0000000001', 1],
    ['4310', 4310],
    ['65535', 65535],
  ])('accepts the decimal digits %s as port %i', (port, expected) => {
    expect(
      parseArguments(
        studio('--input', 'in', '--output', 'out', '--port', port),
      ),
    ).toMatchObject({ kind: 'studio', port: expected })
  })

  it('rejects the smallest and largest out-of-range ports', () => {
    for (const port of ['0', '65536', '99999999999999999999']) {
      expect(
        usageMessage(
          studio('--input', 'in', '--output', 'out', '--port', port),
        ),
      ).toBe(PORT_MESSAGE)
    }
  })
})

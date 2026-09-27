import { describe, expect, it } from 'vitest'

import { parseArguments, UsageError } from '../../src/cli/arguments.js'

describe('parseArguments', () => {
  it('recognizes both help flags', () => {
    expect(parseArguments(['--help'])).toEqual({ kind: 'help' })
    expect(parseArguments(['-h'])).toEqual({ kind: 'help' })
  })

  it('parses a summarize command with a file source', () => {
    expect(parseArguments(['summarize', 'data/input/numbers.txt'])).toEqual({
      kind: 'summarize',
      source: 'data/input/numbers.txt',
    })
  })

  it('parses a summarize command that reads stdin', () => {
    expect(parseArguments(['summarize', '-'])).toEqual({
      kind: 'summarize',
      source: '-',
    })
  })

  it('rejects a missing command', () => {
    expect(() => parseArguments([])).toThrow(UsageError)
    expect(() => parseArguments([])).toThrow('missing command')
  })

  it('rejects an unknown command', () => {
    expect(() => parseArguments(['frobnicate'])).toThrow(
      'unknown command: frobnicate',
    )
  })

  it('rejects a missing or surplus source', () => {
    expect(() => parseArguments(['summarize'])).toThrow(
      'summarize takes exactly one source: a file path or -',
    )
    expect(() => parseArguments(['summarize', 'a', 'b'])).toThrow(
      'summarize takes exactly one source: a file path or -',
    )
  })

  it('rejects an empty source', () => {
    expect(() => parseArguments(['summarize', ''])).toThrow(
      'summarize source must not be empty',
    )
  })

  it('parses required studio flags in any order', () => {
    expect(
      parseArguments([
        'studio',
        '--port',
        '4312',
        '--output',
        'data/output',
        '--input',
        'data/input',
      ]),
    ).toEqual({
      kind: 'studio',
      inputDirectory: 'data/input',
      outputDirectory: 'data/output',
      port: 4312,
    })
  })

  it.each([
    ['--input', 'data/input', '--output', 'data/output'],
    ['--input', 'data/input', '--port', '4312'],
    ['--output', 'data/output', '--port', '4312'],
  ])('requires every studio flag', (...flags) => {
    expect(() => parseArguments(['studio', ...flags])).toThrow(
      'studio requires --input, --output, and --port',
    )
  })

  it.each(['--input', '--output', '--port'])(
    'rejects duplicate %s flags',
    (flag) => {
      const value = flag === '--port' ? '4312' : 'directory'
      expect(() =>
        parseArguments([
          'studio',
          '--input',
          'input',
          '--output',
          'output',
          '--port',
          '4312',
          flag,
          value,
        ]),
      ).toThrow(`duplicate studio option: ${flag}`)
    },
  )

  it.each(['0', '65536', '-1', '1.5', '12x', 'Infinity', ''])(
    'rejects out-of-range or non-integer port %j',
    (port) => {
      expect(() =>
        parseArguments([
          'studio',
          '--input',
          'input',
          '--output',
          'output',
          '--port',
          port,
        ]),
      ).toThrow(
        port === ''
          ? 'missing value for --port'
          : '--port must be an integer from 1 to 65535',
      )
    },
  )

  it.each(['1', '65535'])('accepts boundary port %s', (port) => {
    expect(
      parseArguments([
        'studio',
        '--input',
        'input',
        '--output',
        'output',
        '--port',
        port,
      ]),
    ).toMatchObject({ kind: 'studio', port: Number(port) })
  })

  it('rejects unknown studio flags and missing flag values', () => {
    expect(() => parseArguments(['studio', '--host', 'localhost'])).toThrow(
      'unknown studio option: --host',
    )
    expect(() => parseArguments(['studio', '--input'])).toThrow(
      'missing value for --input',
    )
    expect(() =>
      parseArguments(['studio', '--input', '--output', 'output']),
    ).toThrow('missing value for --input')
  })
})

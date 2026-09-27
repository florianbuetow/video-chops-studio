export type Command =
  | { readonly kind: 'help' }
  | { readonly kind: 'summarize'; readonly source: string }
  | {
      readonly kind: 'studio'
      readonly inputDirectory: string
      readonly outputDirectory: string
      readonly port: number
    }

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const USAGE = `Usage:
  video-chops-studio studio --input <directory> --output <directory> --port <port>
                                       Start the local video editor
  video-chops-studio summarize <file>   Summarize the numbers in <file>, one per line
  video-chops-studio summarize -        Summarize the numbers read from stdin
  video-chops-studio --help             Show this help

Exit codes:
  0  success
  1  runtime failure (unreadable input, invalid number)
  2  usage error
`

export function parseArguments(argv: readonly string[]): Command {
  if (argv.length === 0) {
    throw new UsageError('missing command')
  }
  const [command, ...rest] = argv
  if (command === '--help' || command === '-h') {
    return { kind: 'help' }
  }
  if (command === 'studio') {
    return parseStudioArguments(rest)
  }
  if (command !== 'summarize') {
    throw new UsageError(`unknown command: ${command}`)
  }
  if (rest.length !== 1) {
    throw new UsageError('summarize takes exactly one source: a file path or -')
  }
  const [source] = rest
  if (source === undefined || source.length === 0) {
    throw new UsageError('summarize source must not be empty')
  }
  return { kind: 'summarize', source }
}

function parseStudioArguments(args: readonly string[]): Command {
  const options = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (key !== '--input' && key !== '--output' && key !== '--port') {
      throw new UsageError(`unknown studio option: ${key}`)
    }
    if (options.has(key))
      throw new UsageError(`duplicate studio option: ${key}`)
    if (value === undefined || value.trim() === '' || value.startsWith('--')) {
      throw new UsageError(`missing value for ${key}`)
    }
    options.set(key, value)
  }
  const inputDirectory = options.get('--input')
  const outputDirectory = options.get('--output')
  const portText = options.get('--port')
  if (
    inputDirectory === undefined ||
    outputDirectory === undefined ||
    portText === undefined
  ) {
    throw new UsageError('studio requires --input, --output, and --port')
  }
  const port = Number(portText)
  if (
    !/^\d+$/.test(portText) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new UsageError('--port must be an integer from 1 to 65535')
  }
  return { kind: 'studio', inputDirectory, outputDirectory, port }
}

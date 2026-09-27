import { fileURLToPath } from 'node:url'

import { summarizeText } from '../application/summarize-text.js'
import { parseArguments, USAGE, UsageError } from './arguments.js'
import { readInput } from './input.js'
import { startStudio } from './studio-server.js'

export interface CliIo {
  readonly stdin: NodeJS.ReadableStream
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
}

export const EXIT_SUCCESS = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const command = parseArguments(argv)
    if (command.kind === 'help') {
      io.stdout.write(USAGE)
      return EXIT_SUCCESS
    }
    if (command.kind === 'studio') {
      const studio = await startStudio({
        inputDirectory: command.inputDirectory,
        outputDirectory: command.outputDirectory,
        publicDirectory: fileURLToPath(
          new URL('../../dist/web/', import.meta.url),
        ),
        port: command.port,
      })
      io.stdout.write(`${JSON.stringify({ url: studio.url })}\n`)
      io.stderr.write(`Video Chops Studio is ready at ${studio.url}\n`)
      const reportCloseError = (error: unknown): void => {
        io.stderr.write(
          `error: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        process.exitCode = EXIT_FAILURE
      }
      const detach = (): void => {
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
      const stop = (): void => {
        detach()
        void studio.close().catch(reportCloseError)
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      studio.shutdown.then(
        () => {
          detach()
          io.stderr.write('Video Chops Studio stopped\n')
        },
        (error: unknown) => {
          detach()
          reportCloseError(error)
        },
      )
      return EXIT_SUCCESS
    }
    const input = await readInput(command.source, io.stdin)
    const summary = summarizeText(input)
    io.stdout.write(`${JSON.stringify(summary)}\n`)
    return EXIT_SUCCESS
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr.write(`error: ${message}\n`)
    if (error instanceof UsageError) {
      io.stderr.write(USAGE)
      return EXIT_USAGE
    }
    return EXIT_FAILURE
  }
}

import { createReadStream } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, resolve } from 'node:path'

export const MAX_JSON_BYTES = 64 * 1024

export class StudioHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'StudioHttpError'
  }
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const content = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': content.length,
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(content)
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const declaredLength = request.headers['content-length']
  if (declaredLength !== undefined) {
    const length = Number(declaredLength)
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new StudioHttpError(400, 'Invalid Content-Length')
    }
    if (length > MAX_JSON_BYTES) {
      throw new StudioHttpError(413, 'Request body exceeds 64 KiB')
    }
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > MAX_JSON_BYTES) {
      throw new StudioHttpError(413, 'Request body exceeds 64 KiB')
    }
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new StudioHttpError(400, 'Request body is not valid JSON')
  }
}

interface ByteRange {
  readonly start: number
  readonly end: number
}

function parseRange(value: string, size: number): ByteRange {
  const match = value.match(/^bytes=(\d*)-(\d*)$/u)
  if (match === null || (match[1] === '' && match[2] === '')) {
    throw new StudioHttpError(416, 'Requested range is not satisfiable')
  }
  const first = match[1] ?? ''
  const second = match[2] ?? ''
  if (first === '') {
    const suffix = Number(second)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw new StudioHttpError(416, 'Requested range is not satisfiable')
    }
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  const requestedEnd = second === '' ? size - 1 : Number(second)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    throw new StudioHttpError(416, 'Requested range is not satisfiable')
  }
  return { start, end: Math.min(requestedEnd, size - 1) }
}

function contentDisposition(name: string): string {
  const fileName = basename(name)
  const fallback = [...fileName]
    .map((character) =>
      /^[A-Za-z0-9._ -]$/u.test(character) ? character : '_',
    )
    .join('')
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/gu,
    (character) =>
      `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`,
  )
  return `attachment; filename="${fallback || 'download.mp4'}"; filename*=UTF-8''${encoded}`
}

export async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: string,
  contentType: string,
  options: { readonly ranges?: boolean; readonly downloadName?: string } = {},
): Promise<void> {
  let details
  try {
    details = await stat(file)
  } catch (error: unknown) {
    throw new StudioHttpError(404, 'File not found', { cause: error })
  }
  if (!details.isFile()) {
    throw new StudioHttpError(404, 'File not found')
  }
  const headers: Record<string, string | number> = {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
  }
  if (options.downloadName !== undefined) {
    headers['content-disposition'] = contentDisposition(options.downloadName)
  }
  const rangeHeader =
    options.ranges === true ? request.headers.range : undefined
  if (options.ranges === true) {
    headers['accept-ranges'] = 'bytes'
  }
  let start = 0
  let end = details.size - 1
  let status = 200
  if (rangeHeader !== undefined) {
    if (details.size === 0) {
      response.setHeader('content-range', 'bytes */0')
      throw new StudioHttpError(416, 'Requested range is not satisfiable')
    }
    try {
      const range = parseRange(rangeHeader, details.size)
      start = range.start
      end = range.end
      status = 206
      headers['content-range'] = `bytes ${start}-${end}/${details.size}`
    } catch (error: unknown) {
      if (error instanceof StudioHttpError && error.status === 416) {
        response.setHeader('content-range', `bytes */${details.size}`)
      }
      throw error
    }
  }
  headers['content-length'] = Math.max(0, end - start + 1)
  response.writeHead(status, headers)
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  if (details.size === 0) {
    response.end()
    return
  }
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(file, { start, end })
    const cleanup = (): void => {
      stream.off('error', onError)
      response.off('close', onClose)
      response.off('finish', onFinish)
    }
    const onError = (error: Error): void => {
      cleanup()
      rejectStream(error)
    }
    const onClose = (): void => {
      cleanup()
      stream.destroy()
      resolveStream()
    }
    const onFinish = (): void => {
      cleanup()
      resolveStream()
    }
    stream.once('error', onError)
    response.once('close', onClose)
    response.once('finish', onFinish)
    stream.pipe(response)
  })
}

export async function confinedFile(
  directory: string,
  name: string,
): Promise<string> {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    [...name].some((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code < 32 || code === 127)
    })
  ) {
    throw new StudioHttpError(400, 'name must be a single file name')
  }
  const root = await realpath(directory)
  const candidate = resolve(root, name)
  if (dirname(candidate) !== root) {
    throw new StudioHttpError(400, 'name must be a single file name')
  }
  let linkDetails
  try {
    linkDetails = await lstat(candidate)
  } catch (error: unknown) {
    throw new StudioHttpError(404, 'File not found', { cause: error })
  }
  if (!linkDetails.isFile() || linkDetails.isSymbolicLink()) {
    throw new StudioHttpError(404, 'File not found')
  }
  return candidate
}

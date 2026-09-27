import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'

import {
  BackgroundImageError,
  importBackground,
  resolveBackground,
} from '../application/background-images.js'
import { sendFile, sendJson, StudioHttpError } from './studio-http.js'

const MAX_BACKGROUND_BYTES = 20 * 1024 * 1024
const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/octet-stream',
])

function requiredName(url: URL): string {
  const name = url.searchParams.get('name')
  if (name === null || name.length === 0) {
    throw new StudioHttpError(400, 'name query parameter is required')
  }
  return name
}

function requireMethod(
  request: IncomingMessage,
  ...allowed: readonly string[]
): void {
  if (request.method === undefined || !allowed.includes(request.method)) {
    throw new StudioHttpError(405, 'Method not allowed')
  }
}

function declaredBodyLength(request: IncomingMessage): number | undefined {
  const value = request.headers['content-length']
  if (value === undefined) return undefined
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new StudioHttpError(400, 'Invalid Content-Length')
  }
  if (length > MAX_BACKGROUND_BYTES) {
    throw new StudioHttpError(413, 'Request body exceeds 20 MiB')
  }
  return length
}

async function readBackgroundBody(request: IncomingMessage): Promise<Buffer> {
  const declaredLength = declaredBodyLength(request)
  const chunks: Buffer[] = []
  let size = 0
  const iterator = request.iterator({ destroyOnReturn: false })
  for await (const chunk of iterator) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > MAX_BACKGROUND_BYTES) {
      request.resume()
      throw new StudioHttpError(413, 'Request body exceeds 20 MiB')
    }
    chunks.push(bytes)
  }
  if (declaredLength !== undefined && size !== declaredLength) {
    throw new StudioHttpError(400, 'Content-Length does not match request body')
  }
  if (size === 0) {
    throw new StudioHttpError(400, 'Background image body is empty')
  }
  return Buffer.concat(chunks, size)
}

function contentType(request: IncomingMessage): string {
  return (
    request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ??
    ''
  )
}

function imageContentType(name: string): string {
  switch (extname(name).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    default:
      throw new StudioHttpError(400, 'Unsupported background image extension')
  }
}

function asHttpError(error: unknown): StudioHttpError {
  if (!(error instanceof BackgroundImageError)) {
    return new StudioHttpError(500, 'Background image operation failed', {
      cause: error,
    })
  }
  if (error.message.startsWith('background image does not exist:')) {
    return new StudioHttpError(404, error.message, { cause: error })
  }
  if (
    error.message.startsWith('cannot access input directory:') ||
    error.message.startsWith('cannot inspect background image:') ||
    error.message.startsWith('could not create temporary files') ||
    error.message.startsWith('could not import background image') ||
    error.message.startsWith('could not save background image') ||
    error.message.startsWith('could not clean temporary files') ||
    error.message.startsWith('background image cache disappeared') ||
    error.message.startsWith('background image import produced no result')
  ) {
    return new StudioHttpError(500, 'Background image operation failed', {
      cause: error,
    })
  }
  return new StudioHttpError(400, error.message, { cause: error })
}

export async function handleBackgroundRoute(
  request: IncomingMessage,
  response: ServerResponse,
  inputDirectory: string,
  url: URL,
): Promise<boolean> {
  if (url.pathname === '/api/backgrounds') {
    requireMethod(request, 'POST')
    const type = contentType(request)
    if (!ALLOWED_CONTENT_TYPES.has(type)) {
      throw new StudioHttpError(
        415,
        'Unsupported background image Content-Type',
      )
    }
    try {
      const result = await importBackground(
        inputDirectory,
        requiredName(url),
        await readBackgroundBody(request),
      )
      sendJson(response, 201, {
        ...result,
        url: `/api/background?name=${encodeURIComponent(result.name)}`,
      })
    } catch (error: unknown) {
      if (error instanceof StudioHttpError) throw error
      throw asHttpError(error)
    }
    return true
  }

  if (url.pathname === '/api/background') {
    requireMethod(request, 'GET', 'HEAD')
    const name = requiredName(url)
    try {
      const file = await resolveBackground(inputDirectory, name)
      await sendFile(request, response, file, imageContentType(name))
    } catch (error: unknown) {
      if (error instanceof StudioHttpError) throw error
      throw asHttpError(error)
    }
    return true
  }

  return false
}

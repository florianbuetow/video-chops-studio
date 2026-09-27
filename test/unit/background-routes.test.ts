import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { promisify } from 'node:util'

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { handleBackgroundRoute } from '../../src/cli/background-routes.js'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []
let png: Buffer

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'background-route-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function request(
  chunks: readonly (Buffer | string)[] = [],
  headers: IncomingMessage['headers'] = {},
  method = 'GET',
): IncomingMessage {
  const readable = Readable.from(chunks) as Readable & {
    headers: IncomingMessage['headers']
    method: string
  }
  readable.headers = headers
  readable.method = method
  return readable as unknown as IncomingMessage
}

interface CapturedResponse {
  readonly response: ServerResponse
  readonly body: Buffer[]
  readonly writeHead: ReturnType<typeof vi.fn>
  readonly stream: PassThrough
}

function response(): CapturedResponse {
  const stream = new PassThrough()
  const body: Buffer[] = []
  stream.on('data', (chunk: Buffer) => body.push(chunk))
  const writeHead = vi.fn()
  const originalEnd = stream.end.bind(stream)
  Object.assign(stream, {
    writeHead,
    setHeader: vi.fn(),
    end(chunk?: Uint8Array | string) {
      return chunk === undefined ? originalEnd() : originalEnd(chunk)
    },
  })
  return {
    response: stream as unknown as ServerResponse,
    body,
    writeHead,
    stream,
  }
}

beforeAll(async () => {
  const fixtures = await temporaryDirectory()
  const file = join(fixtures, 'pixel.png')
  await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=orange:s=3x2,format=rgba',
      '-frames:v',
      '1',
      file,
    ],
    { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
  )
  png = await readFile(file)
})

afterEach(async () => {
  const disposable = temporaryDirectories.splice(1)
  await Promise.all(
    disposable.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('background HTTP routes', () => {
  it('uploads an image and serves the normalized PNG with GET and HEAD', async () => {
    const directory = await temporaryDirectory()
    const uploaded = response()
    const handled = await handleBackgroundRoute(
      request(
        [png],
        {
          'content-length': String(png.length),
          'content-type': 'image/png; charset=binary',
        },
        'POST',
      ),
      uploaded.response,
      directory,
      new URL('http://localhost/api/backgrounds?name=original.png'),
    )
    expect(handled).toBe(true)
    expect(uploaded.writeHead).toHaveBeenCalledWith(
      201,
      expect.objectContaining({
        'content-type': 'application/json; charset=utf-8',
      }),
    )
    const result = JSON.parse(Buffer.concat(uploaded.body).toString()) as {
      name: string
      width: number
      height: number
      url: string
    }
    expect(result).toMatchObject({ width: 3, height: 2 })
    expect(result.url).toBe(
      `/api/background?name=${encodeURIComponent(result.name)}`,
    )

    const downloaded = response()
    await handleBackgroundRoute(
      request([], {}, 'GET'),
      downloaded.response,
      directory,
      new URL(`http://localhost${result.url}`),
    )
    expect(downloaded.writeHead).toHaveBeenCalledWith(200, {
      'content-length': expect.any(Number),
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
    })
    expect(Buffer.concat(downloaded.body).subarray(1, 4).toString()).toBe('PNG')

    const headed = response()
    await handleBackgroundRoute(
      request([], {}, 'HEAD'),
      headed.response,
      directory,
      new URL(`http://localhost${result.url}`),
    )
    expect(headed.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'content-type': 'image/png' }),
    )
    expect(headed.body).toEqual([])
  })

  it('returns false for unrelated paths without touching the response', async () => {
    const captured = response()
    await expect(
      handleBackgroundRoute(
        request(),
        captured.response,
        '/unused',
        new URL('http://localhost/api/videos'),
      ),
    ).resolves.toBe(false)
    expect(captured.writeHead).not.toHaveBeenCalled()
  })

  it.each([
    ['/api/backgrounds', 'GET'],
    ['/api/background', 'POST'],
  ])('rejects method %s %s with 405', async (pathname, method) => {
    await expect(
      handleBackgroundRoute(
        request([], {}, method),
        response().response,
        '/unused',
        new URL(`http://localhost${pathname}?name=image.png`),
      ),
    ).rejects.toMatchObject({ status: 405, message: 'Method not allowed' })
  })

  it.each(['text/plain', 'image/gif', '', 'image/png-fake'])(
    'rejects unsupported upload content type %j',
    async (type) => {
      await expect(
        handleBackgroundRoute(
          request([png], type === '' ? {} : { 'content-type': type }, 'POST'),
          response().response,
          '/unused',
          new URL('http://localhost/api/backgrounds?name=image.png'),
        ),
      ).rejects.toMatchObject({ status: 415 })
    },
  )

  it('rejects missing names, malformed lengths, empty bodies, and oversized bodies', async () => {
    const directory = await temporaryDirectory()
    await expect(
      handleBackgroundRoute(
        request([png], { 'content-type': 'image/png' }, 'POST'),
        response().response,
        directory,
        new URL('http://localhost/api/backgrounds'),
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: 'name query parameter is required',
    })
    await expect(
      handleBackgroundRoute(
        request(
          [],
          { 'content-length': 'invalid', 'content-type': 'image/png' },
          'POST',
        ),
        response().response,
        directory,
        new URL('http://localhost/api/backgrounds?name=image.png'),
      ),
    ).rejects.toMatchObject({ status: 400, message: 'Invalid Content-Length' })
    await expect(
      handleBackgroundRoute(
        request([], { 'content-type': 'image/png' }, 'POST'),
        response().response,
        directory,
        new URL('http://localhost/api/backgrounds?name=image.png'),
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Background image body is empty',
    })
    await expect(
      handleBackgroundRoute(
        request(
          [],
          {
            'content-length': String(20 * 1024 * 1024 + 1),
            'content-type': 'image/png',
          },
          'POST',
        ),
        response().response,
        directory,
        new URL('http://localhost/api/backgrounds?name=image.png'),
      ),
    ).rejects.toMatchObject({
      status: 413,
      message: 'Request body exceeds 20 MiB',
    })

    await expect(
      handleBackgroundRoute(
        request(
          [Buffer.alloc(20 * 1024 * 1024), Buffer.from('x')],
          { 'content-type': 'application/octet-stream' },
          'POST',
        ),
        response().response,
        directory,
        new URL('http://localhost/api/backgrounds?name=image.png'),
      ),
    ).rejects.toMatchObject({
      status: 413,
      message: 'Request body exceeds 20 MiB',
    })
  })

  it('maps unsafe names, bad images, and missing files to stable HTTP errors', async () => {
    const directory = await temporaryDirectory()
    await expect(
      handleBackgroundRoute(
        request(
          [Buffer.from('broken')],
          { 'content-type': 'image/png' },
          'POST',
        ),
        response().response,
        directory,
        new URL('http://localhost/api/backgrounds?name=broken.png'),
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(
        /^(?:cannot read|file is not a supported) background image/u,
      ),
    })
    await expect(
      handleBackgroundRoute(
        request([], {}, 'GET'),
        response().response,
        directory,
        new URL('http://localhost/api/background?name=../secret.png'),
      ),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      handleBackgroundRoute(
        request([], {}, 'GET'),
        response().response,
        directory,
        new URL('http://localhost/api/background?name=missing.png'),
      ),
    ).rejects.toMatchObject({ status: 404 })
  })
})

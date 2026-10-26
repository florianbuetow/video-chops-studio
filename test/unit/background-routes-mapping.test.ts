import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  importBackground: undefined as
    | undefined
    | ((
        directory: string,
        name: string,
        body: Uint8Array,
      ) => Promise<{ name: string; width: number; height: number }>),
  resolveBackground: undefined as
    undefined | ((directory: string, name: string) => Promise<string>),
}))

vi.mock(
  '../../src/application/background-images.js',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('../../src/application/background-images.js')
      >()
    return {
      ...original,
      importBackground: vi.fn(
        async (directory: string, name: string, body: Uint8Array) =>
          hooks.importBackground === undefined
            ? await original.importBackground(directory, name, body)
            : await hooks.importBackground(directory, name, body),
      ),
      resolveBackground: vi.fn(async (directory: string, name: string) =>
        hooks.resolveBackground === undefined
          ? await original.resolveBackground(directory, name)
          : await hooks.resolveBackground(directory, name),
      ),
    }
  },
)

import {
  BackgroundImageError,
  importBackground,
} from '../../src/application/background-images.js'
import { handleBackgroundRoute } from '../../src/cli/background-routes.js'
import { StudioHttpError } from '../../src/cli/studio-http.js'

const MIB = 1024 * 1024
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'background-route-mapping-'))
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
  return { response: stream as unknown as ServerResponse, body, writeHead }
}

function upload(
  headers: IncomingMessage['headers'],
  chunks: readonly (Buffer | string)[] = [Buffer.from('image bytes')],
): IncomingMessage {
  return request(chunks, headers, 'POST')
}

function uploadUrl(query = '?name=upload.png'): URL {
  return new URL(`http://localhost/api/backgrounds${query}`)
}

function downloadUrl(query = '?name=download.png'): URL {
  return new URL(`http://localhost/api/background${query}`)
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected the operation to fail')
    },
    (error: unknown) => error,
  )
}

beforeEach(() => {
  hooks.importBackground = undefined
  hooks.resolveBackground = undefined
  vi.clearAllMocks()
})

afterEach(async () => {
  hooks.importBackground = undefined
  hooks.resolveBackground = undefined
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const internalFailures = [
  'cannot access input directory: /input',
  'cannot inspect background image: photo.png',
  'could not create temporary files for background image "photo.png"',
  'could not import background image "photo.png"',
  'could not save background image "photo.png"',
  'could not clean temporary files for background image "photo.png"',
  'background image cache disappeared while importing "photo.png"',
  'background image import produced no result for "photo.png"',
]

const clientFailures = [
  'background image is empty',
  'background image exceeds 20 MiB',
  'background name must be a single file name',
  'unsupported background image extension for "photo.gif"',
  'input path is not a directory: /input',
  'background image resolves outside the input directory: photo.png',
  'background image is not a regular file: photo.png',
  'cannot read background image "photo.png"',
  'background image metadata is invalid for "photo.png"',
  'file is not a supported background image: photo.png',
  'background image exceeds 40 megapixels: photo.png',
  'cached background image exceeds 4096px: photo.png',
]

describe('background route error mapping', () => {
  const operations = [
    [
      'upload',
      (failure: unknown) => {
        hooks.importBackground = async () => {
          throw failure
        }
        return handleBackgroundRoute(
          upload({ 'content-type': 'image/png' }),
          response().response,
          '/input',
          uploadUrl(),
        )
      },
    ],
    [
      'download',
      (failure: unknown) => {
        hooks.resolveBackground = async () => {
          throw failure
        }
        return handleBackgroundRoute(
          request([], {}, 'GET'),
          response().response,
          '/input',
          downloadUrl(),
        )
      },
    ],
  ] as const

  describe.each(operations)('during %s', (_label, run) => {
    it.each(internalFailures)(
      'hides the details of internal failure "%s" behind a 500 and keeps the cause',
      async (message) => {
        const cause = new BackgroundImageError(message)
        const failure = await failureOf(run(cause))
        expect(failure).toBeInstanceOf(StudioHttpError)
        expect(failure).toMatchObject({
          name: 'StudioHttpError',
          status: 500,
          message: 'Background image operation failed',
        })
        expect((failure as StudioHttpError).cause).toBe(cause)
      },
    )

    it.each(clientFailures)(
      'reports client failure "%s" as a 400 with its own message and cause',
      async (message) => {
        const cause = new BackgroundImageError(message)
        const failure = await failureOf(run(cause))
        expect(failure).toBeInstanceOf(StudioHttpError)
        expect(failure).toMatchObject({ status: 400, message })
        expect((failure as StudioHttpError).cause).toBe(cause)
      },
    )

    it('reports a missing image as a 404 with its own message and cause', async () => {
      const cause = new BackgroundImageError(
        'background image does not exist: photo.png',
      )
      const failure = await failureOf(run(cause))
      expect(failure).toBeInstanceOf(StudioHttpError)
      expect(failure).toMatchObject({
        status: 404,
        message: 'background image does not exist: photo.png',
      })
      expect((failure as StudioHttpError).cause).toBe(cause)
    })

    it.each([
      ['an Error', new Error('unexpected')],
      ['a string', 'unexpected'],
      ['undefined', undefined],
    ])(
      'reports %s as a generic 500 and keeps the cause',
      async (_kind, cause) => {
        const failure = await failureOf(run(cause))
        expect(failure).toBeInstanceOf(StudioHttpError)
        expect(failure).toMatchObject({
          status: 500,
          message: 'Background image operation failed',
        })
        expect((failure as StudioHttpError).cause).toBe(cause)
      },
    )

    it('passes HTTP errors through without remapping them', async () => {
      const original = new StudioHttpError(409, 'already busy')
      expect(await failureOf(run(original))).toBe(original)
    })
  })
})

describe('background upload route', () => {
  it('imports the body and answers 201 with the result and an encoded URL', async () => {
    const directory = await temporaryDirectory()
    hooks.importBackground = async () => ({
      name: 'background-ä b&c.png',
      width: 30,
      height: 20,
    })
    const captured = response()
    const body = Buffer.from('uploaded bytes')

    const handled = await handleBackgroundRoute(
      upload({ 'content-type': 'image/png' }, [
        body.subarray(0, 4),
        body.subarray(4),
      ]),
      captured.response,
      directory,
      uploadUrl('?name=my%20photo.png'),
    )

    expect(handled).toBe(true)
    expect(vi.mocked(importBackground)).toHaveBeenCalledTimes(1)
    const [calledDirectory, calledName, calledBody] =
      vi.mocked(importBackground).mock.calls[0] ?? []
    expect(calledDirectory).toBe(directory)
    expect(calledName).toBe('my photo.png')
    expect(Buffer.from(calledBody ?? new Uint8Array()).equals(body)).toBe(true)
    const payload = Buffer.from(
      JSON.stringify({
        name: 'background-ä b&c.png',
        width: 30,
        height: 20,
        url: '/api/background?name=background-%C3%A4%20b%26c.png',
      }),
    )
    expect(captured.writeHead).toHaveBeenCalledWith(201, {
      'cache-control': 'no-store',
      'content-length': payload.length,
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    })
    expect(Buffer.concat(captured.body).equals(payload)).toBe(true)
  })

  it.each([
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/octet-stream',
    'IMAGE/PNG',
    ' image/png',
    'image/png ',
    '\timage/webp\t; charset=binary',
    'Application/Octet-Stream;charset=x',
  ])('accepts the upload Content-Type %j', async (type) => {
    hooks.importBackground = async () => ({
      name: 'a.png',
      width: 1,
      height: 1,
    })
    const captured = response()
    await expect(
      handleBackgroundRoute(
        upload({ 'content-type': type }),
        captured.response,
        '/input',
        uploadUrl(),
      ),
    ).resolves.toBe(true)
    expect(captured.writeHead).toHaveBeenCalledWith(201, expect.any(Object))
  })

  it.each([
    undefined,
    '',
    ';',
    'text/plain',
    'image/gif',
    'image/png-fake',
    'xxximage/png',
    'multipart/form-data; boundary=image/png',
    'application/json',
  ])('rejects the upload Content-Type %j with an exact 415', async (type) => {
    const headers: IncomingMessage['headers'] =
      type === undefined ? {} : { 'content-type': type }
    const failure = await failureOf(
      handleBackgroundRoute(
        upload(headers),
        response().response,
        '/input',
        uploadUrl(),
      ),
    )
    expect(failure).toBeInstanceOf(StudioHttpError)
    expect(failure).toMatchObject({
      status: 415,
      message: 'Unsupported background image Content-Type',
    })
    expect(vi.mocked(importBackground)).not.toHaveBeenCalled()
  })

  it.each(['GET', 'HEAD', 'PUT', 'DELETE'])(
    'rejects %s on the upload route with 405',
    async (method) => {
      const failure = await failureOf(
        handleBackgroundRoute(
          request([Buffer.from('x')], { 'content-type': 'image/png' }, method),
          response().response,
          '/input',
          uploadUrl(),
        ),
      )
      expect(failure).toMatchObject({
        status: 405,
        message: 'Method not allowed',
      })
    },
  )

  it('rejects requests without a method with 405 on both routes', async () => {
    const withoutMethod = request()
    Object.assign(withoutMethod, { method: undefined })
    for (const url of [uploadUrl(), downloadUrl()]) {
      const failure = await failureOf(
        handleBackgroundRoute(
          withoutMethod,
          response().response,
          '/input',
          url,
        ),
      )
      expect(failure).toMatchObject({
        status: 405,
        message: 'Method not allowed',
      })
    }
  })

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])(
    'rejects %s on the download route with 405',
    async (method) => {
      const failure = await failureOf(
        handleBackgroundRoute(
          request([], {}, method),
          response().response,
          '/input',
          downloadUrl(),
        ),
      )
      expect(failure).toMatchObject({
        status: 405,
        message: 'Method not allowed',
      })
    },
  )

  it.each(['', '?name=', '?other=value'])(
    'requires a non-empty name query parameter on upload (%j)',
    async (query) => {
      const failure = await failureOf(
        handleBackgroundRoute(
          upload({ 'content-type': 'image/png' }),
          response().response,
          '/input',
          uploadUrl(query),
        ),
      )
      expect(failure).toBeInstanceOf(StudioHttpError)
      expect(failure).toMatchObject({
        status: 400,
        message: 'name query parameter is required',
      })
      expect(vi.mocked(importBackground)).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['not a number', 'invalid'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['unsafe', '9007199254740992'],
    ['padded text', 'ten'],
  ])('rejects a %s Content-Length with 400', async (_label, length) => {
    const failure = await failureOf(
      handleBackgroundRoute(
        upload({ 'content-type': 'image/png', 'content-length': length }),
        response().response,
        '/input',
        uploadUrl(),
      ),
    )
    expect(failure).toMatchObject({
      status: 400,
      message: 'Invalid Content-Length',
    })
    expect(vi.mocked(importBackground)).not.toHaveBeenCalled()
  })

  it('treats a declared zero length as valid and then reports the empty body', async () => {
    const failure = await failureOf(
      handleBackgroundRoute(
        upload({ 'content-type': 'image/png', 'content-length': '0' }, []),
        response().response,
        '/input',
        uploadUrl(),
      ),
    )
    expect(failure).toMatchObject({
      status: 400,
      message: 'Background image body is empty',
    })
  })

  it.each([
    ['fewer bytes than declared', '5', ['abc']],
    ['more bytes than declared', '3', ['abcde']],
    ['no bytes although 20 MiB are declared', String(20 * MIB), []],
  ])('rejects a body with %s', async (_label, length, chunks) => {
    const failure = await failureOf(
      handleBackgroundRoute(
        upload(
          { 'content-type': 'image/png', 'content-length': length },
          chunks,
        ),
        response().response,
        '/input',
        uploadUrl(),
      ),
    )
    expect(failure).toMatchObject({
      status: 400,
      message: 'Content-Length does not match request body',
    })
    expect(vi.mocked(importBackground)).not.toHaveBeenCalled()
  })

  it('imports a body that matches its declared Content-Length', async () => {
    hooks.importBackground = async () => ({
      name: 'a.png',
      width: 1,
      height: 1,
    })
    await handleBackgroundRoute(
      upload({ 'content-type': 'image/png', 'content-length': '5' }, [
        'ab',
        'cde',
      ]),
      response().response,
      '/input',
      uploadUrl(),
    )
    expect(vi.mocked(importBackground)).toHaveBeenCalledTimes(1)
  })

  it('rejects a declared length over 20 MiB by header alone with 413', async () => {
    const failure = await failureOf(
      handleBackgroundRoute(
        upload({
          'content-type': 'image/png',
          'content-length': String(20 * MIB + 1),
        }),
        response().response,
        '/input',
        uploadUrl(),
      ),
    )
    expect(failure).toMatchObject({
      status: 413,
      message: 'Request body exceeds 20 MiB',
    })
    expect(vi.mocked(importBackground)).not.toHaveBeenCalled()
  })

  it('accepts a body of exactly 20 MiB that matches its declared length', async () => {
    hooks.importBackground = async () => ({
      name: 'a.png',
      width: 1,
      height: 1,
    })
    const captured = response()
    await handleBackgroundRoute(
      upload(
        { 'content-type': 'image/png', 'content-length': String(20 * MIB) },
        [Buffer.alloc(20 * MIB)],
      ),
      captured.response,
      '/input',
      uploadUrl(),
    )
    const [, , calledBody] = vi.mocked(importBackground).mock.calls[0] ?? []
    expect(calledBody?.byteLength).toBe(20 * MIB)
    expect(captured.writeHead).toHaveBeenCalledWith(201, expect.any(Object))
  })

  it('accepts an undeclared streamed body of exactly 20 MiB', async () => {
    hooks.importBackground = async () => ({
      name: 'a.png',
      width: 1,
      height: 1,
    })
    await handleBackgroundRoute(
      upload({ 'content-type': 'image/png' }, [
        Buffer.alloc(10 * MIB),
        Buffer.alloc(10 * MIB),
      ]),
      response().response,
      '/input',
      uploadUrl(),
    )
    const [, , calledBody] = vi.mocked(importBackground).mock.calls[0] ?? []
    expect(calledBody?.byteLength).toBe(20 * MIB)
  })

  it('rejects a streamed body over 20 MiB, resumes the request, and keeps it alive', async () => {
    const incoming = upload({ 'content-type': 'image/png' }, [
      Buffer.alloc(20 * MIB),
      Buffer.from('x'),
      Buffer.from('never inspected'),
    ]) as unknown as Readable
    const resume = vi.spyOn(incoming, 'resume')
    const failure = await failureOf(
      handleBackgroundRoute(
        incoming as unknown as IncomingMessage,
        response().response,
        '/input',
        uploadUrl(),
      ),
    )
    expect(failure).toMatchObject({
      status: 413,
      message: 'Request body exceeds 20 MiB',
    })
    expect(incoming.destroyed).toBe(false)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(vi.mocked(importBackground)).not.toHaveBeenCalled()
  })

  it('accepts string chunks and concatenates every chunk in order', async () => {
    hooks.importBackground = async () => ({
      name: 'a.png',
      width: 1,
      height: 1,
    })
    await handleBackgroundRoute(
      upload({ 'content-type': 'image/png' }, ['ab', Buffer.from('cd'), 'ef']),
      response().response,
      '/input',
      uploadUrl(),
    )
    const [, , calledBody] = vi.mocked(importBackground).mock.calls[0] ?? []
    expect(Buffer.from(calledBody ?? new Uint8Array()).toString()).toBe(
      'abcdef',
    )
  })

  it('answers false for unrelated paths and prefixes without touching the request', async () => {
    for (const pathname of [
      '/api',
      '/api/backgrounds/',
      '/api/backgroundsx',
      '/',
    ]) {
      const captured = response()
      await expect(
        handleBackgroundRoute(
          request(),
          captured.response,
          '/input',
          new URL(`http://localhost${pathname}?name=a.png`),
        ),
      ).resolves.toBe(false)
      expect(captured.writeHead).not.toHaveBeenCalled()
    }
  })
})

describe('background download route', () => {
  it.each([
    ['photo.png', 'image/png'],
    ['photo.PNG', 'image/png'],
    ['photo.jpg', 'image/jpeg'],
    ['photo.JPG', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['photo.JpEg', 'image/jpeg'],
    ['photo.webp', 'image/webp'],
    ['photo.WEBP', 'image/webp'],
  ])('serves %s as %s and reports the route as handled', async (name, type) => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, name), 'image content')
    const captured = response()

    const handled = await handleBackgroundRoute(
      request([], {}, 'GET'),
      captured.response,
      directory,
      downloadUrl(`?name=${encodeURIComponent(name)}`),
    )

    expect(handled).toBe(true)
    expect(captured.writeHead).toHaveBeenCalledWith(200, {
      'content-length': 13,
      'content-type': type,
      'x-content-type-options': 'nosniff',
    })
    expect(Buffer.concat(captured.body).toString()).toBe('image content')
  })

  it('reports HEAD requests as handled without a body', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'photo.png'), 'image content')
    const captured = response()
    await expect(
      handleBackgroundRoute(
        request([], {}, 'HEAD'),
        captured.response,
        directory,
        downloadUrl('?name=photo.png'),
      ),
    ).resolves.toBe(true)
    expect(captured.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'content-type': 'image/png' }),
    )
    expect(captured.body).toEqual([])
  })

  it.each(['', '?name=', '?other=value'])(
    'requires a non-empty name query parameter on download (%j)',
    async (query) => {
      const failure = await failureOf(
        handleBackgroundRoute(
          request([], {}, 'GET'),
          response().response,
          '/input',
          downloadUrl(query),
        ),
      )
      expect(failure).toMatchObject({
        status: 400,
        message: 'name query parameter is required',
      })
    },
  )

  it('passes the resolved file and requested name through to the resolver', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'real.webp'), 'webp')
    const captured = response()
    hooks.resolveBackground = async (_input, name) => join(directory, name)
    await handleBackgroundRoute(
      request([], {}, 'GET'),
      captured.response,
      '/configured-input',
      downloadUrl('?name=real.webp'),
    )
    expect(captured.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'content-type': 'image/webp' }),
    )
  })

  it('rejects an extension the resolver let through with a 400', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'anim.gif'), 'gif')
    hooks.resolveBackground = async (_input, name) => join(directory, name)
    const failure = await failureOf(
      handleBackgroundRoute(
        request([], {}, 'GET'),
        response().response,
        directory,
        downloadUrl('?name=anim.gif'),
      ),
    )
    expect(failure).toBeInstanceOf(StudioHttpError)
    expect(failure).toMatchObject({
      status: 400,
      message: 'Unsupported background image extension',
    })
  })

  it('keeps the 404 that file sending raises instead of remapping it to a 500', async () => {
    const directory = await temporaryDirectory()
    hooks.resolveBackground = async () => join(directory, 'vanished.png')
    const failure = await failureOf(
      handleBackgroundRoute(
        request([], {}, 'GET'),
        response().response,
        directory,
        downloadUrl('?name=vanished.png'),
      ),
    )
    expect(failure).toBeInstanceOf(StudioHttpError)
    expect(failure).toMatchObject({ status: 404, message: 'File not found' })
  })
})

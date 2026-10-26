import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const streams = vi.hoisted(() => ({
  created: [] as Readable[],
  override: undefined as undefined | (() => Readable),
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return {
    ...original,
    createReadStream: vi.fn(
      (...args: Parameters<typeof original.createReadStream>) => {
        const stream =
          streams.override === undefined
            ? original.createReadStream(...args)
            : streams.override()
        streams.created.push(stream)
        return stream
      },
    ),
  }
})

import {
  confinedFile,
  MAX_JSON_BYTES,
  readJson,
  sendFile,
  StudioHttpError,
} from '../../src/cli/studio-http.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'studio-http-edge-'))
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
  readonly setHeader: ReturnType<typeof vi.fn>
  readonly ended: ReturnType<typeof vi.fn>
  readonly stream: PassThrough
}

function response(options?: {
  readonly finishOnly?: boolean
}): CapturedResponse {
  const finishOnly = options?.finishOnly === true
  const stream = new PassThrough(
    finishOnly ? { emitClose: false, autoDestroy: false } : {},
  )
  const body: Buffer[] = []
  stream.on('data', (chunk: Buffer) => body.push(chunk))
  const writeHead = vi.fn()
  const setHeader = vi.fn()
  const originalEnd = stream.end.bind(stream)
  const ended = vi.fn((chunk?: Uint8Array | string) => {
    if (chunk === undefined) originalEnd()
    else originalEnd(chunk)
    return stream
  })
  Object.assign(stream, { writeHead, setHeader, end: ended })
  return {
    response: stream as unknown as ServerResponse,
    body,
    writeHead,
    setHeader,
    ended,
    stream,
  }
}

async function outcome(
  promise: Promise<unknown>,
): Promise<'resolved' | 'rejected' | 'pending'> {
  return await Promise.race([
    promise.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<'pending'>((resolvePending) => {
      setTimeout(() => resolvePending('pending'), 300)
    }),
  ])
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
  streams.created.length = 0
  streams.override = undefined
  vi.clearAllMocks()
})

afterEach(async () => {
  streams.override = undefined
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('readJson size boundaries', () => {
  it('treats a declared length of zero as valid and reports the empty body as invalid JSON', async () => {
    const failure = await failureOf(
      readJson(request([], { 'content-length': '0' })),
    )
    expect(failure).toBeInstanceOf(StudioHttpError)
    expect(failure).toMatchObject({
      status: 400,
      message: 'Request body is not valid JSON',
    })
  })

  it('accepts a declared length equal to the limit without comparing it to the body', async () => {
    await expect(
      readJson(
        request(['{"ok":true}'], { 'content-length': String(MAX_JSON_BYTES) }),
      ),
    ).resolves.toEqual({ ok: true })
  })

  it('rejects a declared length one byte over the limit', async () => {
    await expect(
      readJson(request([], { 'content-length': String(MAX_JSON_BYTES + 1) })),
    ).rejects.toMatchObject({
      status: 413,
      message: 'Request body exceeds 64 KiB',
    })
  })

  it('accepts a streamed body of exactly the limit', async () => {
    const padding = 'x'.repeat(MAX_JSON_BYTES - '{"pad":""}'.length)
    const document = `{"pad":"${padding}"}`
    expect(Buffer.byteLength(document)).toBe(MAX_JSON_BYTES)
    await expect(
      readJson(
        request([
          Buffer.from(document.slice(0, 1000)),
          Buffer.from(document.slice(1000)),
        ]),
      ),
    ).resolves.toEqual({ pad: padding })
  })

  it('rejects a streamed body one byte over the limit', async () => {
    const document = `{"pad":"${'x'.repeat(MAX_JSON_BYTES - '{"pad":""}'.length + 1)}"}`
    await expect(readJson(request([document]))).rejects.toMatchObject({
      status: 413,
      message: 'Request body exceeds 64 KiB',
    })
  })
})

describe('sendFile range handling', () => {
  async function tenByteFile(): Promise<string> {
    const directory = await temporaryDirectory()
    const file = join(directory, 'clip.mp4')
    await writeFile(file, '0123456789')
    return file
  }

  it.each([
    ['bytes=3-3', 'bytes 3-3/10', '3'],
    ['bytes=0-0', 'bytes 0-0/10', '0'],
    ['bytes=9-9', 'bytes 9-9/10', '9'],
    ['bytes=9-', 'bytes 9-9/10', '9'],
    ['bytes=-1', 'bytes 9-9/10', '9'],
    ['bytes=0-', 'bytes 0-9/10', '0123456789'],
  ])(
    'serves the single-position range %s exactly',
    async (range, contentRange, body) => {
      const file = await tenByteFile()
      const captured = response()
      await sendFile(
        request([], { range }),
        captured.response,
        file,
        'video/mp4',
        {
          ranges: true,
        },
      )
      expect(captured.writeHead).toHaveBeenCalledWith(206, {
        'accept-ranges': 'bytes',
        'content-length': body.length,
        'content-range': contentRange,
        'content-type': 'video/mp4',
        'x-content-type-options': 'nosniff',
      })
      expect(Buffer.concat(captured.body).toString()).toBe(body)
    },
  )

  it.each([
    'bytes=10-12',
    'bytes=10-10',
    'bytes=11-',
    'bytes=-',
    'xbytes=0-1',
    ' bytes=0-1',
    'bytes=0-1x',
    'bytes=0-1 ',
    'bytes=a-b',
    'bytes=1-a',
    'bytes= 1-2',
    'BYTES=0-1',
  ])('rejects the range %j with 416 and the resource size', async (range) => {
    const file = await tenByteFile()
    const captured = response()
    const failure = await failureOf(
      sendFile(request([], { range }), captured.response, file, 'video/mp4', {
        ranges: true,
      }),
    )
    expect(failure).toBeInstanceOf(StudioHttpError)
    expect(failure).toMatchObject({
      status: 416,
      message: 'Requested range is not satisfiable',
    })
    expect(captured.setHeader).toHaveBeenCalledTimes(1)
    expect(captured.setHeader).toHaveBeenCalledWith(
      'content-range',
      'bytes */10',
    )
    expect(captured.writeHead).not.toHaveBeenCalled()
  })

  it.each(['bytes=0-', 'bytes=-5', 'bytes=0-4', 'bytes=1-1'])(
    'rejects the range %s on an empty file with an exact message and size header',
    async (range) => {
      const directory = await temporaryDirectory()
      const empty = join(directory, 'empty.mp4')
      await writeFile(empty, '')
      const captured = response()
      const failure = await failureOf(
        sendFile(
          request([], { range }),
          captured.response,
          empty,
          'video/mp4',
          {
            ranges: true,
          },
        ),
      )
      expect(failure).toBeInstanceOf(StudioHttpError)
      expect(failure).toMatchObject({
        status: 416,
        message: 'Requested range is not satisfiable',
      })
      expect(captured.setHeader).toHaveBeenCalledTimes(1)
      expect(captured.setHeader).toHaveBeenCalledWith(
        'content-range',
        'bytes */0',
      )
      expect(captured.writeHead).not.toHaveBeenCalled()
      expect(vi.mocked(createReadStream)).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, false])(
    'ignores a Range header when ranges are not enabled (%s)',
    async (ranges) => {
      const file = await tenByteFile()
      const captured = response()
      await sendFile(
        request([], { range: 'bytes=2-5' }),
        captured.response,
        file,
        'video/mp4',
        ranges === undefined ? {} : { ranges },
      )
      expect(captured.writeHead).toHaveBeenCalledWith(200, {
        'content-length': 10,
        'content-type': 'video/mp4',
        'x-content-type-options': 'nosniff',
      })
      expect(Buffer.concat(captured.body).toString()).toBe('0123456789')
      expect(captured.setHeader).not.toHaveBeenCalled()
    },
  )

  it('advertises range support on complete responses when enabled', async () => {
    const file = await tenByteFile()
    const captured = response()
    await sendFile(request(), captured.response, file, 'video/mp4', {
      ranges: true,
    })
    expect(captured.writeHead).toHaveBeenCalledWith(200, {
      'accept-ranges': 'bytes',
      'content-length': 10,
      'content-type': 'video/mp4',
      'x-content-type-options': 'nosniff',
    })
  })

  it.each([
    ['bytes=2-5', { start: 2, end: 5 }],
    ['bytes=7-', { start: 7, end: 9 }],
    ['bytes=-3', { start: 7, end: 9 }],
    ['bytes=0-99', { start: 0, end: 9 }],
  ])(
    'opens the file stream for %s with exact bounds',
    async (range, bounds) => {
      const file = await tenByteFile()
      await sendFile(
        request([], { range }),
        response().response,
        file,
        'video/mp4',
        {
          ranges: true,
        },
      )
      expect(vi.mocked(createReadStream)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(createReadStream)).toHaveBeenCalledWith(file, bounds)
    },
  )

  it('opens the whole file for requests without a range', async () => {
    const file = await tenByteFile()
    await sendFile(request(), response().response, file, 'video/mp4')
    expect(vi.mocked(createReadStream)).toHaveBeenCalledWith(file, {
      start: 0,
      end: 9,
    })
  })

  it('never opens a stream for HEAD requests or empty files', async () => {
    const directory = await temporaryDirectory()
    const full = join(directory, 'full.mp4')
    const empty = join(directory, 'empty.mp4')
    await Promise.all([writeFile(full, 'content'), writeFile(empty, '')])
    const head = response()
    await sendFile(request([], {}, 'HEAD'), head.response, full, 'video/mp4')
    const emptied = response()
    await sendFile(request(), emptied.response, empty, 'video/mp4')
    expect(vi.mocked(createReadStream)).not.toHaveBeenCalled()
    expect(head.ended).toHaveBeenCalledTimes(1)
    expect(emptied.ended).toHaveBeenCalledTimes(1)
  })
})

describe('sendFile download names', () => {
  it.each([
    ['', `attachment; filename="download.mp4"; filename*=UTF-8''`],
    ['/', `attachment; filename="download.mp4"; filename*=UTF-8''`],
    [
      'plain-Name_1.0 final.mp4',
      `attachment; filename="plain-Name_1.0 final.mp4"; filename*=UTF-8''plain-Name_1.0%20final.mp4`,
    ],
    [
      'a/b/../nested.mp4',
      `attachment; filename="nested.mp4"; filename*=UTF-8''nested.mp4`,
    ],
    [
      'quote".mp4',
      `attachment; filename="quote_.mp4"; filename*=UTF-8''quote%22.mp4`,
    ],
    [
      '\u{1f3ac}.mp4',
      `attachment; filename="_.mp4"; filename*=UTF-8''%F0%9F%8E%AC.mp4`,
    ],
  ])(
    'builds the content disposition for %j',
    async (downloadName, expected) => {
      const directory = await temporaryDirectory()
      const file = join(directory, 'clip.mp4')
      await writeFile(file, 'x')
      const captured = response()
      await sendFile(request(), captured.response, file, 'video/mp4', {
        downloadName,
      })
      expect(captured.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({ 'content-disposition': expected }),
      )
    },
  )

  it('omits the content disposition when no download name is given', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'clip.mp4')
    await writeFile(file, 'x')
    const captured = response()
    await sendFile(request(), captured.response, file, 'video/mp4')
    const headers = captured.writeHead.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >
    expect(Object.keys(headers)).not.toContain('content-disposition')
  })
})

describe('sendFile stream lifecycle', () => {
  async function largeFile(): Promise<string> {
    const directory = await temporaryDirectory()
    const file = join(directory, 'large.mp4')
    await writeFile(file, Buffer.alloc(4 * 1024 * 1024))
    return file
  }

  it('settles on finish alone and leaves no listeners behind', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'small.mp4')
    await writeFile(file, 'small file')
    const captured = response({ finishOnly: true })

    const sending = sendFile(request(), captured.response, file, 'video/mp4')

    expect(await outcome(sending)).toBe('resolved')
    expect(Buffer.concat(captured.body).toString()).toBe('small file')
    expect(captured.stream.listenerCount('close')).toBe(0)
    expect(captured.stream.listenerCount('finish')).toBe(0)
    const [source] = streams.created
    expect(source?.listenerCount('error')).toBe(0)
  })

  it('rejects with the read error and stops reacting to the client afterwards', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'unreadable.mp4')
    await writeFile(file, 'content')
    const readFailure = new Error('read failed')
    const source = new Readable({
      read() {
        this.destroy(readFailure)
      },
    })
    const destroy = vi.spyOn(source, 'destroy')
    streams.override = () => source
    const captured = response()

    const sending = sendFile(request(), captured.response, file, 'video/mp4')

    expect(await outcome(sending)).toBe('rejected')
    await expect(sending).rejects.toBe(readFailure)
    expect(destroy).toHaveBeenCalledTimes(1)
    captured.stream.emit('close')
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('resolves on client close, destroys the file stream, and leaves no listeners behind', async () => {
    const file = await largeFile()
    const captured = response()
    captured.stream.pause()

    const sending = sendFile(request(), captured.response, file, 'video/mp4')
    await vi.waitFor(() => expect(captured.writeHead).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(streams.created).toHaveLength(1))
    const [source] = streams.created
    expect(source?.destroyed).toBe(false)
    captured.stream.emit('close')

    expect(await outcome(sending)).toBe('resolved')
    expect(source?.destroyed).toBe(true)
    expect(captured.stream.listenerCount('close')).toBe(0)
    expect(captured.stream.listenerCount('finish')).toBe(0)
    expect(source?.listenerCount('error')).toBe(0)
  })
})

describe('confinedFile name checks', () => {
  it.each(['', '.', '..'])(
    'rejects the name %j even when the base directory is the file system root',
    async (name) => {
      await expect(confinedFile('/', name)).rejects.toMatchObject({
        name: 'StudioHttpError',
        status: 400,
        message: 'name must be a single file name',
      })
    },
  )

  it.each([
    'nested/../clip.mp4',
    'missing/../clip.mp4',
    './clip.mp4',
    '/clip.mp4',
    'clip.mp4/',
    'unit\u001fseparator.mp4',
    'escape\u001b.mp4',
  ])('rejects the name %j', async (name) => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'clip.mp4'), 'video')
    await expect(confinedFile(directory, name)).rejects.toMatchObject({
      status: 400,
      message: 'name must be a single file name',
    })
  })

  it('accepts names with spaces, dots and non-ASCII characters', async () => {
    const directory = await temporaryDirectory()
    const names = ['with space.mp4', '.hidden.mp4', 'café..mp4']
    await Promise.all(
      names.map((name) => writeFile(join(directory, name), 'video')),
    )
    for (const name of names) {
      await expect(confinedFile(directory, name)).resolves.toContain(name)
    }
  })

  it('reports directories and symlinks as missing files without a cause', async () => {
    const directory = await temporaryDirectory()
    await mkdir(join(directory, 'folder'))
    await writeFile(join(directory, 'target.mp4'), 'video')
    await symlink(join(directory, 'target.mp4'), join(directory, 'alias.mp4'))
    for (const name of ['folder', 'alias.mp4']) {
      const failure = (await failureOf(
        confinedFile(directory, name),
      )) as StudioHttpError
      expect(failure).toBeInstanceOf(StudioHttpError)
      expect(failure.status).toBe(404)
      expect(failure.message).toBe('File not found')
      expect(failure.cause).toBeUndefined()
    }
  })
})

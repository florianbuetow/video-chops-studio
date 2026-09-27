import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  confinedFile,
  MAX_JSON_BYTES,
  readJson,
  sendFile,
  sendJson,
  StudioHttpError,
} from '../../src/cli/studio-http.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'studio-http-test-'))
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

function response(): CapturedResponse {
  const stream = new PassThrough()
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('studio HTTP helpers', () => {
  it('preserves typed HTTP error details and causes', () => {
    const cause = new Error('root cause')
    expect(new StudioHttpError(409, 'conflict', { cause })).toMatchObject({
      name: 'StudioHttpError',
      status: 409,
      message: 'conflict',
      cause,
    })
  })

  it('writes deterministic no-cache JSON responses', () => {
    const captured = response()
    sendJson(captured.response, 201, { ok: true })
    const content = Buffer.from('{"ok":true}')
    expect(captured.writeHead).toHaveBeenCalledWith(201, {
      'cache-control': 'no-store',
      'content-length': content.length,
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    })
    expect(captured.ended).toHaveBeenCalledWith(content)
  })

  it('reads buffer and string chunks as one JSON document', async () => {
    await expect(
      readJson(
        request([Buffer.from('{"value":'), '42}'], {
          'content-length': '12',
        }),
      ),
    ).resolves.toEqual({ value: 42 })
  })

  it.each(['not-a-number', '-1', '1.5', '9007199254740992'])(
    'rejects invalid declared content length %s',
    async (length) => {
      await expect(
        readJson(request(['{}'], { 'content-length': length })),
      ).rejects.toMatchObject({
        name: 'StudioHttpError',
        status: 400,
        message: 'Invalid Content-Length',
      })
    },
  )

  it('rejects declared and streamed bodies over the byte limit', async () => {
    await expect(
      readJson(request([], { 'content-length': String(MAX_JSON_BYTES + 1) })),
    ).rejects.toMatchObject({
      status: 413,
      message: 'Request body exceeds 64 KiB',
    })

    await expect(
      readJson(
        request([
          Buffer.alloc(MAX_JSON_BYTES, 32),
          Buffer.from('x'),
          Buffer.from('never consumed'),
        ]),
      ),
    ).rejects.toMatchObject({
      status: 413,
      message: 'Request body exceeds 64 KiB',
    })
  })

  it.each([
    { chunks: [] as readonly string[] },
    { chunks: [''] },
    { chunks: ['{'] },
    { chunks: ['undefined'] },
  ])('rejects a malformed JSON body %#', async ({ chunks }) => {
    await expect(readJson(request(chunks))).rejects.toMatchObject({
      status: 400,
      message: 'Request body is not valid JSON',
    })
  })

  it('serves complete files with security and length headers', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'clip.mp4')
    await writeFile(file, '0123456789')
    const captured = response()
    await sendFile(request(), captured.response, file, 'video/mp4')
    expect(captured.writeHead).toHaveBeenCalledWith(200, {
      'content-length': 10,
      'content-type': 'video/mp4',
      'x-content-type-options': 'nosniff',
    })
    expect(Buffer.concat(captured.body).toString()).toBe('0123456789')
  })

  it.each([
    ['bytes=2-5', 206, 'bytes 2-5/10', '2345'],
    ['bytes=7-', 206, 'bytes 7-9/10', '789'],
    ['bytes=-3', 206, 'bytes 7-9/10', '789'],
    ['bytes=-99', 206, 'bytes 0-9/10', '0123456789'],
    ['bytes=0-99', 206, 'bytes 0-9/10', '0123456789'],
  ] as const)(
    'serves range %s with exact boundaries',
    async (range, status, contentRange, body) => {
      const directory = await temporaryDirectory()
      const file = join(directory, 'clip.mp4')
      await writeFile(file, '0123456789')
      const captured = response()
      await sendFile(
        request([], { range }),
        captured.response,
        file,
        'video/mp4',
        { ranges: true },
      )
      expect(captured.writeHead).toHaveBeenCalledWith(status, {
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
    'bytes=',
    'items=0-1',
    'bytes=0-1,4-5',
    'bytes=-0',
    'bytes=4-2',
    'bytes=10-',
    'bytes=9007199254740992-',
    'bytes=0-9007199254740992',
  ])(
    'rejects invalid range %s and reports the resource size',
    async (range) => {
      const directory = await temporaryDirectory()
      const file = join(directory, 'clip.mp4')
      await writeFile(file, '0123456789')
      const captured = response()
      await expect(
        sendFile(request([], { range }), captured.response, file, 'video/mp4', {
          ranges: true,
        }),
      ).rejects.toMatchObject({
        status: 416,
        message: 'Requested range is not satisfiable',
      })
      expect(captured.setHeader).toHaveBeenCalledWith(
        'content-range',
        'bytes */10',
      )
      expect(captured.writeHead).not.toHaveBeenCalled()
    },
  )

  it('handles HEAD and empty resources without opening a body stream', async () => {
    const directory = await temporaryDirectory()
    const full = join(directory, 'full.mp4')
    const empty = join(directory, 'empty.mp4')
    await Promise.all([writeFile(full, 'content'), writeFile(empty, '')])

    const head = response()
    await sendFile(request([], {}, 'HEAD'), head.response, full, 'video/mp4', {
      ranges: true,
    })
    expect(head.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        'accept-ranges': 'bytes',
        'content-length': 7,
      }),
    )
    expect(head.ended).toHaveBeenCalledWith()
    expect(head.body).toEqual([])

    const emptyResponse = response()
    await sendFile(request(), emptyResponse.response, empty, 'video/mp4')
    expect(emptyResponse.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'content-length': 0 }),
    )
    expect(emptyResponse.ended).toHaveBeenCalledWith()

    const rangedEmpty = response()
    await expect(
      sendFile(
        request([], { range: 'bytes=0-' }),
        rangedEmpty.response,
        empty,
        'video/mp4',
        { ranges: true },
      ),
    ).rejects.toMatchObject({ status: 416 })
    expect(rangedEmpty.setHeader).toHaveBeenCalledWith(
      'content-range',
      'bytes */0',
    )
  })

  it('sanitizes fallback download names and encodes the UTF-8 name', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'clip.mp4')
    await writeFile(file, 'x')
    const captured = response()
    await sendFile(request(), captured.response, file, 'video/mp4', {
      downloadName: `folder/café !'()*.mp4`,
    })
    expect(captured.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        'content-disposition': `attachment; filename="caf_ _____.mp4"; filename*=UTF-8''caf%C3%A9%20%21%27%28%29%2A.mp4`,
      }),
    )
  })

  it('rejects missing paths and directories as files', async () => {
    const directory = await temporaryDirectory()
    await expect(
      sendFile(request(), response().response, join(directory, 'missing'), 'x'),
    ).rejects.toMatchObject({
      status: 404,
      message: 'File not found',
      cause: expect.any(Error),
    })
    await expect(
      sendFile(request(), response().response, directory, 'x'),
    ).rejects.toMatchObject({ status: 404, message: 'File not found' })
  })

  it('resolves regular files and rejects every unsafe basename form', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'clip.mp4')
    await writeFile(file, 'video')
    await expect(confinedFile(directory, 'clip.mp4')).resolves.toBe(
      await realpath(file),
    )

    for (const name of [
      '',
      '.',
      '..',
      '../clip.mp4',
      'nested/clip.mp4',
      'nested\\clip.mp4',
      'line\nfeed.mp4',
      'nul\0byte.mp4',
      `delete${String.fromCodePoint(127)}.mp4`,
    ]) {
      await expect(confinedFile(directory, name)).rejects.toMatchObject({
        status: 400,
        message: 'name must be a single file name',
      })
    }
  })

  it('rejects missing files, directories, and symbolic links', async () => {
    const directory = await temporaryDirectory()
    const nested = join(directory, 'nested')
    const target = join(directory, 'target.mp4')
    await Promise.all([mkdir(nested), writeFile(target, 'video')])
    await symlink(target, join(directory, 'linked.mp4'))

    await expect(confinedFile(directory, 'missing.mp4')).rejects.toMatchObject({
      status: 404,
      message: 'File not found',
      cause: expect.any(Error),
    })
    await expect(confinedFile(directory, 'nested')).rejects.toMatchObject({
      status: 404,
      message: 'File not found',
    })
    await expect(confinedFile(directory, 'linked.mp4')).rejects.toMatchObject({
      status: 404,
      message: 'File not found',
    })
  })

  it('resolves a streaming request when the client closes', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'large.mp4')
    await writeFile(file, Buffer.alloc(4 * 1024 * 1024))
    const captured = response()
    captured.stream.pause()
    const sending = sendFile(request(), captured.response, file, 'video/mp4')
    await vi.waitFor(() => expect(captured.writeHead).toHaveBeenCalledOnce())
    captured.stream.emit('close')
    await expect(sending).resolves.toBeUndefined()
  })
})

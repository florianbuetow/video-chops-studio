import { EventEmitter } from 'node:events'
import type { RmOptions } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import type {
  IncomingMessage,
  RequestListener,
  Server,
  ServerResponse,
} from 'node:http'
import {
  createServer as createNodeServer,
  request as httpRequest,
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  real: undefined as unknown as typeof import('node:fs/promises'),
  servers: [] as Server[],
  responses: [] as ServerResponse[],
  destroyed: [] as (Error | undefined)[],
  listener: undefined as RequestListener | undefined,
  address: undefined as undefined | null | string,
  mkdtempFailure: undefined as unknown,
  previewDirectories: [] as string[],
}))

vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:http')>()
  return {
    ...original,
    createServer: vi.fn((listener: RequestListener) => {
      state.listener = listener
      const server = original.createServer((request, response) => {
        state.responses.push(response)
        const destroy = response.destroy.bind(response)
        response.destroy = ((error?: Error) => {
          state.destroyed.push(error)
          return destroy(error)
        }) as typeof response.destroy
        listener(request, response)
      })
      if (state.address !== undefined) {
        const address = state.address
        server.address = (() => address) as typeof server.address
      }
      state.servers.push(server)
      return server
    }),
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  state.real = original
  return {
    ...original,
    mkdtemp: vi.fn(async (prefix: string) => {
      if (prefix.endsWith('video-chops-preview-')) {
        if (state.mkdtempFailure !== undefined) throw state.mkdtempFailure
        const directory = await original.mkdtemp(prefix)
        state.previewDirectories.push(directory)
        return directory
      }
      return await original.mkdtemp(prefix)
    }),
    rm: vi.fn(async (path: string, options?: RmOptions) => {
      await original.rm(path, options)
    }),
  }
})

vi.mock('../../src/application/video-files.js', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../../src/application/video-files.js')
    >()
  return { ...original, checkVideoTools: vi.fn(async () => undefined) }
})

import {
  startStudio,
  type RunningStudio,
  type StudioOptions,
} from '../../src/cli/studio-server.js'

interface Fixture {
  readonly root: string
  readonly input: string
  readonly output: string
  readonly publicDirectory: string
}

const WEB_FILES = [
  'index.html',
  'styles.css',
  'app.js',
  'editor.js',
  'crop.js',
  'composition.js',
  'composition-view.js',
  'dom.js',
]
const temporaryDirectories: string[] = []
const runningStudios: RunningStudio[] = []

async function fixture(): Promise<Fixture> {
  const root = await state.real.realpath(
    await state.real.mkdtemp(join(tmpdir(), 'studio-server-lifecycle-')),
  )
  temporaryDirectories.push(root)
  const input = join(root, 'input')
  const output = join(root, 'output')
  const publicDirectory = join(root, 'web')
  await Promise.all([
    state.real.mkdir(input),
    state.real.mkdir(output),
    state.real.mkdir(publicDirectory),
    state.real.mkdir(join(root, 'domain')),
  ])
  await Promise.all([
    ...WEB_FILES.map((name) =>
      state.real.writeFile(join(publicDirectory, name), `content of ${name}`),
    ),
    state.real.writeFile(join(root, 'domain', 'video.js'), 'content of domain'),
  ])
  return { root, input, output, publicDirectory }
}

function optionsOf(
  testFixture: Fixture,
  overrides: Partial<StudioOptions> = {},
): StudioOptions {
  return {
    inputDirectory: testFixture.input,
    outputDirectory: testFixture.output,
    publicDirectory: testFixture.publicDirectory,
    port: 0,
    ...overrides,
  }
}

async function start(
  testFixture: Fixture,
  overrides: Partial<StudioOptions> = {},
): Promise<RunningStudio> {
  const studio = await startStudio(optionsOf(testFixture, overrides))
  runningStudios.push(studio)
  return studio
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected the operation to fail')
    },
    (error: unknown) => error,
  )
}

interface Reply {
  readonly status: number
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: string
}

async function send(
  url: string,
  options: {
    readonly method?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
  } = {},
): Promise<Reply> {
  return await new Promise((resolveReply, rejectReply) => {
    const outgoing = httpRequest(
      url,
      { method: options.method ?? 'GET', headers: options.headers ?? {} },
      (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.on('end', () =>
          resolveReply({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    outgoing.on('error', rejectReply)
    outgoing.end(options.body)
  })
}

beforeEach(() => {
  state.servers.length = 0
  state.responses.length = 0
  state.destroyed.length = 0
  state.address = undefined
  state.mkdtempFailure = undefined
  state.previewDirectories.length = 0
  vi.clearAllMocks()
})

afterEach(async () => {
  state.address = undefined
  state.mkdtempFailure = undefined
  await Promise.allSettled(runningStudios.splice(0).map((s) => s.close()))
  await Promise.allSettled(
    state.servers.map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.close(() => resolveClose())
          server.closeAllConnections()
        }),
    ),
  )
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        state.real.rm(directory, { recursive: true, force: true }),
      ),
  )
})

async function exists(path: string): Promise<boolean> {
  return await state.real.access(path).then(
    () => true,
    () => false,
  )
}

describe('studio startup validation', () => {
  it.each([65_535, 0])(
    'accepts port %s as a valid value and only fails later if it cannot bind',
    async (port) => {
      const testFixture = await fixture()
      const attempt = await startStudio(optionsOf(testFixture, { port })).then(
        (studio) => ({ studio }),
        (error: unknown) => ({ error }),
      )
      if ('studio' in attempt) {
        await attempt.studio.close()
        return
      }
      expect(attempt.error).toBeInstanceOf(Error)
      expect((attempt.error as Error).message).toMatch(
        /^Cannot bind video studio server: /u,
      )
    },
  )

  it('creates the port error without a cause property', async () => {
    const testFixture = await fixture()
    const failure = (await failureOf(
      startStudio(optionsOf(testFixture, { port: 65_536 })),
    )) as Error
    expect(failure.name).toBe('StudioServerError')
    expect(failure.message).toBe('port must be an integer between 0 and 65535')
    expect(Object.hasOwn(failure, 'cause')).toBe(false)
  })

  it('names the input path when it is not a directory', async () => {
    const testFixture = await fixture()
    const inputFile = join(testFixture.root, 'input-file')
    await state.real.writeFile(inputFile, 'file')
    const failure = (await failureOf(
      startStudio(optionsOf(testFixture, { inputDirectory: inputFile })),
    )) as Error
    expect(failure.name).toBe('StudioServerError')
    expect(failure.message).toBe(
      'Cannot start video studio: Input path is not a directory',
    )
    expect(failure.cause).toMatchObject({
      name: 'StudioServerError',
      message: 'Input path is not a directory',
    })
    expect(state.servers).toEqual([])
  })

  it('names the public path when it is not a directory', async () => {
    const testFixture = await fixture()
    const publicFile = join(testFixture.root, 'public-file')
    await state.real.writeFile(publicFile, 'file')
    const failure = (await failureOf(
      startStudio(optionsOf(testFixture, { publicDirectory: publicFile })),
    )) as Error
    expect(failure.message).toBe(
      'Cannot start video studio: Public path is not a directory',
    )
    expect(failure.cause).toMatchObject({
      message: 'Public path is not a directory',
    })
    expect(state.servers).toEqual([])
  })

  it('reports a failure to create the preview cache with its cause', async () => {
    const testFixture = await fixture()
    const cause = new Error('no space left on device')
    state.mkdtempFailure = cause
    const failure = (await failureOf(
      startStudio(optionsOf(testFixture)),
    )) as Error
    expect(failure.name).toBe('StudioServerError')
    expect(failure.message).toBe(
      'Cannot create preview cache: no space left on device',
    )
    expect(failure.cause).toBe(cause)
    expect(state.servers).toEqual([])
  })
})

describe('studio preview cache and server lifecycle', () => {
  it('creates a private cache under the temp directory and removes it on close', async () => {
    const studio = await start(await fixture())
    expect(state.previewDirectories).toHaveLength(1)
    const [cacheDirectory] = state.previewDirectories
    expect(cacheDirectory).toBeDefined()
    expect(vi.mocked(mkdtemp)).toHaveBeenCalledWith(
      join(tmpdir(), 'video-chops-preview-'),
    )
    expect(await exists(cacheDirectory ?? '')).toBe(true)

    await studio.close()

    expect(await exists(cacheDirectory ?? '')).toBe(false)
    expect(vi.mocked(rm)).toHaveBeenCalledWith(cacheDirectory, {
      recursive: true,
      force: true,
    })
  })

  it('removes the cache with exact options when binding fails', async () => {
    const testFixture = await fixture()
    const blocker = createNodeServer()
    await new Promise<void>((resolveListen, rejectListen) => {
      blocker.once('error', rejectListen)
      blocker.listen(0, '127.0.0.1', resolveListen)
    })
    try {
      const address = blocker.address()
      if (address === null || typeof address === 'string') {
        throw new Error('blocking server did not bind to a TCP port')
      }
      const failure = (await failureOf(
        startStudio(optionsOf(testFixture, { port: address.port })),
      )) as Error
      expect(failure.message).toMatch(
        /^Cannot bind video studio server: .*EADDRINUSE/u,
      )
      expect(failure.cause).toMatchObject({ code: 'EADDRINUSE' })
      const [cacheDirectory] = state.previewDirectories
      expect(await exists(cacheDirectory ?? '')).toBe(false)
      expect(vi.mocked(rm)).toHaveBeenCalledWith(cacheDirectory, {
        recursive: true,
        force: true,
      })
    } finally {
      await new Promise<void>((resolveClose) => {
        blocker.close(() => resolveClose())
      })
    }
  })

  it.each([
    ['null', null],
    ['a pipe name', '/tmp/studio.sock'],
  ])(
    'rejects a server whose address is %s instead of a TCP port',
    async (_label, address) => {
      const testFixture = await fixture()
      state.address = address
      const failure = (await failureOf(
        startStudio(optionsOf(testFixture)),
      )) as Error
      expect(failure.name).toBe('StudioServerError')
      expect(failure.message).toBe(
        'Cannot bind video studio server: Server did not bind to a TCP port',
      )
      expect(failure.cause).toMatchObject({
        name: 'StudioServerError',
        message: 'Server did not bind to a TCP port',
      })
      const [cacheDirectory] = state.previewDirectories
      expect(await exists(cacheDirectory ?? '')).toBe(false)
    },
  )

  it('removes its startup error listener once the server is listening', async () => {
    const studio = await start(await fixture())
    const [server] = state.servers
    expect(server?.listening).toBe(true)
    expect(server?.listenerCount('error')).toBe(0)
    expect(studio.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
  })

  it('reports a close failure and still removes the preview cache', async () => {
    const studio = await start(await fixture())
    const [server] = state.servers
    const [cacheDirectory] = state.previewDirectories
    await new Promise<void>((resolveClose) => {
      server?.close(() => resolveClose())
    })

    const failure = await failureOf(studio.close())

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ code: 'ERR_SERVER_NOT_RUNNING' })
    expect(await exists(cacheDirectory ?? '')).toBe(false)
    expect(vi.mocked(rm)).toHaveBeenCalledWith(cacheDirectory, {
      recursive: true,
      force: true,
    })
  })
})

describe('studio static assets', () => {
  it.each([
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/editor.js', 'editor.js', 'text/javascript; charset=utf-8'],
    ['/crop.js', 'crop.js', 'text/javascript; charset=utf-8'],
    ['/composition.js', 'composition.js', 'text/javascript; charset=utf-8'],
    [
      '/composition-view.js',
      'composition-view.js',
      'text/javascript; charset=utf-8',
    ],
    ['/dom.js', 'dom.js', 'text/javascript; charset=utf-8'],
  ])(
    'serves %s from %s with %s and keeps the connection',
    async (path, file, type) => {
      const studio = await start(await fixture())
      const get = await send(`${studio.url}${path}`)
      expect(get.status).toBe(200)
      expect(get.headers['content-type']).toBe(type)
      expect(get.headers['x-content-type-options']).toBe('nosniff')
      expect(get.body).toBe(`content of ${file}`)
      const head = await send(`${studio.url}${path}`, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers['content-type']).toBe(type)
      expect(head.body).toBe('')
      await delay(30)
      expect(state.destroyed).toEqual([])
    },
  )

  it('serves the compiled domain module next to the public directory', async () => {
    const studio = await start(await fixture())
    const get = await send(`${studio.url}/domain/video.js`)
    expect(get.status).toBe(200)
    expect(get.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(get.body).toBe('content of domain')
    const head = await send(`${studio.url}/domain/video.js`, {
      method: 'HEAD',
    })
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(
      String('content of domain'.length),
    )
    expect(head.body).toBe('')
    await delay(30)
    expect(state.destroyed).toEqual([])
  })

  it.each(['/', '/app.js', '/domain/video.js'])(
    'rejects POST and PUT on %s with 405',
    async (path) => {
      const studio = await start(await fixture())
      for (const method of ['POST', 'PUT']) {
        const reply = await send(`${studio.url}${path}`, { method })
        expect(reply.status).toBe(405)
        expect(JSON.parse(reply.body)).toEqual({ error: 'Method not allowed' })
      }
    },
  )

  it('does not serve files that are not on the allowlist', async () => {
    const testFixture = await fixture()
    await state.real.writeFile(
      join(testFixture.publicDirectory, 'secret.txt'),
      'x',
    )
    const studio = await start(testFixture)
    for (const path of ['/secret.txt', '/domain/other.js', '/index.html']) {
      const reply = await send(`${studio.url}${path}`)
      expect(reply.status).toBe(404)
      expect(JSON.parse(reply.body)).toEqual({ error: 'Unknown route' })
    }
  })
})

describe('studio request validation', () => {
  it('does not check the Origin header on GET requests', async () => {
    const studio = await start(await fixture())
    const reply = await send(`${studio.url}/api/health`, {
      headers: { origin: 'https://example.test' },
    })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual({ status: 'running' })
  })

  it('lets same-origin POST requests through to content type validation', async () => {
    const studio = await start(await fixture())
    const sameOrigin = await send(`${studio.url}/api/exports`, {
      method: 'POST',
      headers: {
        origin: studio.url,
        'sec-fetch-site': 'same-origin',
        'content-type': 'text/plain',
      },
      body: '{}',
    })
    expect(sameOrigin.status).toBe(415)
  })

  it('requires a JSON content type and answers 415 when the header is absent', async () => {
    const studio = await start(await fixture())
    const reply = await send(`${studio.url}/api/exports`, { method: 'POST' })
    expect(reply.status).toBe(415)
    expect(JSON.parse(reply.body)).toEqual({
      error: 'Content-Type must be application/json',
    })
  })

  it.each([
    ['a string', '"clip.mp4"'],
    ['a number', '42'],
    ['a boolean', 'true'],
    ['null', 'null'],
    ['an array', '[]'],
    ['an object without a source', '{}'],
    ['an object with a numeric source', '{"source":7}'],
  ])('rejects an export request body that is %s', async (_label, body) => {
    const studio = await start(await fixture())
    const reply = await send(`${studio.url}/api/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: studio.url },
      body,
    })
    expect(reply.status).toBe(400)
    expect(JSON.parse(reply.body)).toEqual({
      error: 'source must be a single file name',
    })
  })

  it.each([
    ['/api/exports/', 'Unknown route'],
    ['/api/exports/nested/id', 'Unknown route'],
    ['/api/exports/unknown-id', 'Export not found'],
  ])('answers 404 for %s with the exact message', async (path, message) => {
    const studio = await start(await fixture())
    const reply = await send(`${studio.url}${path}`)
    expect(reply.status).toBe(404)
    expect(JSON.parse(reply.body)).toEqual({ error: message })
  })

  it.each(['/api/video?name=', '/api/preview?name=', '/api/output?name='])(
    'treats an empty name on %s as missing',
    async (path) => {
      const studio = await start(await fixture())
      const reply = await send(`${studio.url}${path}`)
      expect(reply.status).toBe(400)
      expect(JSON.parse(reply.body)).toEqual({
        error: 'name query parameter is required',
      })
    },
  )
})

describe('studio output downloads', () => {
  it('rejects non-MP4 names with the exact message but accepts any MP4 case', async () => {
    const testFixture = await fixture()
    await state.real.writeFile(
      join(testFixture.output, 'CLIP.MP4'),
      'video data',
    )
    const studio = await start(testFixture)

    const wrongType = await send(`${studio.url}/api/output?name=notes.txt`)
    expect(wrongType.status).toBe(400)
    expect(JSON.parse(wrongType.body)).toEqual({
      error: 'Output must be an .mp4 file',
    })

    const download = await send(`${studio.url}/api/output?name=CLIP.MP4`)
    expect(download.status).toBe(200)
    expect(download.body).toBe('video data')
    expect(download.headers['content-type']).toBe('video/mp4')
    expect(download.headers['accept-ranges']).toBe('bytes')
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename="CLIP.MP4"; filename*=UTF-8''CLIP.MP4`,
    )

    const missing = await send(`${studio.url}/api/output?name=MISSING.MP4`)
    expect(missing.status).toBe(404)
    expect(JSON.parse(missing.body)).toEqual({ error: 'File not found' })
  })
})

describe('studio background routes', () => {
  it('mounts the background routes ahead of the unknown-route fallback', async () => {
    const studio = await start(await fixture())

    const missing = await send(`${studio.url}/api/background?name=missing.png`)
    expect(missing.status).toBe(404)
    expect(JSON.parse(missing.body)).toEqual({
      error: 'background image does not exist: missing.png',
    })

    const noContentType = await send(
      `${studio.url}/api/backgrounds?name=a.png`,
      {
        method: 'POST',
      },
    )
    expect(noContentType.status).toBe(415)
    expect(JSON.parse(noContentType.body)).toEqual({
      error: 'Unsupported background image Content-Type',
    })

    const wrongMethod = await send(`${studio.url}/api/background?name=a.png`, {
      method: 'POST',
    })
    expect(wrongMethod.status).toBe(405)
  })

  it('serves an uploaded background from the input directory', async () => {
    const testFixture = await fixture()
    await state.real.writeFile(
      join(testFixture.input, 'stored.webp'),
      'webp bytes',
    )
    const studio = await start(testFixture)
    const reply = await send(`${studio.url}/api/background?name=stored.webp`)
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('image/webp')
    expect(reply.body).toBe('webp bytes')
  })
})

describe('studio error reporting after headers are sent', () => {
  it('destroys the response with a typed error that keeps the URL parse failure as cause', async () => {
    const studio = await start(await fixture())
    const listener = state.listener
    if (listener === undefined) throw new Error('listener was not captured')
    const incoming = new EventEmitter() as EventEmitter & {
      headers: IncomingMessage['headers']
      url: string
      method: string
    }
    incoming.headers = { host: new URL(studio.url).host }
    incoming.url = 'http://%'
    incoming.method = 'GET'
    const destroy = vi.fn()
    const outgoing = Object.assign(new EventEmitter(), {
      headersSent: true,
      writeHead: vi.fn(),
      end: vi.fn(),
      destroy,
    })

    listener(
      incoming as unknown as IncomingMessage,
      outgoing as unknown as ServerResponse,
    )
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1))

    const [error] = destroy.mock.calls[0] ?? []
    expect(error).toMatchObject({
      name: 'StudioHttpError',
      status: 400,
      message: 'Request URL is invalid',
      cause: expect.any(TypeError),
    })
  })
})

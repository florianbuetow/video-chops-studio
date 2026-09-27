import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from 'node:http'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const serverState = vi.hoisted(() => ({
  listener: undefined as RequestListener | undefined,
  checkFailure: undefined as unknown,
  listFailure: undefined as unknown,
  probeFailure: undefined as unknown,
  previewPath: undefined as string | undefined,
  renderFailure: undefined as unknown,
  renderProgress: [] as number[],
  renderPromise: undefined as Promise<unknown> | undefined,
  renderCalls: 0,
}))

vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:http')>()
  return {
    ...original,
    createServer: vi.fn((listener: RequestListener) => {
      serverState.listener = listener
      return original.createServer(listener)
    }),
  }
})

vi.mock('../../src/application/video-files.js', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../../src/application/video-files.js')
    >()
  return {
    ...original,
    checkVideoTools: vi.fn(async () => {
      if (serverState.checkFailure !== undefined) throw serverState.checkFailure
    }),
    listVideos: vi.fn(async () => {
      if (serverState.listFailure !== undefined) throw serverState.listFailure
      return [{ name: 'clip.mp4', size: 100 }]
    }),
    probeVideo: vi.fn(async (_directory: string, name: string) => {
      if (serverState.probeFailure !== undefined) throw serverState.probeFailure
      return {
        name,
        size: 100,
        width: 640,
        height: 360,
        duration: 5,
        fps: 25,
        hasAudio: true,
      }
    }),
  }
})

vi.mock('../../src/application/video-render.js', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../../src/application/video-render.js')
    >()
  return {
    ...original,
    preparePreview: vi.fn(
      async (_input: string, _name: string, cacheDirectory: string) => {
        return serverState.previewPath ?? join(cacheDirectory, 'preview.mp4')
      },
    ),
    renderVideo: vi.fn(
      async (
        _input: string,
        _output: string,
        _edit: unknown,
        onProgress: (progress: number) => void,
      ) => {
        serverState.renderCalls += 1
        for (const progress of serverState.renderProgress) onProgress(progress)
        if (serverState.renderPromise !== undefined) {
          return await serverState.renderPromise
        }
        if (serverState.renderFailure !== undefined)
          throw serverState.renderFailure
        return {
          name: 'result.mp4',
          duration: 1,
          width: 320,
          height: 240,
          size: 42,
        }
      },
    ),
  }
})

import {
  VideoFileError,
  checkVideoTools,
} from '../../src/application/video-files.js'
import { startStudio, type RunningStudio } from '../../src/cli/studio-server.js'

interface Fixture {
  readonly root: string
  readonly input: string
  readonly output: string
  readonly publicDirectory: string
}

const temporaryDirectories: string[] = []
const runningStudios: RunningStudio[] = []

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'studio-server-errors-'))
  temporaryDirectories.push(root)
  const input = join(root, 'input')
  const output = join(root, 'nested', 'output')
  const publicDirectory = join(root, 'public')
  await Promise.all([mkdir(input), mkdir(publicDirectory)])
  await Promise.all([
    writeFile(join(publicDirectory, 'index.html'), '<title>test</title>'),
    writeFile(join(publicDirectory, 'app.js'), 'app'),
    writeFile(join(publicDirectory, 'styles.css'), 'styles'),
    writeFile(join(publicDirectory, 'editor.js'), 'editor'),
    writeFile(join(publicDirectory, 'crop.js'), 'crop'),
    writeFile(join(publicDirectory, 'dom.js'), 'dom'),
  ])
  return { root, input, output, publicDirectory }
}

async function start(testFixture: Fixture): Promise<RunningStudio> {
  const studio = await startStudio({
    inputDirectory: testFixture.input,
    outputDirectory: testFixture.output,
    publicDirectory: testFixture.publicDirectory,
    port: 0,
  })
  runningStudios.push(studio)
  return studio
}

const validEdit = {
  source: 'clip.mp4',
  segments: [{ start: 0, end: 1 }],
  crop: { x: 0, y: 0, width: 320, height: 240 },
  outputName: 'result.mp4',
  muted: false,
} as const

async function postExport(
  studio: RunningStudio,
  body: unknown,
  contentType = 'application/json',
): Promise<Response> {
  return await fetch(`${studio.url}/api/exports`, {
    method: 'POST',
    headers: { 'content-type': contentType, origin: studio.url },
    body: JSON.stringify(body),
  })
}

async function waitForJob(
  studio: RunningStudio,
  id: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${studio.url}/api/exports/${id}`)
    const job = (await response.json()) as Record<string, unknown>
    if (job['status'] !== 'running') return job
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 2))
  }
  throw new Error('job did not settle')
}

function rawRequest(
  url: string,
  options: {
    readonly method?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
  } = {},
): Promise<{
  readonly status: number
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: string
}> {
  return new Promise((resolveResponse, rejectResponse) => {
    const outgoing = httpRequest(
      url,
      { method: options.method, headers: options.headers },
      (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.on('end', () =>
          resolveResponse({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    outgoing.on('error', rejectResponse)
    outgoing.end(options.body)
  })
}

async function invokeCaptured(
  studio: RunningStudio,
  values: {
    readonly url?: string
    readonly method?: string
    readonly headersSent?: boolean
  },
): Promise<{
  readonly writeHead: ReturnType<typeof vi.fn>
  readonly end: ReturnType<typeof vi.fn>
  readonly destroy: ReturnType<typeof vi.fn>
}> {
  const authority = new URL(studio.url).host
  const incoming = new EventEmitter() as EventEmitter & {
    headers: IncomingMessage['headers']
    url?: string
    method?: string
  }
  incoming.headers = { host: authority }
  if (values.url !== undefined) incoming.url = values.url
  if (values.method !== undefined) incoming.method = values.method
  const writeHead = vi.fn()
  const end = vi.fn()
  const destroy = vi.fn()
  const outgoing = Object.assign(new EventEmitter(), {
    headersSent: values.headersSent ?? false,
    writeHead,
    end,
    destroy,
  })
  const listener = serverState.listener
  if (listener === undefined)
    throw new Error('server listener was not captured')
  listener(
    incoming as unknown as IncomingMessage,
    outgoing as unknown as ServerResponse,
  )
  await vi.waitFor(() =>
    expect(end.mock.calls.length + destroy.mock.calls.length).toBe(1),
  )
  return { writeHead, end, destroy }
}

beforeEach(() => {
  serverState.checkFailure = undefined
  serverState.listFailure = undefined
  serverState.probeFailure = undefined
  serverState.previewPath = undefined
  serverState.renderFailure = undefined
  serverState.renderProgress = []
  serverState.renderPromise = undefined
  serverState.renderCalls = 0
  vi.clearAllMocks()
})

afterEach(async () => {
  await Promise.allSettled(
    runningStudios.splice(0).map(async (studio) => studio.close()),
  )
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('studio server boundary behavior', () => {
  it.each([-1, 65_536, 1.5, Number.NaN])(
    'rejects invalid port %s before startup work',
    async (port) => {
      const testFixture = await fixture()
      await expect(
        startStudio({
          inputDirectory: testFixture.input,
          outputDirectory: testFixture.output,
          publicDirectory: testFixture.publicDirectory,
          port,
        }),
      ).rejects.toMatchObject({
        name: 'StudioServerError',
        message: 'port must be an integer between 0 and 65535',
      })
      expect(checkVideoTools).not.toHaveBeenCalled()
    },
  )

  it('validates input, public assets, and video tools with preserved causes', async () => {
    const testFixture = await fixture()
    const inputFile = join(testFixture.root, 'input-file')
    const publicFile = join(testFixture.root, 'public-file')
    await Promise.all([writeFile(inputFile, 'x'), writeFile(publicFile, 'x')])

    for (const options of [
      {
        inputDirectory: inputFile,
        publicDirectory: testFixture.publicDirectory,
      },
      { inputDirectory: testFixture.input, publicDirectory: publicFile },
    ]) {
      await expect(
        startStudio({
          ...options,
          outputDirectory: testFixture.output,
          port: 0,
        }),
      ).rejects.toMatchObject({
        name: 'StudioServerError',
        message: expect.stringMatching(/^Cannot start video studio:/u),
        cause: expect.any(Error),
      })
    }

    const emptyPublic = join(testFixture.root, 'empty-public')
    await mkdir(emptyPublic)
    await expect(
      startStudio({
        inputDirectory: testFixture.input,
        outputDirectory: testFixture.output,
        publicDirectory: emptyPublic,
        port: 0,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Cannot start video studio:.*ENOENT/u),
      cause: expect.any(Error),
    })

    serverState.checkFailure = new Error('tools unavailable')
    await expect(
      startStudio({
        inputDirectory: testFixture.input,
        outputDirectory: testFixture.output,
        publicDirectory: testFixture.publicDirectory,
        port: 0,
      }),
    ).rejects.toMatchObject({
      name: 'StudioServerError',
      message: 'Cannot start video studio: tools unavailable',
      cause: serverState.checkFailure,
    })
  })

  it('serves every allowlisted static asset with GET and HEAD semantics', async () => {
    const studio = await start(await fixture())
    for (const [path, contentType] of [
      ['/', 'text/html; charset=utf-8'],
      ['/styles.css', 'text/css; charset=utf-8'],
      ['/app.js', 'text/javascript; charset=utf-8'],
      ['/editor.js', 'text/javascript; charset=utf-8'],
      ['/crop.js', 'text/javascript; charset=utf-8'],
      ['/dom.js', 'text/javascript; charset=utf-8'],
    ]) {
      const get = await fetch(`${studio.url}${path}`)
      expect(get.status).toBe(200)
      expect(get.headers.get('content-type')).toBe(contentType)
      expect((await get.text()).length).toBeGreaterThan(0)
      const head = await fetch(`${studio.url}${path}`, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
    }
  })

  it('returns exact errors for URL, method, trust, and route violations', async () => {
    const studio = await start(await fixture())
    const missingUrl = await invokeCaptured(studio, { method: 'GET' })
    expect(missingUrl.writeHead).toHaveBeenCalledWith(
      400,
      expect.objectContaining({
        'content-type': 'application/json; charset=utf-8',
      }),
    )
    expect(JSON.parse(missingUrl.end.mock.calls[0]?.[0].toString())).toEqual({
      error: 'Request URL is missing',
    })

    const invalidUrl = await invokeCaptured(studio, {
      method: 'GET',
      url: 'http://%',
    })
    expect(JSON.parse(invalidUrl.end.mock.calls[0]?.[0].toString())).toEqual({
      error: 'Request URL is invalid',
    })

    const missingMethod = await invokeCaptured(studio, { url: '/api/videos' })
    expect(JSON.parse(missingMethod.end.mock.calls[0]?.[0].toString())).toEqual(
      {
        error: 'Method not allowed',
      },
    )

    const unknown = await fetch(`${studio.url}/unknown`)
    expect(unknown.status).toBe(404)
    await expect(unknown.json()).resolves.toEqual({ error: 'Unknown route' })

    const foreignSite = await fetch(`${studio.url}/api/videos`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(foreignSite.status).toBe(403)
    await expect(foreignSite.json()).resolves.toEqual({
      error: 'Cross-site requests are not allowed',
    })
  })

  it('accepts normalized JSON content types and rejects all other forms', async () => {
    const studio = await start(await fixture())
    const accepted = await postExport(
      studio,
      validEdit,
      ' Application/JSON ; charset=utf-8',
    )
    expect(accepted.status).toBe(202)
    const acceptedBody = (await accepted.json()) as { id: string }
    await expect(waitForJob(studio, acceptedBody.id)).resolves.toMatchObject({
      status: 'complete',
    })

    for (const contentType of ['text/plain', 'application/json-patch+json']) {
      const rejected = await postExport(studio, validEdit, contentType)
      expect(rejected.status).toBe(415)
      await expect(rejected.json()).resolves.toEqual({
        error: 'Content-Type must be application/json',
      })
    }
    const absent = await fetch(`${studio.url}/api/exports`, {
      method: 'POST',
      headers: { origin: studio.url },
      body: JSON.stringify(validEdit),
    })
    expect(absent.status).toBe(415)
  })

  it.each([null, [], {}, { source: 1 }])(
    'rejects malformed export source %# and releases the export lock',
    async (body) => {
      const studio = await start(await fixture())
      const rejected = await postExport(studio, body)
      expect(rejected.status).toBe(400)
      await expect(rejected.json()).resolves.toEqual({
        error: 'source must be a single file name',
      })
      expect((await postExport(studio, validEdit)).status).toBe(202)
    },
  )

  it('maps file errors and unexpected failures to stable statuses', async () => {
    const studio = await start(await fixture())
    serverState.probeFailure = new VideoFileError(
      'video does not exist: missing.mp4',
    )
    const missing = await fetch(`${studio.url}/api/video?name=missing.mp4`)
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({
      error: 'video does not exist: missing.mp4',
    })

    serverState.probeFailure = new VideoFileError('unsupported video')
    expect((await fetch(`${studio.url}/api/video?name=bad.mov`)).status).toBe(
      400,
    )

    serverState.probeFailure = undefined
    serverState.listFailure = 'primitive failure'
    const unexpected = await fetch(`${studio.url}/api/videos`)
    expect(unexpected.status).toBe(500)
    await expect(unexpected.json()).resolves.toEqual({
      error: 'Unexpected video processing error',
    })
  })

  it('rejects preview paths outside the private cache', async () => {
    const testFixture = await fixture()
    const studio = await start(testFixture)
    serverState.previewPath = join(testFixture.root, 'outside.mp4')
    await writeFile(serverState.previewPath, 'outside')
    const response = await fetch(`${studio.url}/api/preview?name=clip.mp4`)
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Preview renderer returned a file outside its cache',
    })
  })

  it.each([
    { progress: -1, expected: 0 },
    { progress: 2, expected: 1 },
    { progress: Number.NaN, expected: 0 },
  ])('bounds running export progress %#', async ({ progress, expected }) => {
    let finish!: (value: unknown) => void
    serverState.renderPromise = new Promise((resolveRender) => {
      finish = resolveRender
    })
    serverState.renderProgress = [progress]
    const studio = await start(await fixture())
    const accepted = await postExport(studio, validEdit)
    const { id } = (await accepted.json()) as { id: string }
    const running = await fetch(`${studio.url}/api/exports/${id}`)
    await expect(running.json()).resolves.toMatchObject({
      status: 'running',
      progress: expected,
    })
    finish({
      name: 'result.mp4',
      duration: 1,
      width: 320,
      height: 240,
      size: 1,
    })
    await waitForJob(studio, id)
  })

  it('rejects concurrent exports, records non-Error render failures, and unlocks', async () => {
    let fail!: (reason: unknown) => void
    serverState.renderPromise = new Promise((_resolveRender, rejectRender) => {
      fail = rejectRender
    })
    const studio = await start(await fixture())
    const first = await postExport(studio, validEdit)
    const { id } = (await first.json()) as { id: string }
    const conflict = await postExport(studio, {
      ...validEdit,
      outputName: 'second.mp4',
    })
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toEqual({
      error: 'An export is already running',
    })
    fail('render exploded')
    await expect(waitForJob(studio, id)).resolves.toMatchObject({
      status: 'failed',
      error: 'Unexpected video processing error',
    })

    serverState.renderPromise = undefined
    expect(
      (await postExport(studio, { ...validEdit, outputName: 'third.mp4' }))
        .status,
    ).toBe(202)
  })

  it('keeps at most 30 completed export jobs', async () => {
    const studio = await start(await fixture())
    const ids: string[] = []
    for (let index = 0; index < 32; index += 1) {
      const accepted = await postExport(studio, {
        ...validEdit,
        outputName: `result-${index}.mp4`,
      })
      const { id } = (await accepted.json()) as { id: string }
      ids.push(id)
      await waitForJob(studio, id)
    }
    expect((await fetch(`${studio.url}/api/exports/${ids[0]}`)).status).toBe(
      404,
    )
    expect((await fetch(`${studio.url}/api/exports/${ids[1]}`)).status).toBe(
      404,
    )
    expect((await fetch(`${studio.url}/api/exports/${ids[2]}`)).status).toBe(
      200,
    )
  })

  it('waits for the active render and returns one idempotent close promise', async () => {
    let finish!: (value: unknown) => void
    serverState.renderPromise = new Promise((resolveRender) => {
      finish = resolveRender
    })
    const studio = await start(await fixture())
    const accepted = await postExport(studio, validEdit)
    expect(accepted.status).toBe(202)
    const firstClose = studio.close()
    const secondClose = studio.close()
    expect(secondClose).toBe(firstClose)
    let closed = false
    void firstClose.then(() => {
      closed = true
    })
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10))
    expect(closed).toBe(false)
    finish({
      name: 'result.mp4',
      duration: 1,
      width: 320,
      height: 240,
      size: 1,
    })
    await expect(firstClose).resolves.toBeUndefined()
    expect(closed).toBe(true)
  })

  it('destroys a response when a failure occurs after headers are sent', async () => {
    const studio = await start(await fixture())
    serverState.listFailure = new Error('late failure')
    const captured = await invokeCaptured(studio, {
      method: 'GET',
      url: '/api/videos',
      headersSent: true,
    })
    expect(captured.destroy).toHaveBeenCalledWith(serverState.listFailure)
    expect(captured.writeHead).not.toHaveBeenCalled()
    expect(captured.end).not.toHaveBeenCalled()
  })

  it('returns response hardening headers for API errors', async () => {
    const studio = await start(await fixture())
    const response = await rawRequest(`${studio.url}/unknown`)
    expect(response.status).toBe(404)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    )
    expect(JSON.parse(response.body)).toEqual({ error: 'Unknown route' })
  })
})

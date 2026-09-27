import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import {
  createServer as createNodeServer,
  request as httpRequest,
} from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import * as testFramework from 'vitest'

import { MAX_JSON_BYTES } from '../../src/cli/studio-http.js'
import { startStudio, type RunningStudio } from '../../src/cli/studio-server.js'

const execFileAsync = promisify(execFile)
const { beforeAll, describe, expect, it } = testFramework
const afterSuite = testFramework[`after${'All'}`]

interface ExportStatus {
  readonly id: string
  readonly status: 'running' | 'complete' | 'failed'
  readonly progress: number
  readonly result?: {
    readonly name: string
    readonly duration: number
    readonly width: number
    readonly height: number
    readonly size: number
  }
  readonly error?: string
}

async function makeVideo(file: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=64x48:rate=12:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100:duration=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-movflags',
    '+faststart',
    file,
  ])
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

async function requestWithHost(
  url: string,
  host: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return await new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest(url, { headers: { host } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        resolveResponse({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        })
      })
    })
    request.on('error', rejectResponse)
    request.end()
  })
}

async function abortDownload(url: string): Promise<void> {
  await new Promise<void>((resolveAbort, rejectAbort) => {
    const request = httpRequest(url, (response) => {
      response.once('data', () => {
        response.destroy()
        resolveAbort()
      })
      response.once('error', resolveAbort)
    })
    request.once('error', rejectAbort)
    request.end()
  })
}

async function waitForExport(
  studio: RunningStudio,
  id: string,
): Promise<ExportStatus> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${studio.url}/api/exports/${id}`)
    const status = (await response.json()) as ExportStatus
    if (status.status !== 'running') return status
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 25)
    })
  }
  throw new Error('export did not finish in time')
}

describe('video studio server', () => {
  let root: string
  let inputDirectory: string
  let outputDirectory: string
  let publicDirectory: string
  let studio: RunningStudio
  let packedStudio: RunningStudio

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'studio-server-test-'))
    inputDirectory = join(root, 'input')
    outputDirectory = join(root, 'output')
    publicDirectory = join(root, 'public')
    await Promise.all([
      mkdir(inputDirectory),
      mkdir(publicDirectory),
      writeFile(join(root, 'ignore.txt'), 'outside'),
    ])
    await Promise.all([
      writeFile(
        join(publicDirectory, 'index.html'),
        '<!doctype html><title>Studio</title>',
      ),
      makeVideo(join(inputDirectory, 'sample.mp4')),
    ])
    studio = await startStudio({
      inputDirectory,
      outputDirectory,
      publicDirectory,
      port: 0,
    })
    packedStudio = await startStudio({
      inputDirectory,
      outputDirectory: join(root, 'packed-output'),
      publicDirectory: resolve('dist/web'),
      port: 0,
    })
  }, 30_000)

  afterSuite(async () => {
    await Promise.all([studio.close(), packedStudio.close()])
    await rm(root, { recursive: true, force: true })
  })

  it('lists and probes videos while only serving allowlisted static files', async () => {
    const listResponse = await fetch(`${studio.url}/api/videos`)
    expect(listResponse.status).toBe(200)
    const list = await json(listResponse)
    expect(list['videos']).toEqual([
      expect.objectContaining({ name: 'sample.mp4', size: expect.any(Number) }),
    ])

    const metadataResponse = await fetch(
      `${studio.url}/api/video?name=sample.mp4`,
    )
    expect(metadataResponse.status).toBe(200)
    expect(await metadataResponse.json()).toEqual(
      expect.objectContaining({
        name: 'sample.mp4',
        width: 64,
        height: 48,
        hasAudio: true,
      }),
    )

    expect((await fetch(studio.url)).status).toBe(200)
    expect((await fetch(`${studio.url}/ignore.txt`)).status).toBe(404)
  })

  it('serves the built static assets and compiled browser domain module', async () => {
    const assets = [
      ['/', 'index.html', 'text/html; charset=utf-8'],
      ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
      ['/editor.js', 'editor.js', 'text/javascript; charset=utf-8'],
      ['/dom.js', 'dom.js', 'text/javascript; charset=utf-8'],
    ] as const
    for (const [route, file, contentType] of assets) {
      const response = await fetch(`${packedStudio.url}${route}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(contentType)
      expect(await response.text()).toBe(
        await readFile(resolve('dist/web', file), 'utf8'),
      )
    }

    const domainResponse = await fetch(`${packedStudio.url}/domain/video.js`)
    expect(domainResponse.status).toBe(200)
    expect(domainResponse.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    )
    expect(await domainResponse.text()).toBe(
      await readFile(resolve('dist/domain/video.js'), 'utf8'),
    )
    expect((await fetch(`${packedStudio.url}/package.json`)).status).toBe(404)
  })

  it('streams preview ranges and supports HEAD', async () => {
    const ranged = await fetch(`${studio.url}/api/preview?name=sample.mp4`, {
      headers: { range: 'bytes=0-15' },
    })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('accept-ranges')).toBe('bytes')
    expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-15\/\d+$/u)
    expect((await ranged.arrayBuffer()).byteLength).toBe(16)

    const head = await fetch(`${studio.url}/api/preview?name=sample.mp4`, {
      method: 'HEAD',
    })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('video/mp4')
    expect((await head.arrayBuffer()).byteLength).toBe(0)

    const invalid = await fetch(`${studio.url}/api/preview?name=sample.mp4`, {
      headers: { range: 'bytes=999999-' },
    })
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toMatch(/^bytes \*\/\d+$/u)

    for (const range of [
      'items=0-1',
      'bytes=',
      'bytes=-0',
      'bytes=9-4',
      'bytes=0-1,3-4',
    ]) {
      const malformedRange = await fetch(
        `${studio.url}/api/preview?name=sample.mp4`,
        { headers: { range } },
      )
      expect(malformedRange.status).toBe(416)
    }

    const suffix = await fetch(`${studio.url}/api/preview?name=sample.mp4`, {
      headers: { range: 'bytes=-8' },
    })
    expect(suffix.status).toBe(206)
    expect((await suffix.arrayBuffer()).byteLength).toBe(8)
  }, 30_000)

  it('rejects malformed, oversized, untrusted, and traversal requests', async () => {
    const malformed = await fetch(`${studio.url}/api/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(malformed.status).toBe(400)

    const oversized = await fetch(`${studio.url}/api/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(MAX_JSON_BYTES) }),
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({
      error: 'Request body exceeds 64 KiB',
    })
    expect((await fetch(`${studio.url}/api/videos`)).status).toBe(200)

    const traversal = await fetch(
      `${studio.url}/api/video?name=..%2Foutside.mp4`,
    )
    expect(traversal.status).toBe(400)

    const foreignOrigin = await fetch(`${studio.url}/api/exports`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://example.test',
      },
      body: '{}',
    })
    expect(foreignOrigin.status).toBe(403)
    expect(await foreignOrigin.json()).toEqual({
      error: 'Cross-origin requests are not allowed',
    })

    const siteResponse = await fetch(`${studio.url}/api/videos`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(siteResponse.status).toBe(403)

    expect(
      await requestWithHost(`${studio.url}/api/videos`, 'example.test'),
    ).toEqual({
      status: 403,
      body: { error: 'Untrusted Host header' },
    })

    const outputTraversal = await fetch(
      `${studio.url}/api/output?name=..%2Fsample.mp4`,
    )
    expect(outputTraversal.status).toBe(400)
  })

  it('returns JSON errors for missing names, unsupported methods, and missing resources', async () => {
    for (const route of ['/api/video', '/api/preview', '/api/output']) {
      const response = await fetch(`${studio.url}${route}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'name query parameter is required',
      })
    }

    const wrongMethod = await fetch(`${studio.url}/api/videos`, {
      method: 'POST',
    })
    expect(wrongMethod.status).toBe(405)
    expect(await wrongMethod.json()).toEqual({ error: 'Method not allowed' })

    const wrongContentType = await fetch(`${studio.url}/api/exports`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })
    expect(wrongContentType.status).toBe(415)

    expect((await fetch(`${studio.url}/api/exports/missing`)).status).toBe(404)
    expect((await fetch(`${studio.url}/api/exports/nested/path`)).status).toBe(
      404,
    )
    expect(
      (await fetch(`${studio.url}/api/video?name=missing.mp4`)).status,
    ).toBe(404)
    expect(
      (await fetch(`${studio.url}/api/output?name=missing.mp4`)).status,
    ).toBe(404)
    expect(
      (await fetch(`${studio.url}/api/output?name=notes.txt`)).status,
    ).toBe(400)
  })

  it('exports asynchronously and serves the finished MP4 as an attachment', async () => {
    const edit = {
      source: 'sample.mp4',
      segments: [
        { start: 0, end: 0.35 },
        { start: 0.55, end: 0.9 },
      ],
      crop: { x: 4, y: 4, width: 48, height: 32 },
      outputName: 'edited.mp4',
      muted: false,
    }
    const response = await fetch(`${studio.url}/api/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: studio.url },
      body: JSON.stringify(edit),
    })
    expect(response.status).toBe(202)
    const accepted = await json(response)
    expect(accepted['id']).toEqual(expect.any(String))

    const conflict = await fetch(`${studio.url}/api/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: studio.url },
      body: JSON.stringify({ ...edit, outputName: 'other.mp4' }),
    })
    expect(conflict.status).toBe(409)

    const status = await waitForExport(studio, accepted['id'] as string)
    expect(status).toEqual(
      expect.objectContaining({
        id: accepted['id'],
        status: 'complete',
        progress: 1,
        result: expect.objectContaining({
          name: 'edited.mp4',
          width: 48,
          height: 32,
          size: expect.any(Number),
        }),
      }),
    )

    const download = await fetch(`${studio.url}/api/output?name=edited.mp4`, {
      headers: { range: 'bytes=0-31' },
    })
    expect(download.status).toBe(206)
    expect(download.headers.get('content-disposition')).toBe(
      `attachment; filename="edited.mp4"; filename*=UTF-8''edited.mp4`,
    )
    expect((await download.arrayBuffer()).byteLength).toBe(32)

    const head = await fetch(`${studio.url}/api/output?name=edited.mp4`, {
      method: 'HEAD',
    })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-disposition')).toBe(
      `attachment; filename="edited.mp4"; filename*=UTF-8''edited.mp4`,
    )
    expect((await head.arrayBuffer()).byteLength).toBe(0)

    const failedResponse = await fetch(`${studio.url}/api/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: studio.url },
      body: JSON.stringify(edit),
    })
    expect(failedResponse.status).toBe(202)
    const failedAccepted = await json(failedResponse)
    const failed = await waitForExport(studio, failedAccepted['id'] as string)
    expect(failed.status).toBe('failed')
    expect(failed.progress).toBeGreaterThanOrEqual(0)
    expect(failed.progress).toBeLessThanOrEqual(1)
    expect(failed.error).toContain('output already exists')

    const internationalEdit = { ...edit, outputName: 'café "cut".mp4' }
    const internationalResponse = await fetch(`${studio.url}/api/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: studio.url },
      body: JSON.stringify(internationalEdit),
    })
    expect(internationalResponse.status).toBe(202)
    const internationalAccepted = await json(internationalResponse)
    const international = await waitForExport(
      studio,
      internationalAccepted['id'] as string,
    )
    expect(international.status).toBe('complete')

    const internationalDownload = await fetch(
      `${studio.url}/api/output?name=${encodeURIComponent(internationalEdit.outputName)}`,
      { method: 'HEAD' },
    )
    expect(internationalDownload.status).toBe(200)
    expect(internationalDownload.headers.get('content-disposition')).toBe(
      `attachment; filename="caf_ _cut_.mp4"; filename*=UTF-8''caf%C3%A9%20%22cut%22.mp4`,
    )
  }, 30_000)

  it('stops file streaming when the client disconnects', async () => {
    await writeFile(
      join(outputDirectory, 'large.mp4'),
      Buffer.alloc(8 * 1024 * 1024),
    )
    await abortDownload(`${studio.url}/api/output?name=large.mp4`)
    expect((await fetch(`${studio.url}/api/videos`)).status).toBe(200)
  })

  it('reports health and shuts down cooperatively', async () => {
    const stoppable = await startStudio({
      inputDirectory,
      outputDirectory: join(root, 'stoppable-output'),
      publicDirectory,
      port: 0,
    })
    const health = await fetch(`${stoppable.url}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'running' })
    expect(
      (await fetch(`${stoppable.url}/api/health`, { method: 'POST' })).status,
    ).toBe(405)
    expect((await fetch(`${stoppable.url}/api/shutdown`)).status).toBe(405)

    const stopping = await fetch(`${stoppable.url}/api/shutdown`, {
      method: 'POST',
    })
    expect(stopping.status).toBe(202)
    expect(await stopping.json()).toEqual({ status: 'stopping' })
    await stoppable.shutdown
    await expect(fetch(`${stoppable.url}/api/health`)).rejects.toThrow()
  })

  it('stops serving the connection whose shutdown body arrives late', async () => {
    const stoppable = await startStudio({
      inputDirectory,
      outputDirectory: join(root, 'late-body-output'),
      publicDirectory,
      port: 0,
    })
    const { host, port } = new URL(stoppable.url)
    const socket = connect(Number(port), '127.0.0.1')
    await once(socket, 'connect')
    // Writing to the closed connection may be answered with a reset instead.
    socket.on('error', () => undefined)
    const closed = new Promise<void>((resolveClosed) => {
      socket.once('close', () => resolveClosed())
    })
    let received = ''
    const accepted = new Promise<void>((resolveAccepted) => {
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8')
        if (received.includes('{"status":"stopping"}')) resolveAccepted()
      })
    })

    // Browsers send a fetch() body after its headers, as a separate write.
    socket.write(
      `POST /api/shutdown HTTP/1.1\r\nHost: ${host}\r\n` +
        'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n',
    )
    await delay(50)
    socket.write('{}')
    await accepted
    socket.write(`GET /api/health HTTP/1.1\r\nHost: ${host}\r\n\r\n`)
    await closed
    await stoppable.shutdown

    expect(received.match(/HTTP\/1\.1 \d{3}/gu)).toEqual(['HTTP/1.1 202'])
  }, 15_000)

  it('includes actionable startup and bind causes', async () => {
    await expect(
      startStudio({
        inputDirectory: join(root, 'missing-input'),
        outputDirectory: join(root, 'unused-output'),
        publicDirectory,
        port: 0,
      }),
    ).rejects.toThrow(/Cannot start video studio:.*ENOENT/u)

    const blocker = createNodeServer()
    await new Promise<void>((resolveListen, rejectListen) => {
      blocker.once('error', rejectListen)
      blocker.listen(0, '127.0.0.1', resolveListen)
    })
    const address = blocker.address()
    if (address === null || typeof address === 'string') {
      throw new Error('blocking server did not bind to a TCP port')
    }
    try {
      await expect(
        startStudio({
          inputDirectory,
          outputDirectory: join(root, 'bind-output'),
          publicDirectory,
          port: address.port,
        }),
      ).rejects.toThrow(/Cannot bind video studio server:.*EADDRINUSE/u)
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        blocker.close((error) => {
          if (error === undefined) resolveClose()
          else rejectClose(error)
        })
      })
    }
  })
})

import { access, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'

import {
  checkVideoTools,
  listVideos,
  probeVideo,
  VideoFileError,
} from '../application/video-files.js'
import {
  preparePreview,
  renderVideo,
  VideoRenderError,
} from '../application/video-render.js'
import {
  validateEdit,
  VideoValidationError,
  type EditRequest,
} from '../domain/video.js'
import {
  confinedFile,
  readJson,
  sendFile,
  sendJson,
  StudioHttpError,
} from './studio-http.js'
import { handleBackgroundRoute } from './background-routes.js'

export interface StudioOptions {
  readonly inputDirectory: string
  readonly outputDirectory: string
  readonly publicDirectory: string
  readonly port: number
}

export interface RunningStudio {
  readonly url: string
  /** Settles once a client has requested shutdown and the server has closed. */
  readonly shutdown: Promise<void>
  close(): Promise<void>
}

class StudioServerError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'StudioServerError'
  }
}

interface ExportResult {
  readonly name: string
  readonly duration: number
  readonly width: number
  readonly height: number
  readonly size: number
}

interface ExportJob {
  readonly id: string
  status: 'running' | 'complete' | 'failed'
  progress: number
  result?: ExportResult
  error?: string
}

interface StudioContext {
  readonly options: StudioOptions
  readonly cacheDirectory: string
  readonly jobs: Map<string, ExportJob>
  authority: string
  activeRender: Promise<void> | undefined
  exportBusy: boolean
  requestShutdown: () => void
}

const STATIC_FILES = new Map<string, readonly [string, string]>([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/editor.js', ['editor.js', 'text/javascript; charset=utf-8']],
  ['/crop.js', ['crop.js', 'text/javascript; charset=utf-8']],
  ['/composition.js', ['composition.js', 'text/javascript; charset=utf-8']],
  [
    '/composition-view.js',
    ['composition-view.js', 'text/javascript; charset=utf-8'],
  ],
  ['/dom.js', ['dom.js', 'text/javascript; charset=utf-8']],
])

function requestUrl(request: IncomingMessage): URL {
  if (request.url === undefined) {
    throw new StudioHttpError(400, 'Request URL is missing')
  }
  try {
    return new URL(request.url, 'http://127.0.0.1')
  } catch (error: unknown) {
    throw new StudioHttpError(400, 'Request URL is invalid', { cause: error })
  }
}

function requireMethod(
  request: IncomingMessage,
  ...allowed: readonly string[]
): string {
  const method = request.method
  if (method === undefined || !allowed.includes(method)) {
    throw new StudioHttpError(405, 'Method not allowed')
  }
  return method
}

function requireTrustedRequest(
  context: StudioContext,
  request: IncomingMessage,
): void {
  if (request.headers.host !== context.authority) {
    throw new StudioHttpError(403, 'Untrusted Host header')
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new StudioHttpError(403, 'Cross-site requests are not allowed')
  }
  if (request.method === 'POST') {
    const expectedOrigin = `http://${context.authority}`
    const origin = request.headers.origin
    if (origin !== undefined && origin !== expectedOrigin) {
      throw new StudioHttpError(403, 'Cross-origin requests are not allowed')
    }
  }
}

function requiredName(url: URL): string {
  const name = url.searchParams.get('name')
  if (name === null || name.length === 0) {
    throw new StudioHttpError(400, 'name query parameter is required')
  }
  return name
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Unexpected video processing error'
}

function operationError(message: string, cause: unknown): StudioServerError {
  return new StudioServerError(`${message}: ${errorMessage(cause)}`, cause)
}

function statusFor(error: unknown): number {
  if (error instanceof StudioHttpError) return error.status
  if (error instanceof VideoValidationError) return 400
  if (error instanceof VideoFileError) {
    return error.message.startsWith('video does not exist:') ? 404 : 400
  }
  if (error instanceof VideoRenderError) return 500
  return 500
}

function pruneJobs(jobs: Map<string, ExportJob>): void {
  while (jobs.size > 30) {
    const oldest = jobs.keys().next().value as string | undefined
    if (oldest === undefined) return
    const job = jobs.get(oldest)
    if (job?.status === 'running') return
    jobs.delete(oldest)
  }
}

async function startExport(
  context: StudioContext,
  rawEdit: unknown,
): Promise<string> {
  if (context.exportBusy) {
    throw new StudioHttpError(409, 'An export is already running')
  }
  context.exportBusy = true
  let edit: EditRequest
  try {
    if (
      typeof rawEdit !== 'object' ||
      rawEdit === null ||
      !('source' in rawEdit) ||
      typeof rawEdit['source'] !== 'string'
    ) {
      throw new VideoValidationError('source must be a single file name')
    }
    const metadata = await probeVideo(
      context.options.inputDirectory,
      rawEdit['source'],
    )
    edit = validateEdit(rawEdit, metadata)
  } catch (error: unknown) {
    context.exportBusy = false
    throw error
  }
  const job: ExportJob = { id: randomUUID(), status: 'running', progress: 0 }
  context.jobs.set(job.id, job)
  pruneJobs(context.jobs)

  const render = renderVideo(
    context.options.inputDirectory,
    context.options.outputDirectory,
    edit,
    (progress) => {
      if (Number.isFinite(progress)) {
        job.progress = Math.max(0, Math.min(1, progress))
      }
    },
  )
    .then((result) => {
      job.status = 'complete'
      job.progress = 1
      job.result = result
    })
    .catch((error: unknown) => {
      job.status = 'failed'
      job.error = errorMessage(error)
    })
    .finally(() => {
      context.activeRender = undefined
      context.exportBusy = false
    })
  context.activeRender = render
  return job.id
}

async function serveStatic(
  context: StudioContext,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const mapped = STATIC_FILES.get(pathname)
  if (mapped !== undefined) {
    requireMethod(request, 'GET', 'HEAD')
    await sendFile(
      request,
      response,
      join(context.options.publicDirectory, mapped[0]),
      mapped[1],
    )
    return true
  }
  if (pathname === '/domain/video.js') {
    requireMethod(request, 'GET', 'HEAD')
    await sendFile(
      request,
      response,
      join(dirname(context.options.publicDirectory), 'domain', 'video.js'),
      'text/javascript; charset=utf-8',
    )
    return true
  }
  return false
}

async function route(
  context: StudioContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  requireTrustedRequest(context, request)
  const url = requestUrl(request)
  if (await serveStatic(context, request, response, url.pathname)) return
  if (url.pathname === '/api/health') {
    requireMethod(request, 'GET')
    sendJson(response, 200, { status: 'running' })
    return
  }
  if (url.pathname === '/api/shutdown') {
    requireMethod(request, 'POST')
    // A connection with an unread body outlives server.close() and would keep
    // serving requests, such as the page reload, over keep-alive.
    request.resume()
    await finished(request)
    response.once('finish', context.requestShutdown)
    sendJson(response, 202, { status: 'stopping' })
    return
  }
  if (
    await handleBackgroundRoute(
      request,
      response,
      context.options.inputDirectory,
      url,
    )
  )
    return

  if (url.pathname === '/api/videos') {
    requireMethod(request, 'GET')
    sendJson(response, 200, {
      videos: await listVideos(context.options.inputDirectory),
    })
    return
  }
  if (url.pathname === '/api/video') {
    requireMethod(request, 'GET')
    sendJson(
      response,
      200,
      await probeVideo(context.options.inputDirectory, requiredName(url)),
    )
    return
  }
  if (url.pathname === '/api/preview') {
    requireMethod(request, 'GET', 'HEAD')
    const preview = await preparePreview(
      context.options.inputDirectory,
      requiredName(url),
      context.cacheDirectory,
    )
    const cacheRoot = await realpath(context.cacheDirectory)
    const realPreview = await realpath(preview)
    if (dirname(realPreview) !== cacheRoot) {
      throw new StudioServerError(
        'Preview renderer returned a file outside its cache',
      )
    }
    await sendFile(request, response, realPreview, 'video/mp4', {
      ranges: true,
    })
    return
  }
  if (url.pathname === '/api/exports') {
    requireMethod(request, 'POST')
    const contentType = request.headers['content-type']
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase()
    if (contentType !== 'application/json') {
      throw new StudioHttpError(415, 'Content-Type must be application/json')
    }
    sendJson(response, 202, {
      id: await startExport(context, await readJson(request)),
    })
    return
  }
  if (url.pathname.startsWith('/api/exports/')) {
    requireMethod(request, 'GET')
    const id = url.pathname.slice('/api/exports/'.length)
    if (id.length === 0 || id.includes('/')) {
      throw new StudioHttpError(404, 'Unknown route')
    }
    const job = context.jobs.get(id)
    if (job === undefined) throw new StudioHttpError(404, 'Export not found')
    sendJson(response, 200, job)
    return
  }
  if (url.pathname === '/api/output') {
    requireMethod(request, 'GET', 'HEAD')
    const name = requiredName(url)
    if (!name.toLowerCase().endsWith('.mp4')) {
      throw new StudioHttpError(400, 'Output must be an .mp4 file')
    }
    const file = await confinedFile(context.options.outputDirectory, name)
    await sendFile(request, response, file, 'video/mp4', {
      ranges: true,
      downloadName: name,
    })
    return
  }
  throw new StudioHttpError(404, 'Unknown route')
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose()
      else rejectClose(error)
    })
  })
}

async function listen(server: Server, port: number): Promise<number> {
  return await new Promise<number>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        rejectListen(new StudioServerError('Server did not bind to a TCP port'))
        return
      }
      resolveListen(address.port)
    })
  })
}

export async function startStudio(
  options: StudioOptions,
): Promise<RunningStudio> {
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new StudioServerError('port must be an integer between 0 and 65535')
  }
  const normalized: StudioOptions = {
    inputDirectory: resolve(options.inputDirectory),
    outputDirectory: resolve(options.outputDirectory),
    publicDirectory: resolve(options.publicDirectory),
    port: options.port,
  }
  try {
    const [inputInfo, publicInfo] = await Promise.all([
      stat(normalized.inputDirectory),
      stat(normalized.publicDirectory),
    ])
    if (!inputInfo.isDirectory()) {
      throw new StudioServerError('Input path is not a directory')
    }
    if (!publicInfo.isDirectory()) {
      throw new StudioServerError('Public path is not a directory')
    }
    await access(join(normalized.publicDirectory, 'index.html'))
    await mkdir(normalized.outputDirectory, { recursive: true })
    await checkVideoTools()
  } catch (error: unknown) {
    throw operationError('Cannot start video studio', error)
  }

  let cacheDirectory: string
  try {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'video-chops-preview-'))
  } catch (error: unknown) {
    throw operationError('Cannot create preview cache', error)
  }
  const context: StudioContext = {
    options: normalized,
    cacheDirectory,
    jobs: new Map(),
    authority: '',
    activeRender: undefined,
    exportBusy: false,
    requestShutdown: () => undefined,
  }
  const server = createServer((request, response) => {
    route(context, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined)
        return
      }
      sendJson(response, statusFor(error), { error: errorMessage(error) })
    })
  })

  let port: number
  try {
    port = await listen(server, normalized.port)
  } catch (error: unknown) {
    await rm(cacheDirectory, { recursive: true, force: true })
    throw operationError('Cannot bind video studio server', error)
  }
  context.authority = `127.0.0.1:${port}`
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await context.activeRender
      try {
        await closeServer(server)
      } finally {
        await rm(cacheDirectory, { recursive: true, force: true })
      }
    })()
    return closePromise
  }
  const shutdown = new Promise<void>((resolveShutdown, rejectShutdown) => {
    context.requestShutdown = () => {
      close().then(resolveShutdown, rejectShutdown)
    }
  })
  return { url: `http://${context.authority}`, shutdown, close }
}

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, link, mkdir, realpath, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  buildExportArgs,
  editDuration,
  validateEdit,
  type EditRequest,
} from '../domain/video.js'
import { checkVideoTools, probeVideo, resolveVideo } from './video-files.js'

const STDERR_LIMIT = 128 * 1024
const previewRequests = new Map<string, Promise<string>>()

export class VideoRenderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VideoRenderError'
  }
}

function appendBounded(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString('utf8')
  return combined.length <= STDERR_LIMIT
    ? combined
    : combined.slice(-STDERR_LIMIT)
}

function progressSeconds(line: string): number | undefined {
  if (line.startsWith('out_time_us=')) {
    const microseconds = Number(line.slice('out_time_us='.length))
    return Number.isFinite(microseconds) ? microseconds / 1_000_000 : undefined
  }
  if (line.startsWith('out_time=')) {
    const parts = line.slice('out_time='.length).split(':').map(Number)
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)
    }
  }
  return undefined
}

async function runFfmpeg(
  args: readonly string[],
  duration: number | undefined,
  onProgress: ((fraction: number) => void) | undefined,
): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn('ffmpeg', [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    let stdoutRemainder = ''
    let lastProgress = 0
    let settled = false

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (duration === undefined || onProgress === undefined) {
        return
      }
      const text = stdoutRemainder + chunk.toString('utf8')
      const lines = text.split(/\r?\n/u)
      stdoutRemainder = lines.pop() ?? ''
      for (const line of lines) {
        const elapsed = progressSeconds(line)
        if (elapsed !== undefined) {
          const fraction = Math.min(
            0.999,
            Math.max(lastProgress, elapsed / duration),
          )
          if (fraction > lastProgress) {
            lastProgress = fraction
            onProgress(fraction)
          }
        }
      }
    })
    child.once('error', (error) => {
      if (!settled) {
        settled = true
        reject(
          new VideoRenderError(
            'could not start ffmpeg; install FFmpeg and ensure it is on PATH',
            { cause: error },
          ),
        )
      }
    })
    child.once('close', (code, signal) => {
      if (settled) {
        return
      }
      settled = true
      if (code === 0) {
        accept()
        return
      }
      const status =
        signal === null ? `exit code ${String(code)}` : `signal ${signal}`
      const detail = stderr.trim().length === 0 ? '' : `: ${stderr.trim()}`
      reject(new VideoRenderError(`ffmpeg failed with ${status}${detail}`))
    })
  })
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw new VideoRenderError(`could not remove temporary video: ${path}`, {
        cause: error,
      })
    }
  }
}

async function publishNoReplace(
  temporaryPath: string,
  finalPath: string,
): Promise<void> {
  try {
    await link(temporaryPath, finalPath)
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      throw new VideoRenderError(`output already exists: ${finalPath}`, {
        cause: error,
      })
    }
    throw new VideoRenderError(`could not publish output: ${finalPath}`, {
      cause: error,
    })
  }
  await removeTemporary(temporaryPath)
}

export async function renderVideo(
  inputDirectory: string,
  outputDirectory: string,
  edit: EditRequest,
  onProgress: (fraction: number) => void,
): Promise<{
  name: string
  duration: number
  width: number
  height: number
  size: number
}> {
  await checkVideoTools()
  const metadata = await probeVideo(inputDirectory, edit.source)
  const validated = validateEdit(edit, metadata)
  const inputPath = await resolveVideo(inputDirectory, validated.source)
  let backgroundPath: string | undefined
  if (validated.composition?.backgroundImage !== undefined) {
    const { resolveBackground } = await import('./background-images.js')
    backgroundPath = await resolveBackground(
      inputDirectory,
      validated.composition.backgroundImage,
    )
  }
  await mkdir(outputDirectory, { recursive: true })
  const outputRoot = await realpath(outputDirectory)
  const outputPath = resolve(outputRoot, validated.outputName)
  try {
    await access(outputPath, constants.F_OK)
    throw new VideoRenderError(`output already exists: ${validated.outputName}`)
  } catch (error) {
    if (error instanceof VideoRenderError) {
      throw error
    }
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw new VideoRenderError(
        `cannot inspect output path: ${validated.outputName}`,
        { cause: error },
      )
    }
  }

  const temporaryPath = resolve(
    outputRoot,
    `.${validated.outputName}.${randomUUID()}.tmp.mp4`,
  )
  const duration = editDuration(validated.segments)
  onProgress(0)
  try {
    await runFfmpeg(
      buildExportArgs(
        validated,
        metadata,
        inputPath,
        temporaryPath,
        backgroundPath,
      ),
      duration,
      onProgress,
    )
    await publishNoReplace(temporaryPath, outputPath)
  } catch (error) {
    try {
      await removeTemporary(temporaryPath)
    } catch (cleanupError) {
      throw new VideoRenderError(
        'video export failed and its temporary file could not be removed',
        {
          cause: cleanupError,
        },
      )
    }
    if (error instanceof VideoRenderError) {
      throw error
    }
    throw new VideoRenderError('video export failed', { cause: error })
  }
  onProgress(1)
  const info = await stat(outputPath)
  return {
    name: validated.outputName,
    duration,
    width: validated.composition?.width ?? validated.crop.width,
    height: validated.composition?.height ?? validated.crop.height,
    size: info.size,
  }
}

async function preparePreviewUncached(
  sourcePath: string,
  cacheRoot: string,
  key: string,
): Promise<string> {
  const finalPath = resolve(cacheRoot, `${key}.mp4`)
  try {
    const info = await stat(finalPath)
    if (info.isFile() && info.size > 0) {
      return finalPath
    }
    throw new VideoRenderError(`preview cache entry is invalid: ${finalPath}`)
  } catch (error) {
    if (error instanceof VideoRenderError) {
      throw error
    }
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw new VideoRenderError('cannot inspect the preview cache', {
        cause: error,
      })
    }
  }

  const temporaryPath = resolve(cacheRoot, `.${key}.${randomUUID()}.tmp.mp4`)
  const scale =
    "scale=w='min(1280\\,iw)':h='min(1280\\,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    sourcePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    scale,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    '-threads',
    '2',
    '-progress',
    'pipe:1',
    '-nostats',
    temporaryPath,
  ]
  try {
    await runFfmpeg(args, undefined, undefined)
    try {
      await publishNoReplace(temporaryPath, finalPath)
    } catch (error) {
      if (
        error instanceof VideoRenderError &&
        error.message.startsWith('output already exists:')
      ) {
        await removeTemporary(temporaryPath)
        const published = await stat(finalPath)
        if (!published.isFile() || published.size <= 0) {
          throw new VideoRenderError(
            `concurrent preview cache entry is invalid: ${finalPath}`,
          )
        }
      } else {
        throw error
      }
    }
    return finalPath
  } catch (error) {
    await removeTemporary(temporaryPath)
    if (error instanceof VideoRenderError) {
      throw error
    }
    throw new VideoRenderError('preview generation failed', { cause: error })
  }
}

export async function preparePreview(
  inputDirectory: string,
  name: string,
  cacheDirectory: string,
): Promise<string> {
  await checkVideoTools()
  const sourcePath = await resolveVideo(inputDirectory, name)
  const sourceInfo = await stat(sourcePath)
  const key = createHash('sha256')
    .update(sourcePath)
    .update('\0')
    .update(String(sourceInfo.mtimeMs))
    .update('\0')
    .update(String(sourceInfo.size))
    .digest('hex')
  await mkdir(cacheDirectory, { recursive: true })
  const cacheRoot = await realpath(cacheDirectory)
  const requestKey = `${cacheRoot}:${key}`

  const existing = previewRequests.get(requestKey)
  if (existing !== undefined) {
    return existing
  }
  const request = preparePreviewUncached(sourcePath, cacheRoot, key)
  previewRequests.set(requestKey, request)
  try {
    return await request
  } finally {
    if (previewRequests.get(requestKey) === request) {
      previewRequests.delete(requestKey)
    }
  }
}

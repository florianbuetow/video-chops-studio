import { execFile } from 'node:child_process'
import { readdir, realpath, stat } from 'node:fs/promises'
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'
import { promisify } from 'node:util'

import type { VideoFile, VideoMetadata } from '../domain/video.js'

const execFileAsync = promisify(execFile)
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.mkv',
  '.avi',
])
const PROBE_TIMEOUT_MS = 15_000
const PROBE_MAX_BUFFER = 2 * 1024 * 1024

export class VideoFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VideoFileError'
  }
}

function validateVideoName(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    basename(name) !== name ||
    name.includes('/') ||
    name.includes('\\') ||
    [...name].some((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code <= 31 || code === 127)
    })
  ) {
    throw new VideoFileError('video name must be a single file name')
  }
  if (!VIDEO_EXTENSIONS.has(extname(name).toLowerCase())) {
    throw new VideoFileError(`unsupported video extension for "${name}"`)
  }
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== '..' &&
      !isAbsolute(pathFromRoot))
  )
}

async function realInputRoot(inputDirectory: string): Promise<string> {
  try {
    const root = await realpath(inputDirectory)
    const info = await stat(root)
    if (!info.isDirectory()) {
      throw new VideoFileError(
        `input path is not a directory: ${inputDirectory}`,
      )
    }
    return root
  } catch (error) {
    if (error instanceof VideoFileError) {
      throw error
    }
    throw new VideoFileError(
      `cannot access input directory: ${inputDirectory}`,
      { cause: error },
    )
  }
}

export async function listVideos(inputDirectory: string): Promise<VideoFile[]> {
  const root = await realInputRoot(inputDirectory)
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch (error) {
    throw new VideoFileError(`cannot read input directory: ${inputDirectory}`, {
      cause: error,
    })
  }

  const videos: VideoFile[] = []
  for (const name of entries.sort((left, right) => left.localeCompare(right))) {
    if (!VIDEO_EXTENSIONS.has(extname(name).toLowerCase())) {
      continue
    }
    try {
      const filePath = await resolveVideo(root, name)
      const info = await stat(filePath)
      videos.push({ name, size: info.size })
    } catch (error) {
      if (!(error instanceof VideoFileError)) {
        throw error
      }
    }
  }
  return videos
}

export async function resolveVideo(
  inputDirectory: string,
  name: string,
): Promise<string> {
  validateVideoName(name)
  const root = await realInputRoot(inputDirectory)
  const candidate = resolve(root, name)
  let resolved: string
  try {
    resolved = await realpath(candidate)
  } catch (error) {
    throw new VideoFileError(`video does not exist: ${name}`, { cause: error })
  }
  if (!isInside(root, resolved)) {
    throw new VideoFileError(
      `video resolves outside the input directory: ${name}`,
    )
  }
  try {
    const info = await stat(resolved)
    if (!info.isFile()) {
      throw new VideoFileError(`video is not a regular file: ${name}`)
    }
  } catch (error) {
    if (error instanceof VideoFileError) {
      throw error
    }
    throw new VideoFileError(`cannot inspect video: ${name}`, { cause: error })
  }
  return resolved
}

interface ProbeStream {
  readonly codec_type?: unknown
  readonly width?: unknown
  readonly height?: unknown
  readonly duration?: unknown
  readonly avg_frame_rate?: unknown
  readonly r_frame_rate?: unknown
  readonly tags?: unknown
  readonly side_data_list?: unknown
}

interface ProbeOutput {
  readonly streams?: unknown
  readonly format?: unknown
}

function parsePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parseFrameRate(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const [numeratorText, denominatorText] = value.split('/')
  if (numeratorText === undefined || denominatorText === undefined) {
    return parsePositiveNumber(value)
  }
  const numerator = Number(numeratorText)
  const denominator = Number(denominatorText)
  const rate = numerator / denominator
  return Number.isFinite(rate) && rate > 0 ? rate : undefined
}

function streamRotation(stream: ProbeStream): number {
  if (Array.isArray(stream.side_data_list)) {
    for (const item of stream.side_data_list) {
      if (typeof item === 'object' && item !== null && 'rotation' in item) {
        const rotation = Number(item.rotation)
        if (Number.isFinite(rotation)) {
          return rotation
        }
      }
    }
  }
  if (
    typeof stream.tags === 'object' &&
    stream.tags !== null &&
    'rotate' in stream.tags
  ) {
    const rotation = Number(stream.tags.rotate)
    if (Number.isFinite(rotation)) {
      return rotation
    }
  }
  return 0
}

export async function probeVideo(
  inputDirectory: string,
  name: string,
): Promise<VideoMetadata> {
  const filePath = await resolveVideo(inputDirectory, name)
  let stdout: string
  try {
    const result = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
      {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER,
      },
    )
    stdout = result.stdout
  } catch (error) {
    throw new VideoFileError(`ffprobe could not inspect "${name}"`, {
      cause: error,
    })
  }

  let output: ProbeOutput
  try {
    output = JSON.parse(stdout) as ProbeOutput
  } catch (error) {
    throw new VideoFileError(`ffprobe returned invalid data for "${name}"`, {
      cause: error,
    })
  }
  if (!Array.isArray(output.streams)) {
    throw new VideoFileError(`video has no readable streams: ${name}`)
  }
  const streams = output.streams as ProbeStream[]
  const video = streams.find((stream) => stream.codec_type === 'video')
  if (video === undefined) {
    throw new VideoFileError(`file has no video stream: ${name}`)
  }
  const storedWidth = parsePositiveNumber(video.width)
  const storedHeight = parsePositiveNumber(video.height)
  const fps =
    parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate)
  const format =
    typeof output.format === 'object' && output.format !== null
      ? output.format
      : {}
  const duration =
    parsePositiveNumber(video.duration) ??
    ('duration' in format ? parsePositiveNumber(format.duration) : undefined)
  if (
    storedWidth === undefined ||
    storedHeight === undefined ||
    fps === undefined ||
    duration === undefined
  ) {
    throw new VideoFileError(`video metadata is incomplete: ${name}`)
  }
  const rotation = streamRotation(video)
  const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1
  const info = await stat(filePath)
  return {
    name,
    size: info.size,
    width: quarterTurn ? storedHeight : storedWidth,
    height: quarterTurn ? storedWidth : storedHeight,
    duration,
    fps,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
  }
}

async function checkExecutable(command: 'ffmpeg' | 'ffprobe'): Promise<void> {
  try {
    await execFileAsync(command, ['-version'], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    })
  } catch (error) {
    throw new VideoFileError(
      `${command} is unavailable; install FFmpeg and ensure both ffmpeg and ffprobe are on PATH`,
      { cause: error },
    )
  }
}

export async function checkVideoTools(): Promise<void> {
  await checkExecutable('ffmpeg')
  await checkExecutable('ffprobe')
}

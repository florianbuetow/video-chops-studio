import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const BACKGROUND_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const IMAGE_CODECS = new Set(['png', 'mjpeg', 'webp'])
const MAX_BACKGROUND_BYTES = 20 * 1024 * 1024
const MAX_BACKGROUND_PIXELS = 40_000_000
const MAX_BACKGROUND_EDGE = 4096
const PROCESS_TIMEOUT_MS = 30_000
const PROCESS_MAX_BUFFER = 2 * 1024 * 1024

export class BackgroundImageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BackgroundImageError'
  }
}

interface ImageDimensions {
  readonly width: number
  readonly height: number
}

interface ProbeStream {
  readonly codec_name?: unknown
  readonly width?: unknown
  readonly height?: unknown
}

interface ProbeOutput {
  readonly streams?: unknown
}

function validateBackgroundName(name: string): string {
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
    throw new BackgroundImageError('background name must be a single file name')
  }
  const extension = extname(name).toLowerCase()
  if (!BACKGROUND_EXTENSIONS.has(extension)) {
    throw new BackgroundImageError(
      `unsupported background image extension for "${name}"`,
    )
  }
  return extension
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
    const details = await stat(root)
    if (!details.isDirectory()) {
      throw new BackgroundImageError(
        `input path is not a directory: ${inputDirectory}`,
      )
    }
    return root
  } catch (error: unknown) {
    if (error instanceof BackgroundImageError) throw error
    throw new BackgroundImageError(
      `cannot access input directory: ${inputDirectory}`,
      { cause: error },
    )
  }
}

export async function resolveBackground(
  inputDirectory: string,
  name: string,
): Promise<string> {
  validateBackgroundName(name)
  const root = await realInputRoot(inputDirectory)
  const candidate = resolve(root, name)
  let resolved: string
  try {
    resolved = await realpath(candidate)
  } catch (error: unknown) {
    throw new BackgroundImageError(`background image does not exist: ${name}`, {
      cause: error,
    })
  }
  if (!isInside(root, resolved)) {
    throw new BackgroundImageError(
      `background image resolves outside the input directory: ${name}`,
    )
  }
  try {
    const details = await stat(resolved)
    if (!details.isFile()) {
      throw new BackgroundImageError(
        `background image is not a regular file: ${name}`,
      )
    }
  } catch (error: unknown) {
    if (error instanceof BackgroundImageError) throw error
    throw new BackgroundImageError(`cannot inspect background image: ${name}`, {
      cause: error,
    })
  }
  return resolved
}

function parseDimension(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return undefined
  }
  return value
}

async function probeImage(
  file: string,
  displayName: string,
  expectedCodec?: string,
): Promise<ImageDimensions> {
  let stdout: string
  try {
    const result = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height',
        '-of',
        'json',
        file,
      ],
      {
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: PROCESS_MAX_BUFFER,
        windowsHide: true,
      },
    )
    stdout = result.stdout
  } catch (error: unknown) {
    throw new BackgroundImageError(
      `cannot read background image "${displayName}"`,
      { cause: error },
    )
  }

  let output: ProbeOutput
  try {
    output = JSON.parse(stdout) as ProbeOutput
  } catch (error: unknown) {
    throw new BackgroundImageError(
      `background image metadata is invalid for "${displayName}"`,
      { cause: error },
    )
  }
  const stream = Array.isArray(output.streams)
    ? (output.streams[0] as ProbeStream | undefined)
    : undefined
  const width = parseDimension(stream?.width)
  const height = parseDimension(stream?.height)
  const codec = stream?.codec_name
  if (
    width === undefined ||
    height === undefined ||
    typeof codec !== 'string' ||
    !IMAGE_CODECS.has(codec) ||
    (expectedCodec !== undefined && codec !== expectedCodec)
  ) {
    throw new BackgroundImageError(
      `file is not a supported background image: ${displayName}`,
    )
  }
  return { width, height }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EEXIST'
  )
}

async function cachedBackground(
  inputDirectory: string,
  name: string,
): Promise<ImageDimensions | undefined> {
  try {
    const existing = await resolveBackground(inputDirectory, name)
    const dimensions = await probeImage(existing, name, 'png')
    if (
      dimensions.width > MAX_BACKGROUND_EDGE ||
      dimensions.height > MAX_BACKGROUND_EDGE
    ) {
      throw new BackgroundImageError(
        `cached background image exceeds ${MAX_BACKGROUND_EDGE}px: ${name}`,
      )
    }
    return dimensions
  } catch (error: unknown) {
    if (
      error instanceof BackgroundImageError &&
      error.message.startsWith('background image does not exist:')
    ) {
      return undefined
    }
    throw error
  }
}

export async function importBackground(
  inputDirectory: string,
  name: string,
  body: Uint8Array,
): Promise<{ name: string; width: number; height: number }> {
  const extension = validateBackgroundName(name)
  if (body.byteLength === 0) {
    throw new BackgroundImageError('background image is empty')
  }
  if (body.byteLength > MAX_BACKGROUND_BYTES) {
    throw new BackgroundImageError('background image exceeds 20 MiB')
  }

  const root = await realInputRoot(inputDirectory)
  const hash = createHash('sha256').update(body).digest('hex')
  const savedName = `background-${hash}.png`
  const existing = await cachedBackground(root, savedName)
  if (existing !== undefined) {
    return { name: savedName, ...existing }
  }

  let temporaryDirectory: string
  try {
    temporaryDirectory = await mkdtemp(join(root, '.background-import-'))
  } catch (error: unknown) {
    throw new BackgroundImageError(
      `could not create temporary files for background image "${name}"`,
      { cause: error },
    )
  }

  let imported: { name: string; width: number; height: number } | undefined
  let importError: unknown
  try {
    const source = join(
      temporaryDirectory,
      `source-${randomUUID()}${extension}`,
    )
    const normalized = join(
      temporaryDirectory,
      `normalized-${randomUUID()}.png`,
    )
    await writeFile(source, body, { flag: 'wx' })
    const sourceDimensions = await probeImage(source, name)
    if (
      sourceDimensions.width >
      MAX_BACKGROUND_PIXELS / sourceDimensions.height
    ) {
      throw new BackgroundImageError(
        `background image exceeds 40 megapixels: ${name}`,
      )
    }

    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          source,
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-vf',
          "scale=w='min(4096,iw)':h='min(4096,ih)':force_original_aspect_ratio=decrease",
          '-map_metadata',
          '-1',
          '-c:v',
          'png',
          '-pix_fmt',
          'rgba',
          '-threads',
          '2',
          normalized,
        ],
        {
          encoding: 'utf8',
          timeout: PROCESS_TIMEOUT_MS,
          maxBuffer: PROCESS_MAX_BUFFER,
          windowsHide: true,
        },
      )
    } catch (error: unknown) {
      throw new BackgroundImageError(
        `could not normalize background image "${name}"`,
        { cause: error },
      )
    }

    const dimensions = await probeImage(normalized, savedName, 'png')
    const target = join(root, savedName)
    try {
      await link(normalized, target)
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) {
        throw new BackgroundImageError(
          `could not save background image "${name}"`,
          { cause: error },
        )
      }
      const winner = await cachedBackground(root, savedName)
      if (winner === undefined) {
        throw new BackgroundImageError(
          `background image cache disappeared while importing "${name}"`,
          { cause: error },
        )
      }
      imported = { name: savedName, ...winner }
    }
    imported ??= { name: savedName, ...dimensions }
  } catch (error: unknown) {
    importError =
      error instanceof BackgroundImageError
        ? error
        : new BackgroundImageError(
            `could not import background image "${name}"`,
            { cause: error },
          )
  }

  try {
    await rm(temporaryDirectory, { recursive: true, force: true })
  } catch (error: unknown) {
    throw new BackgroundImageError(
      `could not clean temporary files for background image "${name}"`,
      { cause: error },
    )
  }
  if (importError !== undefined) throw importError
  if (imported === undefined) {
    throw new BackgroundImageError(
      `background image import produced no result for "${name}"`,
    )
  }
  return imported
}

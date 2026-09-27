export interface VideoFile {
  readonly name: string
  readonly size: number
}

export interface VideoMetadata extends VideoFile {
  readonly width: number
  readonly height: number
  readonly duration: number
  readonly fps: number
  readonly hasAudio: boolean
}

export interface Segment {
  readonly start: number
  readonly end: number
}

export interface Crop {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface VideoRegion {
  readonly crop: Crop
  readonly x: number
  readonly y: number
  readonly scale: number
}

export interface CompositionFrame {
  readonly target: 'regions' | 'canvas'
  readonly color: string
  readonly width: number
}

export interface Composition {
  readonly width: number
  readonly height: number
  readonly background: string
  readonly backgroundImage?: string
  readonly frame?: CompositionFrame
  readonly regions: readonly [VideoRegion, VideoRegion]
}

export interface EditRequest {
  readonly source: string
  readonly segments: readonly Segment[]
  readonly crop: Crop
  readonly outputName: string
  readonly muted: boolean
  readonly composition?: Composition
}

export class VideoValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VideoValidationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new VideoValidationError(
      `${label} must contain exactly: ${keys.join(', ')}`,
    )
  }
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new VideoValidationError(`${label} must be a finite number`)
  }
  return value
}

function requireSingleBasename(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    [...value].some((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code <= 31 || code === 127)
    })
  ) {
    throw new VideoValidationError(`${label} must be a single file name`)
  }
  return value
}

function validateMetadata(metadata: VideoMetadata): void {
  if (
    !Number.isFinite(metadata.duration) ||
    metadata.duration <= 0 ||
    !Number.isInteger(metadata.width) ||
    metadata.width <= 0 ||
    !Number.isInteger(metadata.height) ||
    metadata.height <= 0 ||
    !Number.isFinite(metadata.fps) ||
    metadata.fps <= 0
  ) {
    throw new VideoValidationError('video metadata is invalid')
  }
}

function validateCrop(
  candidate: unknown,
  metadata: VideoMetadata,
  label: string,
): Crop {
  if (!isRecord(candidate)) {
    throw new VideoValidationError(`${label} must be an object`)
  }
  requireExactKeys(candidate, ['x', 'y', 'width', 'height'], label)
  const x = requireFiniteNumber(candidate['x'], `${label} x`)
  const y = requireFiniteNumber(candidate['y'], `${label} y`)
  const width = requireFiniteNumber(candidate['width'], `${label} width`)
  const height = requireFiniteNumber(candidate['height'], `${label} height`)
  if (![x, y, width, height].every(Number.isInteger)) {
    throw new VideoValidationError(`${label} values must be integers`)
  }
  if (x < 0 || y < 0 || width < 2 || height < 2) {
    throw new VideoValidationError(
      `${label} must have a non-negative origin and dimensions of at least 2 pixels`,
    )
  }
  if (x % 2 !== 0 || y % 2 !== 0 || width % 2 !== 0 || height % 2 !== 0) {
    throw new VideoValidationError(
      `${label} origin and dimensions must be even`,
    )
  }
  if (x + width > metadata.width || y + height > metadata.height) {
    throw new VideoValidationError(`${label} must fit within the video frame`)
  }
  return { x, y, width, height }
}

export function regionSize(region: VideoRegion): {
  readonly width: number
  readonly height: number
} {
  return {
    width: Math.max(2, Math.floor((region.crop.width * region.scale) / 2) * 2),
    height: Math.max(
      2,
      Math.floor((region.crop.height * region.scale) / 2) * 2,
    ),
  }
}

function validateComposition(
  candidate: unknown,
  metadata: VideoMetadata,
): Composition {
  if (!isRecord(candidate)) {
    throw new VideoValidationError('composition must be an object')
  }
  const compositionKeys = ['width', 'height', 'background', 'regions']
  requireExactKeys(
    candidate,
    [
      ...compositionKeys,
      ...(Object.hasOwn(candidate, 'backgroundImage')
        ? ['backgroundImage']
        : []),
      ...(Object.hasOwn(candidate, 'frame') ? ['frame'] : []),
    ],
    'composition',
  )
  const width = requireFiniteNumber(candidate['width'], 'composition width')
  const height = requireFiniteNumber(candidate['height'], 'composition height')
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new VideoValidationError('composition dimensions must be integers')
  }
  if (
    width < 2 ||
    width > 4096 ||
    height < 2 ||
    height > 4096 ||
    width % 2 !== 0 ||
    height % 2 !== 0
  ) {
    throw new VideoValidationError(
      'composition dimensions must be even and between 2 and 4096 pixels',
    )
  }
  const background = candidate['background']
  if (typeof background !== 'string' || !/^#[0-9a-f]{6}$/iu.test(background)) {
    throw new VideoValidationError(
      'composition background must be a #RRGGBB color',
    )
  }
  let backgroundImage: string | undefined
  if (Object.hasOwn(candidate, 'backgroundImage')) {
    backgroundImage = requireSingleBasename(
      candidate['backgroundImage'],
      'composition backgroundImage',
    )
    if (!/\.(?:png|jpe?g|webp)$/iu.test(backgroundImage)) {
      throw new VideoValidationError(
        'composition backgroundImage must be a PNG, JPEG, or WebP file name',
      )
    }
  }
  let frame: CompositionFrame | undefined
  if (Object.hasOwn(candidate, 'frame')) {
    const frameCandidate = candidate['frame']
    if (!isRecord(frameCandidate)) {
      throw new VideoValidationError('composition frame must be an object')
    }
    requireExactKeys(
      frameCandidate,
      ['target', 'color', 'width'],
      'composition frame',
    )
    const target = frameCandidate['target']
    if (target !== 'regions' && target !== 'canvas') {
      throw new VideoValidationError(
        'composition frame target must be regions or canvas',
      )
    }
    const color = frameCandidate['color']
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(color)) {
      throw new VideoValidationError(
        'composition frame color must be a #RRGGBB color',
      )
    }
    const frameWidth = requireFiniteNumber(
      frameCandidate['width'],
      'composition frame width',
    )
    if (!Number.isInteger(frameWidth) || frameWidth < 1 || frameWidth > 64) {
      throw new VideoValidationError(
        'composition frame width must be an integer between 1 and 64',
      )
    }
    frame = { target, color, width: frameWidth }
  }
  if (
    !Array.isArray(candidate['regions']) ||
    candidate['regions'].length !== 2
  ) {
    throw new VideoValidationError(
      'composition regions must contain exactly 2 entries',
    )
  }
  const regions = candidate['regions'].map((region, index): VideoRegion => {
    if (!isRecord(region)) {
      throw new VideoValidationError(
        `composition region ${index} must be an object`,
      )
    }
    requireExactKeys(
      region,
      ['crop', 'x', 'y', 'scale'],
      `composition region ${index}`,
    )
    const crop = validateCrop(
      region['crop'],
      metadata,
      `composition region ${index} crop`,
    )
    const x = requireFiniteNumber(region['x'], `composition region ${index} x`)
    const y = requireFiniteNumber(region['y'], `composition region ${index} y`)
    const scale = requireFiniteNumber(
      region['scale'],
      `composition region ${index} scale`,
    )
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new VideoValidationError(
        `composition region ${index} position must use integers`,
      )
    }
    if (x < 0 || y < 0 || x % 2 !== 0 || y % 2 !== 0) {
      throw new VideoValidationError(
        `composition region ${index} position must be even and non-negative`,
      )
    }
    if (scale <= 0 || scale > 1) {
      throw new VideoValidationError(
        `composition region ${index} scale must be greater than 0 and at most 1`,
      )
    }
    const normalized = { crop, x, y, scale }
    const size = regionSize(normalized)
    if (x + size.width > width || y + size.height > height) {
      throw new VideoValidationError(
        `composition region ${index} must fit within the output frame`,
      )
    }
    return normalized
  })
  return {
    width,
    height,
    background,
    ...(backgroundImage === undefined ? {} : { backgroundImage }),
    ...(frame === undefined ? {} : { frame }),
    regions: [regions[0] as VideoRegion, regions[1] as VideoRegion],
  }
}

export function validateEdit(
  edit: unknown,
  metadata: VideoMetadata,
): EditRequest {
  validateMetadata(metadata)
  if (!isRecord(edit)) {
    throw new VideoValidationError('edit must be an object')
  }
  const editKeys = ['source', 'segments', 'crop', 'outputName', 'muted']
  requireExactKeys(
    edit,
    Object.hasOwn(edit, 'composition')
      ? [...editKeys, 'composition']
      : editKeys,
    'edit',
  )

  const source = requireSingleBasename(edit['source'], 'source')
  const outputName = requireSingleBasename(edit['outputName'], 'outputName')
  if (!/^[^.][^/\\]*\.mp4$/iu.test(outputName)) {
    throw new VideoValidationError(
      'outputName must be a non-hidden .mp4 file name',
    )
  }
  if (typeof edit['muted'] !== 'boolean') {
    throw new VideoValidationError('muted must be a boolean')
  }
  if (
    !Array.isArray(edit['segments']) ||
    edit['segments'].length < 1 ||
    edit['segments'].length > 128
  ) {
    throw new VideoValidationError(
      'segments must contain between 1 and 128 entries',
    )
  }

  let previousEnd = 0
  const segments = edit['segments'].map((candidate, index): Segment => {
    if (!isRecord(candidate)) {
      throw new VideoValidationError(`segment ${index} must be an object`)
    }
    requireExactKeys(candidate, ['start', 'end'], `segment ${index}`)
    const start = requireFiniteNumber(
      candidate['start'],
      `segment ${index} start`,
    )
    const end = requireFiniteNumber(candidate['end'], `segment ${index} end`)
    if (start < 0) {
      throw new VideoValidationError(
        `segment ${index} start must be non-negative`,
      )
    }
    // Decimal timestamps such as 0.15 - 0.10 can fall just below 0.05 in binary floating point.
    if (end - start < 0.05 - 1e-9) {
      throw new VideoValidationError(
        `segment ${index} must be at least 0.05 seconds long`,
      )
    }
    // Container duration is rounded and may end one decoded frame before the reported timestamp.
    if (end > metadata.duration + 1 / metadata.fps) {
      throw new VideoValidationError(
        `segment ${index} exceeds the video duration`,
      )
    }
    if (index > 0 && start < previousEnd) {
      throw new VideoValidationError(
        'segments must be sorted and must not overlap',
      )
    }
    previousEnd = end
    return { start, end }
  })

  const crop = validateCrop(edit['crop'], metadata, 'crop')
  const composition = Object.hasOwn(edit, 'composition')
    ? validateComposition(edit['composition'], metadata)
    : undefined

  return {
    source,
    segments,
    crop,
    outputName,
    muted: edit['muted'],
    ...(composition === undefined ? {} : { composition }),
  }
}

export function editDuration(segments: readonly Segment[]): number {
  return segments.reduce(
    (total, segment) => total + segment.end - segment.start,
    0,
  )
}

function seconds(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/u, '')
}

export function buildExportArgs(
  edit: EditRequest,
  metadata: VideoMetadata,
  inputPath: string,
  outputPath: string,
  backgroundPath?: string,
): string[] {
  const withAudio = metadata.hasAudio && !edit.muted
  const filters: string[] = []
  edit.segments.forEach((segment, index) => {
    filters.push(
      `[0:v:0]setpts=PTS-STARTPTS,trim=start=${seconds(segment.start)}:end=${seconds(segment.end)},setpts=PTS-STARTPTS[v${index}]`,
    )
    if (withAudio) {
      filters.push(
        `[0:a:0]asetpts=PTS-STARTPTS,atrim=start=${seconds(segment.start)}:end=${seconds(segment.end)},asetpts=PTS-STARTPTS[a${index}]`,
      )
    }
  })

  const videoInputs = edit.segments
    .map((_segment, index) => `[v${index}]`)
    .join('')
  if (withAudio) {
    const inputs = edit.segments
      .map((_segment, index) => `[v${index}][a${index}]`)
      .join('')
    filters.push(
      `${inputs}concat=n=${edit.segments.length}:v=1:a=1[joinedv][outa]`,
    )
  } else {
    filters.push(
      `${videoInputs}concat=n=${edit.segments.length}:v=1:a=0[joinedv]`,
    )
  }
  if (edit.composition === undefined) {
    const { x, y, width, height } = edit.crop
    filters.push(`[joinedv]crop=${width}:${height}:${x}:${y}[outv]`)
  } else {
    if (
      edit.composition.backgroundImage !== undefined &&
      backgroundPath === undefined
    ) {
      throw new VideoValidationError(
        'backgroundPath is required when composition backgroundImage is set',
      )
    }
    const [first, second] = edit.composition.regions
    const firstSize = regionSize(first)
    const secondSize = regionSize(second)
    filters.push(
      '[joinedv]setpts=PTS-STARTPTS,split=3[clock][region0input][region1input]',
    )
    filters.push(
      `[clock]crop=w=2:h=2:x=0:y=0:exact=1,scale=w=${edit.composition.width}:h=${edit.composition.height},format=rgba,drawbox=x=0:y=0:w=iw:h=ih:color=0x${edit.composition.background.slice(1)}:t=fill,setsar=1[colorcanvas]`,
    )
    let backgroundLabel = 'colorcanvas'
    if (edit.composition.backgroundImage !== undefined) {
      filters.push(
        `[1:v:0]scale=w=${edit.composition.width}:h=${edit.composition.height}:force_original_aspect_ratio=increase:flags=lanczos:reset_sar=1,crop=w=${edit.composition.width}:h=${edit.composition.height}:x=(iw-ow)/2:y=(ih-oh)/2:exact=1,format=rgba,setsar=1[backgroundimage]`,
      )
      filters.push(
        '[colorcanvas][backgroundimage]overlay=x=0:y=0:shortest=1:eof_action=endall:format=rgb[backgroundcanvas]',
      )
      backgroundLabel = 'backgroundcanvas'
    }
    const regionFrame =
      edit.composition.frame?.target === 'regions'
        ? `,drawbox=x=0:y=0:w=iw:h=ih:color=0x${edit.composition.frame.color.slice(1)}:t=${edit.composition.frame.width}`
        : ''
    filters.push(
      `[region0input]crop=w=${first.crop.width}:h=${first.crop.height}:x=${first.crop.x}:y=${first.crop.y}:exact=1,scale=w=${firstSize.width}:h=${firstSize.height}:flags=lanczos:reset_sar=1,format=rgba${regionFrame}[region0]`,
    )
    filters.push(
      `[region1input]crop=w=${second.crop.width}:h=${second.crop.height}:x=${second.crop.x}:y=${second.crop.y}:exact=1,scale=w=${secondSize.width}:h=${secondSize.height}:flags=lanczos:reset_sar=1,format=rgba${regionFrame}[region1]`,
    )
    filters.push(
      `[${backgroundLabel}][region0]overlay=x=${first.x}:y=${first.y}:shortest=1:eof_action=endall:format=rgb[region0canvas]`,
    )
    filters.push(
      `[region0canvas][region1]overlay=x=${second.x}:y=${second.y}:shortest=1:eof_action=endall:format=rgb[composed]`,
    )
    let styledLabel = 'composed'
    if (edit.composition.frame?.target === 'canvas') {
      filters.push(
        `[composed]drawbox=x=0:y=0:w=iw:h=ih:color=0x${edit.composition.frame.color.slice(1)}:t=${edit.composition.frame.width}[styled]`,
      )
      styledLabel = 'styled'
    }
    filters.push(
      `[${styledLabel}]format=rgb24,scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[outv]`,
    )
  }

  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    ...(edit.composition?.backgroundImage === undefined
      ? []
      : ['-loop', '1', '-i', backgroundPath as string]),
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[outv]',
  ]
  if (withAudio) {
    args.push('-map', '[outa]')
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p')
  if (edit.composition !== undefined) {
    args.push(
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      '-color_range',
      'tv',
    )
  }
  if (withAudio) {
    args.push('-c:a', 'aac')
  } else {
    args.push('-an')
  }
  args.push(
    '-movflags',
    '+faststart',
    '-threads',
    '2',
    '-progress',
    'pipe:1',
    '-nostats',
    outputPath,
  )
  return args
}

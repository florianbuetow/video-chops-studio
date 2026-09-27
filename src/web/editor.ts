import type { Crop, Segment, VideoMetadata } from '../domain/video.js'

export const MIN_CLIP = 0.05

export class EditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditError'
  }
}

export function formatTime(seconds: number): string {
  const ticks = Math.round(Math.max(0, seconds) * 100)
  const minutes = Math.floor(ticks / 6000)
  return `${String(minutes).padStart(2, '0')}:${((ticks % 6000) / 100).toFixed(2).padStart(5, '0')}`
}

export function totalDuration(segments: readonly Segment[]): number {
  return segments.reduce(
    (total, segment) => total + segment.end - segment.start,
    0,
  )
}

export function outputTime(
  segments: readonly Segment[],
  sourceTime: number,
): number {
  let elapsed = 0
  for (const segment of segments) {
    if (sourceTime < segment.start) break
    elapsed += Math.min(sourceTime, segment.end) - segment.start
    if (sourceTime < segment.end) break
  }
  return elapsed
}

export function splitClip(
  segments: readonly Segment[],
  time: number,
): Segment[] {
  const index = segments.findIndex(
    (segment) =>
      time - segment.start >= MIN_CLIP - 1e-9 &&
      segment.end - time >= MIN_CLIP - 1e-9,
  )
  const segment = segments[index]
  if (segment === undefined)
    throw new EditError('Move the playhead inside a clip to split it.')
  return [
    ...segments.slice(0, index),
    { start: segment.start, end: time },
    { start: time, end: segment.end },
    ...segments.slice(index + 1),
  ]
}

export function trimClip(
  segments: readonly Segment[],
  index: number,
  start: number,
  end: number,
  duration: number,
): Segment[] {
  if (segments[index] === undefined) throw new EditError('Select a clip first.')
  const previous = segments[index - 1]
  const next = segments[index + 1]
  const minimum = previous === undefined ? 0 : previous.end
  const maximum = next === undefined ? duration : next.start
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < minimum ||
    end > maximum ||
    end - start < MIN_CLIP - 1e-9
  ) {
    throw new EditError(
      `Keep this clip between ${formatTime(minimum)} and ${formatTime(maximum)}, at least 0.05 seconds long.`,
    )
  }
  return segments.map((segment, current) =>
    current === index ? { start, end } : segment,
  )
}

export function fullCrop(
  metadata: Pick<VideoMetadata, 'width' | 'height'>,
): Crop {
  return {
    x: 0,
    y: 0,
    width: even(metadata.width),
    height: even(metadata.height),
  }
}

export function even(value: number): number {
  return Math.floor(value / 2) * 2
}

export function fitCrop(
  crop: Crop,
  metadata: Pick<VideoMetadata, 'width' | 'height'>,
  ratio?: number | null,
): Crop {
  const scale =
    ratio === undefined || ratio === null
      ? 1
      : Math.min(
          1,
          even(metadata.width) / crop.width,
          even(metadata.height) / crop.height,
        )
  const width = Math.max(
    2,
    Math.min(even(crop.width * scale), even(metadata.width)),
  )
  const height = Math.max(
    2,
    Math.min(even(crop.height * scale), even(metadata.height)),
  )
  return {
    x: Math.max(0, Math.min(even(crop.x), even(metadata.width - width))),
    y: Math.max(0, Math.min(even(crop.y), even(metadata.height - height))),
    width,
    height,
  }
}

export function aspectCrop(
  metadata: Pick<VideoMetadata, 'width' | 'height'>,
  ratio: number,
): Crop {
  const full = fullCrop(metadata)
  const width = Math.max(2, even(Math.min(full.width, full.height * ratio)))
  const height = Math.max(2, even(Math.min(full.height, full.width / ratio)))
  return {
    x: even((full.width - width) / 2),
    y: even((full.height - height) / 2),
    width,
    height,
  }
}

export function nextKeptTime(
  segments: readonly Segment[],
  time: number,
): number | null {
  for (const segment of segments) {
    if (time < segment.start) return segment.start
    if (time < segment.end - 0.015) return time
  }
  return null
}

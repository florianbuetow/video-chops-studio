import type {
  Composition,
  Crop,
  VideoMetadata,
  VideoRegion,
} from '../domain/video.js'
import { regionSize } from '../domain/video.js'
import { even } from './editor.js'

export const OUTPUT_PRESETS = [
  { id: '9:16', label: 'Portrait · 9:16', width: 1080, height: 1920 },
  { id: '16:9', label: 'Landscape · 16:9', width: 1920, height: 1080 },
  { id: '1:1', label: 'Square · 1:1', width: 1080, height: 1080 },
  { id: '3:2', label: 'Landscape · 3:2', width: 1620, height: 1080 },
  { id: '2:3', label: 'Portrait · 2:3', width: 1080, height: 1620 },
  { id: '4:3', label: 'Landscape · 4:3', width: 1440, height: 1080 },
  { id: '3:4', label: 'Portrait · 3:4', width: 1080, height: 1440 },
  { id: '4:5', label: 'Portrait · 4:5', width: 1080, height: 1350 },
  { id: '5:4', label: 'Landscape · 5:4', width: 1350, height: 1080 },
  { id: '21:9', label: 'Ultrawide · 21:9', width: 2520, height: 1080 },
] as const

export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'
export type StackDirection = 'vertical' | 'horizontal'

export class CompositionGeometryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompositionGeometryError'
  }
}

function preset(presetId: string): (typeof OUTPUT_PRESETS)[number] {
  const result = OUTPUT_PRESETS.find((candidate) => candidate.id === presetId)
  if (result === undefined) {
    throw new CompositionGeometryError(`Unknown output preset: ${presetId}`)
  }
  return result
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new CompositionGeometryError(`${label} must be finite`)
  }
  return value
}

function assertFiniteComposition(composition: Composition): void {
  finite(composition.width, 'Composition width')
  finite(composition.height, 'Composition height')
  composition.regions.forEach((region, index) => {
    finite(region.x, `Region ${index + 1} x`)
    finite(region.y, `Region ${index + 1} y`)
    finite(region.scale, `Region ${index + 1} scale`)
    finite(region.crop.x, `Region ${index + 1} crop x`)
    finite(region.crop.y, `Region ${index + 1} crop y`)
    finite(region.crop.width, `Region ${index + 1} crop width`)
    finite(region.crop.height, `Region ${index + 1} crop height`)
  })
}

function assertStackDirection(direction: StackDirection): void {
  if (direction !== 'vertical' && direction !== 'horizontal') {
    throw new CompositionGeometryError(
      `Unknown stack direction: ${String(direction)}`,
    )
  }
}

function assertStackDimensions(composition: Composition): void {
  assertFiniteComposition(composition)
  if (
    !Number.isInteger(composition.width) ||
    !Number.isInteger(composition.height) ||
    composition.width < 2 ||
    composition.height < 2 ||
    composition.width % 2 !== 0 ||
    composition.height % 2 !== 0
  ) {
    throw new CompositionGeometryError(
      'Composition dimensions must be positive even integers of at least 2 pixels',
    )
  }
  composition.regions.forEach((region, index) => {
    const { width, height } = region.crop
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 2 ||
      height < 2 ||
      width % 2 !== 0 ||
      height % 2 !== 0
    ) {
      throw new CompositionGeometryError(
        `Region ${index + 1} crop dimensions must be positive even integers of at least 2 pixels`,
      )
    }
  })
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum))
}

function replaceRegion(
  composition: Composition,
  index: 0 | 1,
  region: VideoRegion,
): Composition {
  const regions: readonly [VideoRegion, VideoRegion] =
    index === 0
      ? [region, composition.regions[1]]
      : [composition.regions[0], region]
  return { ...composition, regions }
}

function maximumScaleAt(
  composition: Pick<Composition, 'width' | 'height'>,
  crop: Crop,
  x: number,
  y: number,
): number {
  return Math.min(
    1,
    (composition.width - x) / crop.width,
    (composition.height - y) / crop.height,
  )
}

function positionWithinCanvas(
  composition: Pick<Composition, 'width' | 'height'>,
  region: VideoRegion,
): VideoRegion {
  const size = regionSize(region)
  return {
    ...region,
    x: clamp(even(region.x), 0, even(composition.width - size.width)),
    y: clamp(even(region.y), 0, even(composition.height - size.height)),
  }
}

function fittedRegion(
  composition: Pick<Composition, 'width' | 'height'>,
  region: VideoRegion,
): VideoRegion {
  const positioned = {
    ...region,
    x: clamp(even(region.x), 0, composition.width - 2),
    y: clamp(even(region.y), 0, composition.height - 2),
  }
  const scale = clamp(
    Math.min(
      region.scale,
      maximumScaleAt(composition, region.crop, positioned.x, positioned.y),
    ),
    0.01,
    1,
  )
  return positionWithinCanvas(composition, { ...positioned, scale })
}

export function initialComposition(
  metadata: Pick<VideoMetadata, 'width' | 'height'>,
  presetId: string,
): Composition {
  finite(metadata.width, 'Video width')
  finite(metadata.height, 'Video height')
  if (
    !Number.isInteger(metadata.width) ||
    !Number.isInteger(metadata.height) ||
    metadata.width < 2 ||
    metadata.height < 2
  ) {
    throw new CompositionGeometryError(
      'Video dimensions must be positive integers of at least 2 pixels',
    )
  }

  const output = preset(presetId)
  const sourceWidth = even(metadata.width)
  const sourceHeight = even(metadata.height)
  const cropHeight =
    sourceHeight < 4 ? sourceHeight : Math.max(2, even(sourceHeight / 2))
  const firstCrop: Crop = { x: 0, y: 0, width: sourceWidth, height: cropHeight }
  const secondCrop: Crop = {
    x: 0,
    y: sourceHeight < 4 ? 0 : sourceHeight - cropHeight,
    width: sourceWidth,
    height: cropHeight,
  }
  const canvas = { width: output.width, height: output.height }
  return stackRegions(
    {
      ...canvas,
      background: '#000000',
      regions: [
        { crop: firstCrop, x: 0, y: 0, scale: 1 },
        { crop: secondCrop, x: 0, y: 0, scale: 1 },
      ],
    },
    'vertical',
    0,
  )
}

function primarySize(region: VideoRegion, direction: StackDirection): number {
  const size = regionSize(region)
  return direction === 'vertical' ? size.height : size.width
}

export function maxStackGap(
  composition: Composition,
  direction: StackDirection,
): number {
  assertStackDirection(direction)
  assertStackDimensions(composition)
  const firstMinimum = { ...composition.regions[0], scale: 0.01 }
  const secondMinimum = { ...composition.regions[1], scale: 0.01 }
  const axisLength =
    direction === 'vertical' ? composition.height : composition.width
  const minimumGroupSize =
    primarySize(firstMinimum, direction) + primarySize(secondMinimum, direction)
  if (minimumGroupSize > axisLength) {
    throw new CompositionGeometryError(
      `Composition is too small to stack both regions ${direction}ly`,
    )
  }
  return even(axisLength - minimumGroupSize)
}

export function normalizeStackGap(
  composition: Composition,
  direction: StackDirection,
  gap: number,
): number {
  assertStackDirection(direction)
  finite(gap, 'Stack gap')
  return clamp(even(Math.max(0, gap)), 0, maxStackGap(composition, direction))
}

export function stackRegions(
  composition: Composition,
  direction: StackDirection,
  gap: number,
): Composition {
  assertStackDirection(direction)
  assertStackDimensions(composition)
  const normalizedGap = normalizeStackGap(composition, direction, gap)
  const firstCrop = composition.regions[0].crop
  const secondCrop = composition.regions[1].crop
  const vertical = direction === 'vertical'
  const axisLength = vertical ? composition.height : composition.width
  const crossLength = vertical ? composition.width : composition.height
  const firstAxisCrop = vertical ? firstCrop.height : firstCrop.width
  const secondAxisCrop = vertical ? secondCrop.height : secondCrop.width
  const maximumCrossCrop = Math.max(
    vertical ? firstCrop.width : firstCrop.height,
    vertical ? secondCrop.width : secondCrop.height,
  )
  const scale = Math.min(
    1,
    crossLength / maximumCrossCrop,
    (axisLength - normalizedGap) / (firstAxisCrop + secondAxisCrop),
  )
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new CompositionGeometryError(
      'Stacked region scale must be positive and finite',
    )
  }
  const firstSize = regionSize({ crop: firstCrop, x: 0, y: 0, scale })
  const secondSize = regionSize({ crop: secondCrop, x: 0, y: 0, scale })
  const firstPrimary = vertical ? firstSize.height : firstSize.width
  const secondPrimary = vertical ? secondSize.height : secondSize.width
  const groupStart = even(
    (axisLength - firstPrimary - normalizedGap - secondPrimary) / 2,
  )
  const firstCross = even(
    (crossLength - (vertical ? firstSize.width : firstSize.height)) / 2,
  )
  const secondCross = even(
    (crossLength - (vertical ? secondSize.width : secondSize.height)) / 2,
  )
  const first: VideoRegion = {
    crop: firstCrop,
    x: vertical ? firstCross : groupStart,
    y: vertical ? groupStart : firstCross,
    scale,
  }
  const secondStart = groupStart + firstPrimary + normalizedGap
  const second: VideoRegion = {
    crop: secondCrop,
    x: vertical ? secondCross : secondStart,
    y: vertical ? secondStart : secondCross,
    scale,
  }
  return {
    ...composition,
    regions: [first, second],
  }
}

export function changePreset(
  composition: Composition,
  presetId: string,
  direction: StackDirection,
  gap: number,
): Composition {
  assertFiniteComposition(composition)
  const output = preset(presetId)
  return stackRegions(
    {
      ...composition,
      width: output.width,
      height: output.height,
    },
    direction,
    gap,
  )
}

export function updateRegionCrop(
  composition: Composition,
  index: 0 | 1,
  crop: Crop,
): Composition {
  assertFiniteComposition(composition)
  const values = [crop.x, crop.y, crop.width, crop.height]
  if (values.some((value) => !Number.isFinite(value))) {
    throw new CompositionGeometryError('Crop geometry must be finite')
  }
  if (
    values.some((value) => !Number.isInteger(value) || value % 2 !== 0) ||
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width < 2 ||
    crop.height < 2
  ) {
    throw new CompositionGeometryError(
      'Crop geometry must use non-negative even origins and even dimensions of at least 2 pixels',
    )
  }
  const current = composition.regions[index]
  return replaceRegion(
    composition,
    index,
    fittedRegion(composition, { ...current, crop }),
  )
}

export function moveRegion(
  composition: Composition,
  index: 0 | 1,
  x: number,
  y: number,
): Composition {
  assertFiniteComposition(composition)
  finite(x, 'Region x')
  finite(y, 'Region y')
  const region = composition.regions[index]
  return replaceRegion(
    composition,
    index,
    positionWithinCanvas(composition, { ...region, x, y }),
  )
}

export function scaleRegion(
  composition: Composition,
  index: 0 | 1,
  scale: number,
): Composition {
  assertFiniteComposition(composition)
  finite(scale, 'Region scale')
  const region = composition.regions[index]
  return replaceRegion(
    composition,
    index,
    fittedRegion(composition, {
      ...region,
      scale: clamp(scale, 0.01, 1),
    }),
  )
}

export function resizeRegion(
  composition: Composition,
  index: 0 | 1,
  corner: ResizeCorner,
  dx: number,
  dy: number,
): Composition {
  assertFiniteComposition(composition)
  finite(dx, 'Resize x delta')
  finite(dy, 'Resize y delta')
  const region = composition.regions[index]
  const size = regionSize(region)
  const west = corner === 'nw' || corner === 'sw'
  const north = corner === 'nw' || corner === 'ne'
  const horizontalScale = region.scale + (west ? -dx : dx) / region.crop.width
  const verticalScale = region.scale + (north ? -dy : dy) / region.crop.height
  const scale =
    Math.abs(horizontalScale - region.scale) >=
    Math.abs(verticalScale - region.scale)
      ? horizontalScale
      : verticalScale
  const anchorX = west ? region.x + size.width : region.x
  const anchorY = north ? region.y + size.height : region.y
  const maximumScale = Math.min(
    1,
    (west ? anchorX : composition.width - anchorX) / region.crop.width,
    (north ? anchorY : composition.height - anchorY) / region.crop.height,
  )
  const resized: VideoRegion = {
    ...region,
    scale: clamp(Math.min(scale, maximumScale), 0.01, 1),
  }
  const resizedSize = regionSize(resized)
  return replaceRegion(
    composition,
    index,
    positionWithinCanvas(composition, {
      ...resized,
      x: west ? anchorX - resizedSize.width : anchorX,
      y: north ? anchorY - resizedSize.height : anchorY,
    }),
  )
}

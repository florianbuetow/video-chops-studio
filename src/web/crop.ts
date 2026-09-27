import type { Crop, VideoMetadata } from '../domain/video.js'
import { fitCrop } from './editor.js'

interface CropControls {
  readonly box: HTMLElement
  readonly frame: HTMLElement
  readonly metadata: () => VideoMetadata | null
  readonly crop: () => Crop
  readonly ratio: () => number | null
  readonly remember: () => void
  readonly update: (crop: Crop) => void
}

function resize(
  initial: Crop,
  corner: string,
  dx: number,
  dy: number,
  ratio: number | null,
  metadata: VideoMetadata,
): Crop {
  const west = corner.includes('w')
  const north = corner.includes('n')
  const anchorX = west ? initial.x + initial.width : initial.x
  const anchorY = north ? initial.y + initial.height : initial.y
  const maxWidth = west ? anchorX : metadata.width - anchorX
  const maxHeight = north ? anchorY : metadata.height - anchorY
  let width = Math.max(2, Math.min(maxWidth, initial.width + (west ? -dx : dx)))
  let height = Math.max(
    2,
    Math.min(maxHeight, initial.height + (north ? -dy : dy)),
  )
  if (ratio !== null) {
    if (Math.abs(dx) > Math.abs(dy)) height = width / ratio
    else width = height * ratio
    const scale = Math.min(1, maxWidth / width, maxHeight / height)
    width *= scale
    height *= scale
  }
  return fitCrop(
    {
      x: west ? anchorX - width : anchorX,
      y: north ? anchorY - height : anchorY,
      width,
      height,
    },
    metadata,
  )
}

export function bindCrop(controls: CropControls): void {
  controls.box.addEventListener('pointerdown', (event) => {
    const metadata = controls.metadata()
    if (metadata === null || event.button !== 0) return
    event.preventDefault()
    const target = event.target
    const corner =
      target instanceof HTMLElement ? target.dataset['corner'] : undefined
    const initial = { ...controls.crop() }
    const x = event.clientX
    const y = event.clientY
    const scale = metadata.width / controls.frame.getBoundingClientRect().width
    controls.remember()
    controls.box.setPointerCapture(event.pointerId)
    const move = (current: PointerEvent): void => {
      const dx = (current.clientX - x) * scale
      const dy = (current.clientY - y) * scale
      controls.update(
        corner === undefined
          ? fitCrop(
              { ...initial, x: initial.x + dx, y: initial.y + dy },
              metadata,
            )
          : resize(initial, corner, dx, dy, controls.ratio(), metadata),
      )
    }
    const stop = (): void => {
      controls.box.removeEventListener('pointermove', move)
      controls.box.removeEventListener('pointerup', stop)
      controls.box.removeEventListener('pointercancel', stop)
    }
    controls.box.addEventListener('pointermove', move)
    controls.box.addEventListener('pointerup', stop)
    controls.box.addEventListener('pointercancel', stop)
  })
  controls.box.addEventListener('keydown', (event) => {
    const metadata = controls.metadata()
    const target = event.target
    if (
      metadata === null ||
      !(target instanceof HTMLElement) ||
      !event.key.startsWith('Arrow')
    )
      return
    event.preventDefault()
    const corner = target.dataset['corner']
    if (corner === undefined) return
    const step = event.shiftKey ? 20 : 2
    const dx =
      event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0
    const dy =
      event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0
    controls.remember()
    controls.update(
      resize(controls.crop(), corner, dx, dy, controls.ratio(), metadata),
    )
  })
}

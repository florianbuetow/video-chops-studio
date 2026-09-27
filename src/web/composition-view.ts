import {
  regionSize,
  type Composition,
  type VideoMetadata,
} from '../domain/video.js'
import { bindCrop } from './crop.js'
import {
  moveRegion,
  resizeRegion,
  updateRegionCrop,
  type ResizeCorner,
} from './composition.js'
import { element, InterfaceError } from './dom.js'
import { even, fitCrop } from './editor.js'

interface CompositionControls {
  readonly video: HTMLVideoElement
  readonly sourceFrame: HTMLElement
  readonly metadata: () => VideoMetadata | null
  readonly value: () => Composition | null
  readonly selected: () => 0 | 1
  readonly canEdit: () => boolean
  readonly ready: () => boolean
  readonly remember: () => void
  readonly update: (value: Composition) => void
  readonly select: (index: 0 | 1) => void
  readonly onError: (error: Error) => void
}

function resizeCorner(target: EventTarget | null): ResizeCorner | null {
  if (!(target instanceof HTMLElement)) return null
  const corner = target.dataset['corner']
  return corner === 'nw' ||
    corner === 'ne' ||
    corner === 'sw' ||
    corner === 'se'
    ? corner
    : null
}

export function bindCompositionView(controls: CompositionControls): {
  render(): void
  drawOutput(): void
  cancelDrawing(): void
} {
  const canvas = element('output-canvas', 'canvas')
  const outputStage = element('output-stage', 'div')
  const outputFrame = element('output-frame', 'div')
  const sourceBoxes = [
    element('source-region-1', 'div'),
    element('source-region-2', 'div'),
  ] as const
  const outputBoxes = [
    element('output-region-1', 'div'),
    element('output-region-2', 'div'),
  ] as const
  const drawButtons = [
    element('draw-region-1', 'button'),
    element('draw-region-2', 'button'),
  ] as const
  let drawing: 0 | 1 | null = null
  let canvasErrorShown = false
  let backgroundName: string | undefined
  let backgroundImage: HTMLImageElement | null = null

  function syncBackground(composition: Composition): void {
    if (composition.backgroundImage === backgroundName) return
    backgroundName = composition.backgroundImage
    backgroundImage = null
    if (backgroundName === undefined) return
    const image = document.createElement('img')
    backgroundImage = image
    image.addEventListener('load', () => {
      if (backgroundImage === image) drawOutput()
    })
    image.addEventListener('error', () => {
      if (backgroundImage === image)
        controls.onError(
          new InterfaceError(
            'The background image could not be loaded. Choose it again or remove it.',
          ),
        )
    })
    image.src = `/api/background?name=${encodeURIComponent(backgroundName)}`
  }

  function paintFrame(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    border: NonNullable<Composition['frame']>,
  ): void {
    const thickness = Math.min(border.width, width / 2, height / 2)
    context.fillStyle = border.color
    context.fillRect(x, y, width, thickness)
    context.fillRect(x, y + height - thickness, width, thickness)
    context.fillRect(x, y, thickness, height)
    context.fillRect(x + width - thickness, y, thickness, height)
  }

  function renderDrawing(): void {
    controls.sourceFrame.dataset['drawing'] = String(drawing !== null)
    for (const index of [0, 1] as const)
      drawButtons[index].setAttribute('aria-pressed', String(drawing === index))
    element('composition-hint', 'p').textContent =
      drawing === null
        ? 'Move a region or drag a corner to shrink it. Maximum size: 100%.'
        : `Drag on the source to draw region ${drawing + 1}. Escape cancels.`
  }

  function cancelDrawing(): void {
    drawing = null
    renderDrawing()
  }

  function drawOutput(): void {
    const composition = controls.value()
    const metadata = controls.metadata()
    if (composition === null || metadata === null) return
    syncBackground(composition)
    const context = canvas.getContext('2d')
    if (context === null) {
      if (!canvasErrorShown)
        controls.onError(
          new InterfaceError('Your browser cannot render the output canvas.'),
        )
      canvasErrorShown = true
      return
    }
    canvasErrorShown = false
    if (canvas.width !== composition.width) canvas.width = composition.width
    if (canvas.height !== composition.height) canvas.height = composition.height
    context.fillStyle = composition.background
    context.fillRect(0, 0, composition.width, composition.height)
    if (
      backgroundImage !== null &&
      backgroundImage.complete &&
      backgroundImage.naturalWidth > 0 &&
      backgroundImage.naturalHeight > 0
    ) {
      const scale = Math.max(
        composition.width / backgroundImage.naturalWidth,
        composition.height / backgroundImage.naturalHeight,
      )
      const width = composition.width / scale
      const height = composition.height / scale
      context.drawImage(
        backgroundImage,
        (backgroundImage.naturalWidth - width) / 2,
        (backgroundImage.naturalHeight - height) / 2,
        width,
        height,
        0,
        0,
        composition.width,
        composition.height,
      )
    }
    if (
      controls.ready() &&
      controls.video.readyState >= 2 &&
      controls.video.videoWidth > 0
    ) {
      const sourceScaleX = controls.video.videoWidth / metadata.width
      const sourceScaleY = controls.video.videoHeight / metadata.height
      for (const region of composition.regions) {
        const size = regionSize(region)
        context.drawImage(
          controls.video,
          region.crop.x * sourceScaleX,
          region.crop.y * sourceScaleY,
          region.crop.width * sourceScaleX,
          region.crop.height * sourceScaleY,
          region.x,
          region.y,
          size.width,
          size.height,
        )
        if (composition.frame?.target === 'regions')
          paintFrame(
            context,
            region.x,
            region.y,
            size.width,
            size.height,
            composition.frame,
          )
      }
    }
    if (composition.frame?.target === 'canvas')
      paintFrame(
        context,
        0,
        0,
        composition.width,
        composition.height,
        composition.frame,
      )
  }

  function render(): void {
    const composition = controls.value()
    const metadata = controls.metadata()
    for (const box of sourceBoxes) box.hidden = composition === null
    if (composition === null || metadata === null) {
      cancelDrawing()
      return
    }
    const sourceScale =
      controls.sourceFrame.getBoundingClientRect().width / metadata.width
    const outputScale = Math.max(
      0,
      Math.min(
        (outputStage.clientWidth - 32) / composition.width,
        (outputStage.clientHeight - 32) / composition.height,
      ),
    )
    outputFrame.style.width = `${composition.width * outputScale}px`
    outputFrame.style.height = `${composition.height * outputScale}px`
    for (const index of [0, 1] as const) {
      const region = composition.regions[index]
      const source = sourceBoxes[index]
      source.style.left = `${region.crop.x * sourceScale}px`
      source.style.top = `${region.crop.y * sourceScale}px`
      source.style.width = `${region.crop.width * sourceScale}px`
      source.style.height = `${region.crop.height * sourceScale}px`
      source.dataset['selected'] = String(controls.selected() === index)
      source.style.zIndex = controls.selected() === index ? '2' : '1'
      const size = regionSize(region)
      const destination = outputBoxes[index]
      destination.style.left = `${region.x * outputScale}px`
      destination.style.top = `${region.y * outputScale}px`
      destination.style.width = `${size.width * outputScale}px`
      destination.style.height = `${size.height * outputScale}px`
      destination.dataset['selected'] = String(controls.selected() === index)
      destination.style.zIndex = controls.selected() === index ? '2' : '1'
      drawButtons[index].disabled = !controls.canEdit()
    }
    renderDrawing()
    drawOutput()
  }

  for (const index of [0, 1] as const) {
    const source = sourceBoxes[index]
    source.addEventListener('pointerdown', () => {
      if (controls.canEdit() && drawing === null) controls.select(index)
    })
    source.addEventListener('focusin', () => {
      if (controls.canEdit()) controls.select(index)
    })
    bindCrop({
      box: source,
      frame: controls.sourceFrame,
      metadata: () =>
        controls.canEdit() && drawing === null && controls.value() !== null
          ? controls.metadata()
          : null,
      crop: () => {
        const value = controls.value()
        if (value === null)
          throw new InterfaceError(
            'Choose Two regions before editing a region.',
          )
        return value.regions[index].crop
      },
      ratio: () => null,
      remember: controls.remember,
      update: (crop) => {
        const value = controls.value()
        if (value !== null)
          controls.update(updateRegionCrop(value, index, crop))
      },
    })
    drawButtons[index].addEventListener('click', () => {
      if (!controls.canEdit()) return
      drawing = drawing === index ? null : index
      controls.select(index)
      renderDrawing()
    })

    const destination = outputBoxes[index]
    destination.addEventListener('focusin', () => {
      if (controls.canEdit()) controls.select(index)
    })
    destination.addEventListener('pointerdown', (event) => {
      const initial = controls.value()
      if (initial === null || !controls.canEdit() || event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      cancelDrawing()
      controls.select(index)
      controls.remember()
      const corner = resizeCorner(event.target)
      const x = event.clientX
      const y = event.clientY
      const scale = initial.width / outputFrame.getBoundingClientRect().width
      destination.setPointerCapture(event.pointerId)
      const move = (current: PointerEvent): void => {
        const dx = (current.clientX - x) * scale
        const dy = (current.clientY - y) * scale
        controls.update(
          corner === null
            ? moveRegion(
                initial,
                index,
                initial.regions[index].x + dx,
                initial.regions[index].y + dy,
              )
            : resizeRegion(initial, index, corner, dx, dy),
        )
      }
      const stop = (): void => {
        destination.removeEventListener('pointermove', move)
        destination.removeEventListener('pointerup', stop)
        destination.removeEventListener('pointercancel', stop)
      }
      destination.addEventListener('pointermove', move)
      destination.addEventListener('pointerup', stop)
      destination.addEventListener('pointercancel', stop)
    })
    destination.addEventListener('keydown', (event) => {
      const value = controls.value()
      if (
        value === null ||
        !controls.canEdit() ||
        !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      )
        return
      event.preventDefault()
      event.stopPropagation()
      controls.select(index)
      controls.remember()
      const step = event.shiftKey ? 20 : 2
      const dx =
        event.key === 'ArrowLeft'
          ? -step
          : event.key === 'ArrowRight'
            ? step
            : 0
      const dy =
        event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      const corner = resizeCorner(event.target)
      controls.update(
        corner === null
          ? moveRegion(
              value,
              index,
              value.regions[index].x + dx,
              value.regions[index].y + dy,
            )
          : resizeRegion(value, index, corner, dx, dy),
      )
    })
  }

  controls.sourceFrame.addEventListener('pointerdown', (event) => {
    const composition = controls.value()
    const metadata = controls.metadata()
    if (
      drawing === null ||
      composition === null ||
      metadata === null ||
      !controls.canEdit() ||
      event.button !== 0
    )
      return
    event.preventDefault()
    const index = drawing
    const bounds = controls.sourceFrame.getBoundingClientRect()
    const scaleX = metadata.width / bounds.width
    const scaleY = metadata.height / bounds.height
    const originX = Math.max(
      0,
      Math.min(metadata.width - 2, (event.clientX - bounds.left) * scaleX),
    )
    const originY = Math.max(
      0,
      Math.min(metadata.height - 2, (event.clientY - bounds.top) * scaleY),
    )
    controls.remember()
    controls.sourceFrame.setPointerCapture(event.pointerId)
    const move = (current: PointerEvent): void => {
      if (drawing === null) return
      const x = Math.max(
        0,
        Math.min(metadata.width, (current.clientX - bounds.left) * scaleX),
      )
      const y = Math.max(
        0,
        Math.min(metadata.height, (current.clientY - bounds.top) * scaleY),
      )
      if (Math.abs(x - originX) < 2 || Math.abs(y - originY) < 2) return
      const crop = fitCrop(
        {
          x: even(Math.min(originX, x)),
          y: even(Math.min(originY, y)),
          width: even(Math.abs(x - originX)),
          height: even(Math.abs(y - originY)),
        },
        metadata,
      )
      controls.update(updateRegionCrop(composition, index, crop))
    }
    const stop = (): void => {
      controls.sourceFrame.removeEventListener('pointermove', move)
      controls.sourceFrame.removeEventListener('pointerup', stop)
      controls.sourceFrame.removeEventListener('pointercancel', stop)
      cancelDrawing()
    }
    controls.sourceFrame.addEventListener('pointermove', move)
    controls.sourceFrame.addEventListener('pointerup', stop)
    controls.sourceFrame.addEventListener('pointercancel', stop)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancelDrawing()
  })
  controls.video.addEventListener('seeked', drawOutput)
  controls.video.addEventListener('loadeddata', drawOutput)
  new ResizeObserver(render).observe(outputStage)
  return { render, drawOutput, cancelDrawing }
}

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type {
  Composition,
  CompositionFrame,
  Crop,
  VideoMetadata,
  VideoRegion,
} from '../../src/domain/video.js'
import { resizeRegion, updateRegionCrop } from '../../src/web/composition.js'
import { bindCompositionView } from '../../src/web/composition-view.js'
import { InterfaceError } from '../../src/web/dom.js'
import {
  BrowserElement,
  BrowserEvent,
  BrowserEventTarget,
  BrowserFixture,
  BrowserVideo,
} from '../helpers/browser-dom.js'

type EventOptions = ConstructorParameters<typeof BrowserEvent>[1]
type Index = 0 | 1

interface State {
  composition: Composition | null
  metadata: VideoMetadata | null
  selected: Index
  canEdit: boolean
  ready: boolean
}

interface BindOptions {
  readonly composition?: Composition | null
  readonly metadata?: VideoMetadata | null
  readonly selected?: Index
  readonly canEdit?: boolean
  readonly ready?: boolean
  readonly stage?: { readonly width: number; readonly height: number }
  readonly before?: (fixture: BrowserFixture) => void
}

type FakeImage = BrowserElement & {
  complete: boolean
  naturalWidth: number
  naturalHeight: number
  src: string
}

type FakeCanvas = BrowserElement & { width: number; height: number }

interface Harness {
  readonly fixture: BrowserFixture
  readonly state: State
  readonly view: ReturnType<typeof bindCompositionView>
  readonly video: BrowserVideo
  readonly frame: BrowserElement
  readonly canvas: FakeCanvas
  readonly source: readonly [BrowserElement, BrowserElement]
  readonly output: readonly [BrowserElement, BrowserElement]
  readonly draw: readonly [BrowserElement, BrowserElement]
  readonly createElement: Mock<(tag: string) => BrowserElement>
  readonly value: Mock<() => Composition | null>
  readonly remember: Mock<() => void>
  readonly update: Mock<(value: Composition) => void>
  readonly select: Mock<(index: Index) => void>
  readonly onError: Mock<(error: Error) => void>
}

const METADATA: VideoMetadata = {
  name: 'clip.mp4',
  size: 1000,
  width: 1080,
  height: 1920,
  duration: 20,
  fps: 25,
  hasAudio: true,
}

const REGION_ONE: VideoRegion = {
  crop: { x: 100, y: 240, width: 400, height: 600 },
  x: 20,
  y: 40,
  scale: 0.75,
}

const REGION_TWO: VideoRegion = {
  crop: { x: 400, y: 1000, width: 600, height: 200 },
  x: 60,
  y: 400,
  scale: 0.25,
}

const COMPOSITION: Composition = {
  width: 400,
  height: 800,
  background: '#102030',
  regions: [REGION_ONE, REGION_TWO],
}

const HINT_IDLE =
  'Move a region or drag a corner to shrink it. Maximum size: 100%.'

let activeFixture: BrowserFixture | undefined

afterEach(() => {
  activeFixture?.dispose()
  activeFixture = undefined
})

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  }
}

function withRegion(
  index: Index,
  region: VideoRegion,
  base: Composition = COMPOSITION,
): Composition {
  return {
    ...base,
    regions:
      index === 0 ? [region, base.regions[1]] : [base.regions[0], region],
  }
}

function moved(index: Index, x: number, y: number): Composition {
  return withRegion(index, { ...COMPOSITION.regions[index], x, y })
}

function withFrame(frame: CompositionFrame): Composition {
  return { ...COMPOSITION, frame }
}

function withImage(name: string): Composition {
  return { ...COMPOSITION, backgroundImage: name }
}

function bind(options: BindOptions = {}): Harness {
  const fixture = new BrowserFixture()
  activeFixture = fixture
  fixture.autoLoadImages = false
  options.before?.(fixture)
  const state: State = {
    composition:
      options.composition === undefined ? COMPOSITION : options.composition,
    metadata: options.metadata === undefined ? METADATA : options.metadata,
    selected: options.selected ?? 0,
    canEdit: options.canEdit ?? true,
    ready: options.ready ?? true,
  }
  const video = fixture.element('video') as BrowserVideo
  video.readyState = 4
  video.videoWidth = 540
  video.videoHeight = 480
  const frame = fixture.element('video-frame')
  frame.getBoundingClientRect = () => rect(30, 10, 270, 960)
  const stage = fixture.element('output-stage')
  stage.clientWidth = options.stage?.width ?? 232
  stage.clientHeight = options.stage?.height ?? 832
  const createElement = vi.spyOn(fixture.document, 'createElement')
  const value = vi.fn<() => Composition | null>(() => state.composition)
  const remember = vi.fn<() => void>()
  const update = vi.fn<(value: Composition) => void>()
  const select = vi.fn<(index: Index) => void>()
  const onError = vi.fn<(error: Error) => void>()
  const view = bindCompositionView({
    video: video as unknown as HTMLVideoElement,
    sourceFrame: frame as unknown as HTMLElement,
    metadata: () => state.metadata,
    value,
    selected: () => state.selected,
    canEdit: () => state.canEdit,
    ready: () => state.ready,
    remember,
    update,
    select,
    onError,
  })
  return {
    fixture,
    state,
    view,
    video,
    frame,
    canvas: fixture.element('output-canvas') as FakeCanvas,
    source: [
      fixture.element('source-region-1'),
      fixture.element('source-region-2'),
    ],
    output: [
      fixture.element('output-region-1'),
      fixture.element('output-region-2'),
    ],
    draw: [fixture.element('draw-region-1'), fixture.element('draw-region-2')],
    createElement,
    value,
    remember,
    update,
    select,
    onError,
  }
}

function fire(
  harness: Harness,
  target: BrowserEventTarget,
  type: string,
  options: EventOptions = {},
): BrowserEvent {
  const event = harness.fixture.event(type, options)
  target.dispatchEvent(event)
  return event
}

function addHandle(
  harness: Harness,
  parent: BrowserElement,
  corner: string,
): BrowserElement {
  const handle = harness.fixture.document.createElement('button')
  handle.dataset['corner'] = corner
  handle.parentElement = parent
  parent.children.push(handle)
  return handle
}

function box(element: BrowserElement): Record<string, string | undefined> {
  return {
    left: element.style['left'],
    top: element.style['top'],
    width: element.style['width'],
    height: element.style['height'],
    zIndex: element.style['zIndex'],
    selected: element.dataset['selected'],
  }
}

function hint(harness: Harness): string {
  return harness.fixture.element('composition-hint').textContent
}

function drawingState(harness: Harness): {
  drawing: string | undefined
  pressed: Array<string | null>
  hint: string
} {
  return {
    drawing: harness.frame.dataset['drawing'],
    pressed: harness.draw.map((button) => button.getAttribute('aria-pressed')),
    hint: hint(harness),
  }
}

function resetPaint(harness: Harness): void {
  harness.fixture.canvasDraw.mockClear()
  harness.fixture.canvasFill.mockClear()
  harness.fixture.canvasFillStyles.length = 0
}

function paintOps(harness: Harness): unknown[][] {
  const { canvasDraw, canvasFill } = harness.fixture
  const ops: Array<{ readonly order: number; readonly op: unknown[] }> = []
  canvasFill.mock.calls.forEach((args, position) => {
    ops.push({
      order: canvasFill.mock.invocationCallOrder[position] ?? -1,
      op: ['fillRect', ...args],
    })
  })
  canvasDraw.mock.calls.forEach((args, position) => {
    const [source, ...rest] = args
    ops.push({
      order: canvasDraw.mock.invocationCallOrder[position] ?? -1,
      op: ['drawImage', source === harness.video ? 'video' : 'image', ...rest],
    })
  })
  return ops.sort((left, right) => left.order - right.order).map(({ op }) => op)
}

function images(harness: Harness): FakeImage[] {
  return harness.createElement.mock.results
    .map((result) => result.value as BrowserElement)
    .filter((element) => element.tagName === 'IMG') as FakeImage[]
}

function loadImage(image: FakeImage, width: number, height: number): void {
  image.complete = true
  image.naturalWidth = width
  image.naturalHeight = height
}

const BACKGROUND_FILL = ['fillRect', 0, 0, 400, 800]
const VIDEO_REGION_ONE = [
  'drawImage',
  'video',
  50,
  60,
  200,
  150,
  20,
  40,
  300,
  450,
]
const VIDEO_REGION_TWO = [
  'drawImage',
  'video',
  200,
  250,
  300,
  50,
  60,
  400,
  150,
  50,
]

describe('composition view canvas painting', () => {
  it('paints the background and both regions with video-to-source scaling in order', () => {
    const harness = bind()
    resetPaint(harness)
    harness.view.drawOutput()
    expect(paintOps(harness)).toEqual([
      BACKGROUND_FILL,
      VIDEO_REGION_ONE,
      VIDEO_REGION_TWO,
    ])
    expect(harness.fixture.canvasFillStyles).toEqual(['#102030'])
  })

  it('paints from the initial render triggered by observing the output stage', () => {
    const harness = bind()
    expect(harness.canvas.width).toBe(400)
    expect(harness.canvas.height).toBe(800)
    expect(paintOps(harness)).toEqual([
      BACKGROUND_FILL,
      VIDEO_REGION_ONE,
      VIDEO_REGION_TWO,
    ])
    expect(box(harness.output[0])['left']).toBe('10px')
  })

  it('observes the output stage and renders when the observer fires', () => {
    const observed: unknown[] = []
    let notify: (() => void) | undefined
    const harness = bind({
      before: () => {
        vi.stubGlobal(
          'ResizeObserver',
          class {
            constructor(callback: () => void) {
              notify = callback
            }
            observe(target: unknown): void {
              observed.push(target)
            }
            disconnect(): void {}
            unobserve(): void {}
          },
        )
      },
    })
    expect(observed).toHaveLength(1)
    expect(observed[0]).toBe(harness.fixture.element('output-stage'))
    expect(harness.output[0].style['left']).toBeUndefined()
    expect(harness.canvas.width).toBe(300)
    notify?.()
    expect(harness.output[0].style['left']).toBe('10px')
    expect(harness.canvas.width).toBe(400)
  })

  it.each([
    {
      name: 'the video is not ready',
      readyState: 4,
      videoWidth: 540,
      controlsReady: false,
      paints: false,
    },
    {
      name: 'the video has no current frame',
      readyState: 1,
      videoWidth: 540,
      controlsReady: true,
      paints: false,
    },
    {
      name: 'the video has its current frame',
      readyState: 2,
      videoWidth: 540,
      controlsReady: true,
      paints: true,
    },
    {
      name: 'the video has no width',
      readyState: 4,
      videoWidth: 0,
      controlsReady: true,
      paints: false,
    },
    {
      name: 'the video is one pixel wide',
      readyState: 4,
      videoWidth: 1,
      controlsReady: true,
      paints: true,
    },
  ])('draws video regions only when $name', (row) => {
    const harness = bind({ ready: row.controlsReady })
    harness.video.readyState = row.readyState
    harness.video.videoWidth = row.videoWidth
    resetPaint(harness)
    harness.view.drawOutput()
    const ops = paintOps(harness)
    if (row.paints) {
      expect(ops).toHaveLength(3)
      expect(ops[0]).toEqual(BACKGROUND_FILL)
      expect(ops[1]?.slice(0, 2)).toEqual(['drawImage', 'video'])
      expect(ops[2]?.slice(0, 2)).toEqual(['drawImage', 'video'])
    } else {
      expect(ops).toEqual([BACKGROUND_FILL])
    }
  })

  it('scales each region crop by the ratio of video pixels to source pixels', () => {
    const harness = bind()
    harness.video.videoWidth = 1080
    harness.video.videoHeight = 960
    resetPaint(harness)
    harness.view.drawOutput()
    expect(paintOps(harness)).toEqual([
      BACKGROUND_FILL,
      ['drawImage', 'video', 100, 120, 400, 300, 20, 40, 300, 450],
      ['drawImage', 'video', 400, 500, 600, 100, 60, 400, 150, 50],
    ])
  })

  it('paints frames around regions after each region', () => {
    const harness = bind({
      composition: withFrame({
        target: 'regions',
        color: '#fedcba',
        width: 12,
      }),
    })
    resetPaint(harness)
    harness.view.drawOutput()
    expect(paintOps(harness)).toEqual([
      BACKGROUND_FILL,
      VIDEO_REGION_ONE,
      ['fillRect', 20, 40, 300, 12],
      ['fillRect', 20, 478, 300, 12],
      ['fillRect', 20, 40, 12, 450],
      ['fillRect', 308, 40, 12, 450],
      VIDEO_REGION_TWO,
      ['fillRect', 60, 400, 150, 12],
      ['fillRect', 60, 438, 150, 12],
      ['fillRect', 60, 400, 12, 50],
      ['fillRect', 198, 400, 12, 50],
    ])
    expect(harness.fixture.canvasFillStyles).toEqual([
      '#102030',
      '#fedcba',
      '#fedcba',
    ])
  })

  it('limits the frame thickness to half of the narrower region side', () => {
    const harness = bind({
      composition: withFrame({
        target: 'regions',
        color: '#00ff00',
        width: 500,
      }),
    })
    resetPaint(harness)
    harness.view.drawOutput()
    expect(paintOps(harness)).toEqual([
      BACKGROUND_FILL,
      VIDEO_REGION_ONE,
      ['fillRect', 20, 40, 300, 150],
      ['fillRect', 20, 340, 300, 150],
      ['fillRect', 20, 40, 150, 450],
      ['fillRect', 170, 40, 150, 450],
      VIDEO_REGION_TWO,
      ['fillRect', 60, 400, 150, 25],
      ['fillRect', 60, 425, 150, 25],
      ['fillRect', 60, 400, 25, 50],
      ['fillRect', 185, 400, 25, 50],
    ])
  })

  it.each([
    {
      name: 'ready',
      ready: true,
      before: [BACKGROUND_FILL, VIDEO_REGION_ONE, VIDEO_REGION_TWO],
    },
    { name: 'not ready', ready: false, before: [BACKGROUND_FILL] },
  ])('paints a canvas frame once after the regions when $name', (row) => {
    const harness = bind({
      ready: row.ready,
      composition: withFrame({ target: 'canvas', color: '#0000ff', width: 8 }),
    })
    resetPaint(harness)
    harness.view.drawOutput()
    expect(paintOps(harness)).toEqual([
      ...row.before,
      ['fillRect', 0, 0, 400, 8],
      ['fillRect', 0, 792, 400, 8],
      ['fillRect', 0, 0, 8, 800],
      ['fillRect', 392, 0, 8, 800],
    ])
    expect(harness.fixture.canvasFillStyles).toEqual(['#102030', '#0000ff'])
  })

  it('limits a canvas frame to half of the canvas width', () => {
    const harness = bind({
      composition: withFrame({
        target: 'canvas',
        color: '#0000ff',
        width: 500,
      }),
      ready: false,
    })
    resetPaint(harness)
    harness.view.drawOutput()
    expect(paintOps(harness)).toEqual([
      BACKGROUND_FILL,
      ['fillRect', 0, 0, 400, 200],
      ['fillRect', 0, 600, 400, 200],
      ['fillRect', 0, 0, 200, 800],
      ['fillRect', 200, 0, 200, 800],
    ])
  })

  it('skips frames when the composition has none', () => {
    const harness = bind({ ready: false })
    resetPaint(harness)
    harness.view.drawOutput()
    expect(paintOps(harness)).toEqual([BACKGROUND_FILL])
  })

  it('writes the canvas size only when it differs from the composition size', () => {
    const harness = bind()
    const writes: string[] = []
    for (const key of ['width', 'height'] as const) {
      let current = harness.canvas[key]
      Object.defineProperty(harness.canvas, key, {
        configurable: true,
        get: () => current,
        set: (next: number) => {
          writes.push(`${key}=${next}`)
          current = next
        },
      })
    }
    harness.view.drawOutput()
    expect(writes).toEqual([])
    harness.state.composition = { ...COMPOSITION, width: 200 }
    harness.view.drawOutput()
    expect(writes).toEqual(['width=200'])
    expect(harness.canvas.width).toBe(200)
    expect(harness.canvas.height).toBe(800)
    harness.state.composition = { ...COMPOSITION, width: 200, height: 100 }
    harness.view.drawOutput()
    expect(writes).toEqual(['width=200', 'height=100'])
    harness.view.drawOutput()
    expect(writes).toEqual(['width=200', 'height=100'])
    expect(harness.fixture.canvasFill).toHaveBeenLastCalledWith(0, 0, 200, 100)
  })

  it('paints nothing without a composition', () => {
    const harness = bind({ composition: null })
    resetPaint(harness)
    harness.view.drawOutput()
    expect(paintOps(harness)).toEqual([])
    expect(harness.canvas.width).toBe(300)
  })

  it('paints nothing and requests no background without video metadata', () => {
    const harness = bind({
      composition: withImage('backdrop.png'),
      metadata: null,
    })
    resetPaint(harness)
    harness.view.drawOutput()
    expect(paintOps(harness)).toEqual([])
    expect(images(harness)).toHaveLength(0)
    expect(harness.canvas.width).toBe(300)
  })

  it('redraws when the video seeks or loads data', () => {
    const harness = bind()
    for (const type of ['seeked', 'loadeddata']) {
      resetPaint(harness)
      fire(harness, harness.video, type)
      expect(paintOps(harness)).toEqual([
        BACKGROUND_FILL,
        VIDEO_REGION_ONE,
        VIDEO_REGION_TWO,
      ])
    }
    resetPaint(harness)
    fire(harness, harness.video, 'timeupdate')
    expect(paintOps(harness)).toEqual([])
  })
})

describe('composition view canvas availability', () => {
  const unavailable = 'Your browser cannot render the output canvas.'

  it('reports a missing canvas context once and re-arms after a successful paint', () => {
    const harness = bind({
      before: (fixture) => {
        fixture.canvasAvailable = false
      },
    })
    expect(harness.onError).toHaveBeenCalledTimes(1)
    const [error] = harness.onError.mock.calls[0] ?? []
    expect(error).toBeInstanceOf(InterfaceError)
    expect(error?.message).toBe(unavailable)
    harness.view.drawOutput()
    harness.view.render()
    expect(harness.onError).toHaveBeenCalledTimes(1)
    expect(harness.fixture.canvasFill).not.toHaveBeenCalled()
    expect(harness.canvas.width).toBe(300)
    expect(harness.canvas.height).toBe(150)

    harness.fixture.canvasAvailable = true
    harness.view.drawOutput()
    expect(harness.onError).toHaveBeenCalledTimes(1)
    expect(harness.fixture.canvasFill).toHaveBeenCalledWith(0, 0, 400, 800)

    harness.fixture.canvasAvailable = false
    harness.view.drawOutput()
    harness.view.drawOutput()
    expect(harness.onError).toHaveBeenCalledTimes(2)
    expect(harness.onError.mock.calls[1]?.[0]?.message).toBe(unavailable)
  })

  it('does not report when a context is available from the start', () => {
    const harness = bind()
    harness.view.drawOutput()
    expect(harness.onError).not.toHaveBeenCalled()
  })

  it('requests a two-dimensional context', () => {
    const harness = bind()
    const getContext = vi.spyOn(
      harness.canvas as unknown as HTMLCanvasElement,
      'getContext',
    )
    harness.view.drawOutput()
    expect(getContext).toHaveBeenCalledExactlyOnceWith('2d')
  })
})

describe('composition view background image', () => {
  it('requests each distinct background once with an encoded url', () => {
    const harness = bind({ composition: withImage('my back&drop.png') })
    expect(images(harness).map((image) => image.src)).toEqual([
      '/api/background?name=my%20back%26drop.png',
    ])
    harness.view.drawOutput()
    harness.view.render()
    expect(images(harness)).toHaveLength(1)

    harness.state.composition = withImage('other/one.png')
    harness.view.drawOutput()
    expect(images(harness).map((image) => image.src)).toEqual([
      '/api/background?name=my%20back%26drop.png',
      '/api/background?name=other%2Fone.png',
    ])
    harness.view.drawOutput()
    expect(images(harness)).toHaveLength(2)
  })

  it('creates no image while the composition has no background image', () => {
    const harness = bind()
    harness.view.drawOutput()
    expect(images(harness)).toHaveLength(0)
  })

  it('stops painting the previous image once the background is removed', () => {
    const harness = bind({ composition: withImage('backdrop.png') })
    const [image] = images(harness)
    if (image === undefined) throw new Error('background image was not created')
    loadImage(image, 400, 800)
    resetPaint(harness)
    harness.view.drawOutput()
    expect(paintOps(harness)[1]).toEqual([
      'drawImage',
      'image',
      0,
      0,
      400,
      800,
      0,
      0,
      400,
      800,
    ])

    harness.state.composition = COMPOSITION
    resetPaint(harness)
    harness.view.drawOutput()
    expect(paintOps(harness)).toEqual([
      BACKGROUND_FILL,
      VIDEO_REGION_ONE,
      VIDEO_REGION_TWO,
    ])
    expect(images(harness)).toHaveLength(1)
  })

  it.each([
    { name: 'it is not complete', complete: false, width: 400, height: 800 },
    { name: 'it has no width', complete: true, width: 0, height: 800 },
    { name: 'it has no height', complete: true, width: 400, height: 0 },
  ])('does not paint the background image when $name', (row) => {
    const harness = bind({ composition: withImage('backdrop.png') })
    const [image] = images(harness)
    if (image === undefined) throw new Error('background image was not created')
    image.complete = row.complete
    image.naturalWidth = row.width
    image.naturalHeight = row.height
    resetPaint(harness)
    harness.view.drawOutput()
    expect(paintOps(harness)).toEqual([
      BACKGROUND_FILL,
      VIDEO_REGION_ONE,
      VIDEO_REGION_TWO,
    ])
  })

  it.each([
    { size: [1600, 800], crop: [600, 0, 400, 800] },
    { size: [400, 1600], crop: [0, 400, 400, 800] },
    { size: [200, 800], crop: [0, 200, 200, 400] },
    { size: [800, 400], crop: [300, 0, 200, 400] },
    { size: [400, 800], crop: [0, 0, 400, 800] },
  ])(
    'cover-fits a $size image into the canvas with source rectangle $crop',
    ({ size, crop }) => {
      const harness = bind({ composition: withImage('backdrop.png') })
      const [image] = images(harness)
      if (image === undefined)
        throw new Error('background image was not created')
      loadImage(image, size[0] ?? 0, size[1] ?? 0)
      resetPaint(harness)
      harness.view.drawOutput()
      expect(paintOps(harness)).toEqual([
        BACKGROUND_FILL,
        ['drawImage', 'image', ...crop, 0, 0, 400, 800],
        VIDEO_REGION_ONE,
        VIDEO_REGION_TWO,
      ])
    },
  )

  it('redraws when the current image loads and ignores a replaced image', () => {
    const harness = bind({ composition: withImage('first.png') })
    harness.state.composition = withImage('second.png')
    harness.view.drawOutput()
    const [stale, current] = images(harness)
    if (stale === undefined || current === undefined)
      throw new Error('background images were not created')
    loadImage(stale, 400, 800)
    loadImage(current, 400, 800)

    resetPaint(harness)
    fire(harness, stale, 'load')
    expect(paintOps(harness)).toEqual([])

    fire(harness, current, 'load')
    expect(paintOps(harness)).toEqual([
      BACKGROUND_FILL,
      ['drawImage', 'image', 0, 0, 400, 800, 0, 0, 400, 800],
      VIDEO_REGION_ONE,
      VIDEO_REGION_TWO,
    ])
    expect(harness.onError).not.toHaveBeenCalled()
  })

  it('reports a failed current image once per error and ignores a replaced image', () => {
    const harness = bind({ composition: withImage('first.png') })
    harness.state.composition = withImage('second.png')
    harness.view.drawOutput()
    const [stale, current] = images(harness)
    if (stale === undefined || current === undefined)
      throw new Error('background images were not created')

    fire(harness, stale, 'error')
    expect(harness.onError).not.toHaveBeenCalled()

    fire(harness, current, 'error')
    expect(harness.onError).toHaveBeenCalledTimes(1)
    const [error] = harness.onError.mock.calls[0] ?? []
    expect(error).toBeInstanceOf(InterfaceError)
    expect(error?.message).toBe(
      'The background image could not be loaded. Choose it again or remove it.',
    )
  })

  it('ignores load and error events of an image after the background is removed', () => {
    const harness = bind({ composition: withImage('first.png') })
    const [image] = images(harness)
    if (image === undefined) throw new Error('background image was not created')
    harness.state.composition = COMPOSITION
    harness.view.drawOutput()
    loadImage(image, 400, 800)
    resetPaint(harness)
    fire(harness, image, 'load')
    fire(harness, image, 'error')
    expect(paintOps(harness)).toEqual([])
    expect(harness.onError).not.toHaveBeenCalled()
  })

  it('paints a background that finishes loading through the browser image events', async () => {
    const harness = bind({
      composition: withImage('backdrop.png'),
      before: (fixture) => {
        fixture.autoLoadImages = true
      },
    })
    resetPaint(harness)
    await harness.fixture.settle()
    expect(paintOps(harness)).toEqual([
      BACKGROUND_FILL,
      ['drawImage', 'image', 400, 0, 400, 800, 0, 0, 400, 800],
      VIDEO_REGION_ONE,
      VIDEO_REGION_TWO,
    ])
    expect(harness.onError).not.toHaveBeenCalled()
  })

  it('reports a background image that fails to load', async () => {
    const harness = bind({
      composition: withImage('broken.png'),
      before: (fixture) => {
        fixture.autoLoadImages = true
        fixture.failingImages.push('broken.png')
      },
    })
    await harness.fixture.settle()
    expect(harness.onError).toHaveBeenCalledTimes(1)
    expect(harness.onError.mock.calls[0]?.[0]?.message).toBe(
      'The background image could not be loaded. Choose it again or remove it.',
    )
  })
})

describe('composition view layout', () => {
  it('positions source and output boxes and marks the selected region', () => {
    const harness = bind()
    expect(harness.source.map((element) => element.hidden)).toEqual([
      false,
      false,
    ])
    expect(harness.fixture.element('output-frame').style['width']).toBe('200px')
    expect(harness.fixture.element('output-frame').style['height']).toBe(
      '400px',
    )
    expect(box(harness.source[0])).toEqual({
      left: '25px',
      top: '60px',
      width: '100px',
      height: '150px',
      zIndex: '2',
      selected: 'true',
    })
    expect(box(harness.source[1])).toEqual({
      left: '100px',
      top: '250px',
      width: '150px',
      height: '50px',
      zIndex: '1',
      selected: 'false',
    })
    expect(box(harness.output[0])).toEqual({
      left: '10px',
      top: '20px',
      width: '150px',
      height: '225px',
      zIndex: '2',
      selected: 'true',
    })
    expect(box(harness.output[1])).toEqual({
      left: '30px',
      top: '200px',
      width: '75px',
      height: '25px',
      zIndex: '1',
      selected: 'false',
    })
  })

  it('swaps the selection styling when the other region is selected', () => {
    const harness = bind({ selected: 1 })
    expect(harness.source.map((element) => element.style['zIndex'])).toEqual([
      '1',
      '2',
    ])
    expect(harness.output.map((element) => element.style['zIndex'])).toEqual([
      '1',
      '2',
    ])
    expect(
      harness.source.map((element) => element.dataset['selected']),
    ).toEqual(['false', 'true'])
    expect(
      harness.output.map((element) => element.dataset['selected']),
    ).toEqual(['false', 'true'])
    harness.state.selected = 0
    harness.view.render()
    expect(harness.output.map((element) => element.style['zIndex'])).toEqual([
      '2',
      '1',
    ])
  })

  it.each([
    {
      name: 'width-limited',
      stage: { width: 232, height: 832 },
      frame: ['200px', '400px'],
      first: ['10px', '20px', '150px', '225px'],
    },
    {
      name: 'height-limited',
      stage: { width: 632, height: 432 },
      frame: ['200px', '400px'],
      first: ['10px', '20px', '150px', '225px'],
    },
    {
      name: 'a quarter of the canvas',
      stage: { width: 132, height: 832 },
      frame: ['100px', '200px'],
      first: ['5px', '10px', '75px', '112.5px'],
    },
    {
      name: 'too narrow for the padding',
      stage: { width: 16, height: 832 },
      frame: ['0px', '0px'],
      first: ['0px', '0px', '0px', '0px'],
    },
    {
      name: 'too short for the padding',
      stage: { width: 232, height: 16 },
      frame: ['0px', '0px'],
      first: ['0px', '0px', '0px', '0px'],
    },
  ])('scales the output frame when the stage is $name', (row) => {
    const harness = bind({ stage: row.stage })
    const frame = harness.fixture.element('output-frame')
    expect([frame.style['width'], frame.style['height']]).toEqual(row.frame)
    const first = harness.output[0]
    expect([
      first.style['left'],
      first.style['top'],
      first.style['width'],
      first.style['height'],
    ]).toEqual(row.first)
  })

  it('rescales source boxes with the source frame width', () => {
    const harness = bind()
    harness.frame.getBoundingClientRect = () => rect(0, 0, 540, 960)
    harness.view.render()
    expect(box(harness.source[0])).toMatchObject({
      left: '50px',
      top: '120px',
      width: '200px',
      height: '300px',
    })
    expect(box(harness.source[1])).toMatchObject({
      left: '200px',
      top: '500px',
      width: '300px',
      height: '100px',
    })
  })

  it.each([true, false])(
    'sets the draw buttons disabled state from canEdit=%s',
    (canEdit) => {
      const harness = bind({ canEdit })
      expect(harness.draw.map((button) => button.disabled)).toEqual([
        !canEdit,
        !canEdit,
      ])
      harness.state.canEdit = !canEdit
      harness.view.render()
      expect(harness.draw.map((button) => button.disabled)).toEqual([
        canEdit,
        canEdit,
      ])
    },
  )

  it('hides the source boxes and leaves geometry alone without a composition', () => {
    const harness = bind()
    harness.state.composition = null
    harness.fixture.element('output-stage').clientWidth = 132
    harness.view.render()
    expect(harness.source.map((element) => element.hidden)).toEqual([
      true,
      true,
    ])
    expect(harness.fixture.element('output-frame').style['width']).toBe('200px')
    harness.state.composition = COMPOSITION
    harness.view.render()
    expect(harness.source.map((element) => element.hidden)).toEqual([
      false,
      false,
    ])
    expect(harness.fixture.element('output-frame').style['width']).toBe('100px')
  })

  it('shows the source boxes but leaves geometry alone without video metadata', () => {
    const harness = bind()
    harness.state.metadata = null
    harness.fixture.element('output-stage').clientWidth = 132
    harness.view.render()
    expect(harness.source.map((element) => element.hidden)).toEqual([
      false,
      false,
    ])
    expect(harness.fixture.element('output-frame').style['width']).toBe('200px')
    expect(box(harness.source[0])['left']).toBe('25px')
  })

  it.each([
    {
      name: 'a composition',
      clear: (state: State) => (state.composition = null),
    },
    {
      name: 'video metadata',
      clear: (state: State) => (state.metadata = null),
    },
  ])('cancels drawing when rendering without $name', ({ clear }) => {
    const harness = bind()
    harness.draw[1].click()
    expect(harness.frame.dataset['drawing']).toBe('true')
    clear(harness.state)
    harness.view.render()
    expect(drawingState(harness)).toEqual({
      drawing: 'false',
      pressed: ['false', 'false'],
      hint: HINT_IDLE,
    })
  })

  it('redraws the canvas after every render', () => {
    const harness = bind()
    resetPaint(harness)
    harness.view.render()
    expect(paintOps(harness)).toEqual([
      BACKGROUND_FILL,
      VIDEO_REGION_ONE,
      VIDEO_REGION_TWO,
    ])
  })
})

describe('composition view draw mode', () => {
  it('starts idle after the first render', () => {
    const harness = bind()
    expect(drawingState(harness)).toEqual({
      drawing: 'false',
      pressed: ['false', 'false'],
      hint: HINT_IDLE,
    })
  })

  it('toggles draw mode per region and selects the region', () => {
    const harness = bind()
    harness.draw[0].click()
    expect(harness.select).toHaveBeenLastCalledWith(0)
    expect(drawingState(harness)).toEqual({
      drawing: 'true',
      pressed: ['true', 'false'],
      hint: 'Drag on the source to draw region 1. Escape cancels.',
    })
    harness.draw[1].click()
    expect(harness.select).toHaveBeenLastCalledWith(1)
    expect(drawingState(harness)).toEqual({
      drawing: 'true',
      pressed: ['false', 'true'],
      hint: 'Drag on the source to draw region 2. Escape cancels.',
    })
    harness.draw[1].click()
    expect(harness.select).toHaveBeenLastCalledWith(1)
    expect(harness.select).toHaveBeenCalledTimes(3)
    expect(drawingState(harness)).toEqual({
      drawing: 'false',
      pressed: ['false', 'false'],
      hint: HINT_IDLE,
    })
  })

  it('ignores draw buttons while editing is not possible', () => {
    const harness = bind({ canEdit: false })
    fire(harness, harness.draw[0], 'click')
    expect(harness.select).not.toHaveBeenCalled()
    expect(drawingState(harness).drawing).toBe('false')
    expect(hint(harness)).toBe(HINT_IDLE)
  })

  it('cancels draw mode through the returned handle', () => {
    const harness = bind()
    harness.draw[0].click()
    harness.view.cancelDrawing()
    expect(drawingState(harness)).toEqual({
      drawing: 'false',
      pressed: ['false', 'false'],
      hint: HINT_IDLE,
    })
    harness.draw[0].click()
    expect(harness.frame.dataset['drawing']).toBe('true')
  })

  it('cancels draw mode on Escape only', () => {
    const harness = bind()
    harness.draw[0].click()
    fire(harness, harness.fixture.document, 'keydown', { key: 'Enter' })
    fire(harness, harness.fixture.document, 'keydown', { key: 'Esc' })
    fire(harness, harness.fixture.document, 'keydown', { key: '' })
    expect(harness.frame.dataset['drawing']).toBe('true')
    fire(harness, harness.fixture.document, 'keydown', { key: 'Escape' })
    expect(drawingState(harness)).toEqual({
      drawing: 'false',
      pressed: ['false', 'false'],
      hint: HINT_IDLE,
    })
  })
})

describe('composition view selection', () => {
  it.each([0, 1] as const)(
    'selects region %s when a source box gets focus',
    (index) => {
      const harness = bind()
      fire(harness, harness.source[index], 'focusin')
      expect(harness.select).toHaveBeenCalledExactlyOnceWith(index)
    },
  )

  it.each([0, 1] as const)(
    'selects region %s when an output box gets focus',
    (index) => {
      const harness = bind()
      fire(harness, harness.output[index], 'focusin')
      expect(harness.select).toHaveBeenCalledExactlyOnceWith(index)
    },
  )

  it.each([0, 1] as const)(
    'does not select region %s by focus while editing is impossible',
    (index) => {
      const harness = bind({ canEdit: false })
      fire(harness, harness.source[index], 'focusin')
      fire(harness, harness.output[index], 'focusin')
      expect(harness.select).not.toHaveBeenCalled()
    },
  )

  it.each([0, 1] as const)(
    'selects region %s when its source box is pressed',
    (index) => {
      const harness = bind()
      fire(harness, harness.source[index], 'pointerdown', { button: 0 })
      expect(harness.select).toHaveBeenCalledExactlyOnceWith(index)
    },
  )

  it('does not select a source box by pointer while drawing or without edit rights', () => {
    const drawing = bind()
    drawing.draw[0].click()
    drawing.select.mockClear()
    fire(drawing, drawing.source[1], 'pointerdown', { button: 0 })
    expect(drawing.select).not.toHaveBeenCalled()

    const locked = bind({ canEdit: false })
    fire(locked, locked.source[0], 'pointerdown', { button: 0 })
    expect(locked.select).not.toHaveBeenCalled()
  })
})

describe('composition view source region cropping', () => {
  it.each([
    {
      index: 0 as const,
      to: { x: 110, y: 95 },
      crop: { x: 140, y: 220, width: 400, height: 600 },
    },
    {
      index: 1 as const,
      to: { x: 105, y: 110 },
      crop: { x: 420, y: 1040, width: 600, height: 200 },
    },
  ])(
    'drags source region $index and updates only its crop',
    ({ index, to, crop }) => {
      const harness = bind()
      const capture = vi.spyOn(harness.source[index], 'setPointerCapture')
      const down = fire(harness, harness.source[index], 'pointerdown', {
        button: 0,
        clientX: 100,
        clientY: 100,
        pointerId: 4,
      })
      expect(down.defaultPrevented).toBe(true)
      expect(harness.remember).toHaveBeenCalledTimes(1)
      expect(capture).toHaveBeenCalledExactlyOnceWith(4)
      expect(harness.update).not.toHaveBeenCalled()
      fire(harness, harness.source[index], 'pointermove', {
        clientX: to.x,
        clientY: to.y,
      })
      expect(harness.update).toHaveBeenCalledTimes(1)
      expect(harness.update).toHaveBeenLastCalledWith(
        withRegion(index, { ...COMPOSITION.regions[index], crop }),
      )
    },
  )

  it('resizes a source region from a corner handle with the keyboard', () => {
    const harness = bind()
    const handle = addHandle(harness, harness.source[0], 'se')
    const event = fire(harness, handle, 'keydown', {
      bubbles: true,
      key: 'ArrowRight',
    })
    expect(event.defaultPrevented).toBe(true)
    expect(harness.remember).toHaveBeenCalledTimes(1)
    expect(harness.update).toHaveBeenCalledExactlyOnceWith(
      withRegion(0, {
        ...REGION_ONE,
        crop: { x: 100, y: 240, width: 402, height: 600 },
      }),
    )
  })

  it('resizes a source region from a corner handle with the pointer', () => {
    const harness = bind()
    const handle = addHandle(harness, harness.source[1], 'sw')
    fire(harness, handle, 'pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 100,
      clientY: 100,
    })
    fire(harness, harness.source[1], 'pointermove', {
      clientX: 95,
      clientY: 105,
    })
    expect(harness.update).toHaveBeenCalledTimes(1)
    expect(harness.update).toHaveBeenLastCalledWith(
      withRegion(1, {
        ...REGION_TWO,
        crop: { x: 380, y: 1000, width: 620, height: 220 },
      }),
    )
  })

  it.each([
    {
      name: 'editing is not possible',
      prepare: (harness: Harness) => {
        harness.state.canEdit = false
      },
    },
    {
      name: 'a region is being drawn',
      prepare: (harness: Harness) => {
        harness.draw[0].click()
      },
    },
    {
      name: 'there is no composition',
      prepare: (harness: Harness) => {
        harness.state.composition = null
      },
    },
  ])('does not crop a source region when $name', ({ prepare }) => {
    const harness = bind()
    prepare(harness)
    const capture = vi.spyOn(harness.source[0], 'setPointerCapture')
    const down = fire(harness, harness.source[0], 'pointerdown', {
      button: 0,
      clientX: 100,
      clientY: 100,
    })
    const handle = addHandle(harness, harness.source[0], 'se')
    const key = fire(harness, handle, 'keydown', {
      bubbles: true,
      key: 'ArrowRight',
    })
    fire(harness, harness.source[0], 'pointermove', {
      clientX: 110,
      clientY: 95,
    })
    expect(down.defaultPrevented).toBe(false)
    expect(key.defaultPrevented).toBe(false)
    expect(capture).not.toHaveBeenCalled()
    expect(harness.remember).not.toHaveBeenCalled()
    expect(harness.update).not.toHaveBeenCalled()
  })

  it('fails with an interface error when the composition disappears before the crop is read', () => {
    const harness = bind()
    harness.value.mockReturnValueOnce(COMPOSITION).mockReturnValue(null)
    expect(() =>
      fire(harness, harness.source[1], 'pointerdown', {
        button: 0,
        clientX: 100,
        clientY: 100,
      }),
    ).toThrowError(
      new InterfaceError('Choose Two regions before editing a region.'),
    )
    expect(harness.update).not.toHaveBeenCalled()
  })

  it('ignores crop updates that arrive after the composition was cleared', () => {
    const harness = bind()
    harness.value
      .mockReturnValueOnce(COMPOSITION)
      .mockReturnValueOnce(COMPOSITION)
      .mockReturnValue(null)
    fire(harness, harness.source[0], 'pointerdown', {
      button: 0,
      clientX: 100,
      clientY: 100,
    })
    fire(harness, harness.source[0], 'pointermove', {
      clientX: 110,
      clientY: 95,
    })
    expect(harness.update).not.toHaveBeenCalled()
  })
})

describe('composition view output region pointer dragging', () => {
  it.each([
    {
      index: 0 as const,
      first: { x: 110, y: 54 },
      second: { x: 105, y: 47 },
      one: { x: 40, y: 48 },
      two: { x: 30, y: 34 },
    },
    {
      index: 1 as const,
      first: { x: 90, y: 54 },
      second: { x: 105, y: 47 },
      one: { x: 40, y: 408 },
      two: { x: 70, y: 394 },
    },
  ])(
    'moves output region $index by pointer deltas scaled to the canvas',
    ({ index, first, second, one, two }) => {
      const harness = bind()
      const target = harness.output[index]
      const capture = vi.spyOn(target, 'setPointerCapture')
      const down = fire(harness, target, 'pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 50,
        pointerId: 7,
      })
      expect(down.defaultPrevented).toBe(true)
      expect(down.propagationStopped).toBe(true)
      expect(capture).toHaveBeenCalledExactlyOnceWith(7)
      expect(harness.select).toHaveBeenCalledExactlyOnceWith(index)
      expect(harness.remember).toHaveBeenCalledTimes(1)
      expect(harness.update).not.toHaveBeenCalled()

      fire(harness, target, 'pointermove', {
        clientX: first.x,
        clientY: first.y,
      })
      expect(harness.update).toHaveBeenCalledTimes(1)
      expect(harness.update).toHaveBeenLastCalledWith(
        moved(index, one.x, one.y),
      )
      fire(harness, target, 'pointermove', {
        clientX: second.x,
        clientY: second.y,
      })
      expect(harness.update).toHaveBeenCalledTimes(2)
      expect(harness.update).toHaveBeenLastCalledWith(
        moved(index, two.x, two.y),
      )
    },
  )

  it('scales pointer deltas by the canvas to output frame ratio', () => {
    const harness = bind({ stage: { width: 132, height: 832 } })
    fire(harness, harness.output[0], 'pointerdown', {
      button: 0,
      clientX: 100,
      clientY: 50,
    })
    fire(harness, harness.output[0], 'pointermove', {
      clientX: 110,
      clientY: 54,
    })
    expect(harness.update).toHaveBeenLastCalledWith(moved(0, 60, 56))
  })

  it.each(['pointerup', 'pointercancel'])(
    'stops dragging on %s and removes its listeners',
    (ending) => {
      const harness = bind()
      const target = harness.output[0]
      const added = vi.spyOn(target, 'addEventListener')
      const removed = vi.spyOn(target, 'removeEventListener')
      fire(harness, target, 'pointerdown', {
        button: 0,
        clientX: 100,
        clientY: 50,
      })
      expect(added.mock.calls.map(([type]) => type)).toEqual([
        'pointermove',
        'pointerup',
        'pointercancel',
      ])
      fire(harness, target, 'pointermove', { clientX: 110, clientY: 54 })
      expect(harness.update).toHaveBeenCalledTimes(1)

      fire(harness, target, ending)
      expect(removed.mock.calls.map(([type]) => type)).toEqual([
        'pointermove',
        'pointerup',
        'pointercancel',
      ])
      removed.mock.calls.forEach(([, listener], position) => {
        expect(listener).toBe(added.mock.calls[position]?.[1])
      })
      fire(harness, target, 'pointermove', { clientX: 130, clientY: 60 })
      expect(harness.update).toHaveBeenCalledTimes(1)
    },
  )

  it('cancels draw mode and selects when a drag starts', () => {
    const harness = bind()
    harness.draw[0].click()
    harness.select.mockClear()
    fire(harness, harness.output[1], 'pointerdown', { button: 0 })
    expect(harness.select).toHaveBeenCalledExactlyOnceWith(1)
    expect(drawingState(harness)).toEqual({
      drawing: 'false',
      pressed: ['false', 'false'],
      hint: HINT_IDLE,
    })
  })

  it.each([
    {
      name: 'there is no composition',
      prepare: (harness: Harness) => {
        harness.state.composition = null
      },
      button: 0,
    },
    {
      name: 'editing is not possible',
      prepare: (harness: Harness) => {
        harness.state.canEdit = false
      },
      button: 0,
    },
    {
      name: 'the primary button is not used',
      prepare: () => undefined,
      button: 2,
    },
  ])('ignores a pointer press when $name', ({ prepare, button }) => {
    const harness = bind()
    harness.draw[0].click()
    harness.select.mockClear()
    prepare(harness)
    const capture = vi.spyOn(harness.output[0], 'setPointerCapture')
    const down = fire(harness, harness.output[0], 'pointerdown', {
      bubbles: true,
      button,
      clientX: 100,
      clientY: 50,
    })
    fire(harness, harness.output[0], 'pointermove', {
      clientX: 110,
      clientY: 54,
    })
    expect(down.defaultPrevented).toBe(false)
    expect(down.propagationStopped).toBe(false)
    expect(capture).not.toHaveBeenCalled()
    expect(harness.select).not.toHaveBeenCalled()
    expect(harness.remember).not.toHaveBeenCalled()
    expect(harness.update).not.toHaveBeenCalled()
    expect(harness.frame.dataset['drawing']).toBe('true')
  })
})

describe('composition view output region resizing', () => {
  const corners = ['nw', 'ne', 'sw', 'se'] as const

  it.each(corners)('resizes from the %s handle by pointer', (corner) => {
    const harness = bind()
    const handle = addHandle(harness, harness.output[0], corner)
    const down = fire(harness, handle, 'pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 100,
      clientY: 50,
    })
    expect(down.defaultPrevented).toBe(true)
    fire(harness, harness.output[0], 'pointermove', {
      clientX: 110,
      clientY: 54,
    })
    expect(harness.update).toHaveBeenCalledExactlyOnceWith(
      resizeRegion(COMPOSITION, 0, corner, 20, 8),
    )
    expect(harness.update).not.toHaveBeenCalledWith(moved(0, 40, 48))
  })

  it.each([
    { corner: 'nw', scale: 0.7, x: 40, y: 70 },
    { corner: 'ne', scale: 0.8, x: 20, y: 10 },
    { corner: 'sw', scale: 0.7, x: 40, y: 40 },
    { corner: 'se', scale: 0.8, x: 20, y: 40 },
  ])('resizes to scale $scale from $corner', ({ corner, scale, x, y }) => {
    const harness = bind()
    const handle = addHandle(harness, harness.output[0], corner)
    fire(harness, handle, 'pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 100,
      clientY: 50,
    })
    fire(harness, harness.output[0], 'pointermove', {
      clientX: 110,
      clientY: 54,
    })
    const region = harness.update.mock.calls[0]?.[0].regions[0]
    expect(region?.scale).toBeCloseTo(scale, 10)
    expect([region?.x, region?.y]).toEqual([x, y])
  })

  it('resizes the second region from its own handle', () => {
    const harness = bind()
    const handle = addHandle(harness, harness.output[1], 'se')
    fire(harness, handle, 'pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 100,
      clientY: 50,
    })
    fire(harness, harness.output[1], 'pointermove', {
      clientX: 90,
      clientY: 46,
    })
    expect(harness.update).toHaveBeenCalledExactlyOnceWith(
      resizeRegion(COMPOSITION, 1, 'se', -20, -8),
    )
    expect(harness.select).toHaveBeenCalledExactlyOnceWith(1)
  })

  it.each(['', 'n', 'NW', 'north', 'e'])(
    'moves instead of resizing for the unknown corner %j',
    (corner) => {
      const harness = bind()
      const handle = addHandle(harness, harness.output[0], corner)
      fire(harness, handle, 'pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 50,
      })
      fire(harness, harness.output[0], 'pointermove', {
        clientX: 110,
        clientY: 54,
      })
      expect(harness.update).toHaveBeenCalledExactlyOnceWith(moved(0, 40, 48))
    },
  )

  it('moves instead of resizing when the event target is not an element', () => {
    const harness = bind()
    const press = harness.fixture.event('pointerdown', {
      button: 0,
      clientX: 100,
      clientY: 50,
    })
    press.target = harness.fixture.window
    harness.output[0].dispatchEvent(press)
    fire(harness, harness.output[0], 'pointermove', {
      clientX: 110,
      clientY: 54,
    })
    expect(harness.update).toHaveBeenCalledExactlyOnceWith(moved(0, 40, 48))
  })

  it('moves when the target element has no corner data', () => {
    const harness = bind()
    const inner = harness.fixture.document.createElement('span')
    inner.parentElement = harness.output[0]
    harness.output[0].children.push(inner)
    fire(harness, inner, 'pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 100,
      clientY: 50,
    })
    fire(harness, harness.output[0], 'pointermove', {
      clientX: 110,
      clientY: 54,
    })
    expect(harness.update).toHaveBeenCalledExactlyOnceWith(moved(0, 40, 48))
  })
})

describe('composition view output region keyboard', () => {
  const nudges = [
    { key: 'ArrowLeft', shiftKey: false, dx: -2, dy: 0 },
    { key: 'ArrowRight', shiftKey: false, dx: 2, dy: 0 },
    { key: 'ArrowUp', shiftKey: false, dx: 0, dy: -2 },
    { key: 'ArrowDown', shiftKey: false, dx: 0, dy: 2 },
    { key: 'ArrowLeft', shiftKey: true, dx: -20, dy: 0 },
    { key: 'ArrowRight', shiftKey: true, dx: 20, dy: 0 },
    { key: 'ArrowUp', shiftKey: true, dx: 0, dy: -20 },
    { key: 'ArrowDown', shiftKey: true, dx: 0, dy: 20 },
  ]

  it.each(
    nudges.flatMap((nudge) => [
      { ...nudge, index: 0 as const },
      { ...nudge, index: 1 as const },
    ]),
  )(
    'nudges region $index by ($dx, $dy) on $key with shift=$shiftKey',
    ({ index, key, shiftKey, dx, dy }) => {
      const harness = bind()
      const region = COMPOSITION.regions[index]
      const event = fire(harness, harness.output[index], 'keydown', {
        bubbles: true,
        key,
        shiftKey,
      })
      expect(event.defaultPrevented).toBe(true)
      expect(event.propagationStopped).toBe(true)
      expect(harness.select).toHaveBeenCalledExactlyOnceWith(index)
      expect(harness.remember).toHaveBeenCalledTimes(1)
      expect(harness.update).toHaveBeenCalledExactlyOnceWith(
        moved(index, region.x + dx, region.y + dy),
      )
    },
  )

  it.each(['a', 'Enter', 'Tab', ' ', 'Home', 'arrowleft', ''])(
    'ignores the %j key',
    (key) => {
      const harness = bind()
      const event = fire(harness, harness.output[0], 'keydown', {
        bubbles: true,
        key,
      })
      expect(event.defaultPrevented).toBe(false)
      expect(event.propagationStopped).toBe(false)
      expect(harness.select).not.toHaveBeenCalled()
      expect(harness.remember).not.toHaveBeenCalled()
      expect(harness.update).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      name: 'there is no composition',
      prepare: (harness: Harness) => {
        harness.state.composition = null
      },
    },
    {
      name: 'editing is not possible',
      prepare: (harness: Harness) => {
        harness.state.canEdit = false
      },
    },
  ])('ignores arrow keys when $name', ({ prepare }) => {
    const harness = bind()
    prepare(harness)
    const event = fire(harness, harness.output[0], 'keydown', {
      bubbles: true,
      key: 'ArrowLeft',
    })
    expect(event.defaultPrevented).toBe(false)
    expect(event.propagationStopped).toBe(false)
    expect(harness.select).not.toHaveBeenCalled()
    expect(harness.remember).not.toHaveBeenCalled()
    expect(harness.update).not.toHaveBeenCalled()
  })

  it.each([
    { corner: 'nw', key: 'ArrowLeft', shiftKey: false, dx: -2, dy: 0 },
    { corner: 'ne', key: 'ArrowUp', shiftKey: false, dx: 0, dy: -2 },
    { corner: 'sw', key: 'ArrowDown', shiftKey: true, dx: 0, dy: 20 },
    { corner: 'se', key: 'ArrowRight', shiftKey: true, dx: 20, dy: 0 },
  ])(
    'resizes from the $corner handle on $key with shift=$shiftKey',
    ({ corner, key, shiftKey, dx, dy }) => {
      const harness = bind()
      const handle = addHandle(harness, harness.output[0], corner)
      const event = fire(harness, handle, 'keydown', {
        bubbles: true,
        key,
        shiftKey,
      })
      expect(event.defaultPrevented).toBe(true)
      expect(harness.update).toHaveBeenCalledExactlyOnceWith(
        resizeRegion(COMPOSITION, 0, corner as 'nw', dx, dy),
      )
      expect(harness.update).not.toHaveBeenCalledWith(
        moved(0, REGION_ONE.x + dx, REGION_ONE.y + dy),
      )
    },
  )

  it('moves when the keyboard event target is not an element', () => {
    const harness = bind()
    const press = harness.fixture.event('keydown', { key: 'ArrowDown' })
    press.target = harness.fixture.window
    harness.output[0].dispatchEvent(press)
    expect(harness.update).toHaveBeenCalledExactlyOnceWith(moved(0, 20, 42))
  })

  it('moves when the keyboard target is an element without a corner', () => {
    const harness = bind()
    const handle = addHandle(harness, harness.output[0], 'middle')
    fire(harness, handle, 'keydown', { bubbles: true, key: 'ArrowUp' })
    expect(harness.update).toHaveBeenCalledExactlyOnceWith(moved(0, 20, 38))
  })
})

describe('composition view source drawing gestures', () => {
  function startDrawing(
    harness: Harness,
    index: Index,
    clientX: number,
    clientY: number,
    pointerId = 3,
  ): BrowserEvent {
    harness.draw[index].click()
    harness.select.mockClear()
    return fire(harness, harness.frame, 'pointerdown', {
      button: 0,
      clientX,
      clientY,
      pointerId,
    })
  }

  function cropUpdate(index: Index, crop: Crop): Composition {
    return updateRegionCrop(COMPOSITION, index, crop)
  }

  it.each([0, 1] as const)(
    'draws a crop for region %s from two pointer positions',
    (index) => {
      const harness = bind()
      const capture = vi.spyOn(harness.frame, 'setPointerCapture')
      const down = startDrawing(harness, index, 57, 74, 9)
      expect(down.defaultPrevented).toBe(true)
      expect(harness.remember).toHaveBeenCalledTimes(1)
      expect(capture).toHaveBeenCalledExactlyOnceWith(9)
      expect(harness.update).not.toHaveBeenCalled()
      fire(harness, harness.frame, 'pointermove', {
        clientX: 165,
        clientY: 330,
      })
      expect(harness.update).toHaveBeenCalledExactlyOnceWith(
        cropUpdate(index, { x: 108, y: 128, width: 432, height: 512 }),
      )
      expect(harness.update.mock.calls[0]?.[0].regions[index].crop).toEqual({
        x: 108,
        y: 128,
        width: 432,
        height: 512,
      })
    },
  )

  it('draws upward and leftward from the origin', () => {
    const harness = bind()
    startDrawing(harness, 0, 57, 74)
    fire(harness, harness.frame, 'pointermove', { clientX: 40, clientY: 30 })
    expect(harness.update).toHaveBeenCalledExactlyOnceWith(
      cropUpdate(0, { x: 40, y: 40, width: 68, height: 88 }),
    )
  })

  it('keeps crop coordinates on even source pixels', () => {
    const harness = bind()
    startDrawing(harness, 0, 57.25, 74.5)
    fire(harness, harness.frame, 'pointermove', {
      clientX: 165.25,
      clientY: 330.5,
    })
    expect(harness.update.mock.calls[0]?.[0].regions[0].crop).toEqual({
      x: 108,
      y: 128,
      width: 432,
      height: 512,
    })
  })

  it('clamps the gesture origin to two pixels inside the bottom-right corner', () => {
    const harness = bind()
    startDrawing(harness, 0, 330, 1010)
    fire(harness, harness.frame, 'pointermove', { clientX: 165, clientY: 330 })
    expect(harness.update).toHaveBeenCalledExactlyOnceWith(
      cropUpdate(0, { x: 540, y: 640, width: 538, height: 1278 }),
    )
  })

  it('clamps the gesture origin to the top-left corner', () => {
    const harness = bind()
    startDrawing(harness, 0, 0, 0)
    fire(harness, harness.frame, 'pointermove', { clientX: 165, clientY: 330 })
    expect(harness.update).toHaveBeenCalledExactlyOnceWith(
      cropUpdate(0, { x: 0, y: 0, width: 540, height: 640 }),
    )
  })

  it('clamps the moving corner to the video bounds', () => {
    const harness = bind()
    startDrawing(harness, 0, 57, 74)
    fire(harness, harness.frame, 'pointermove', {
      clientX: 1000,
      clientY: 2000,
    })
    expect(harness.update).toHaveBeenLastCalledWith(
      cropUpdate(0, { x: 108, y: 128, width: 972, height: 1792 }),
    )
    fire(harness, harness.frame, 'pointermove', { clientX: 0, clientY: 0 })
    expect(harness.update).toHaveBeenLastCalledWith(
      cropUpdate(0, { x: 0, y: 0, width: 108, height: 128 }),
    )
  })

  it.each([
    {
      name: 'both distances are below two pixels',
      x: 57.25,
      y: 74.5,
      draws: false,
    },
    {
      name: 'only the horizontal distance is below two pixels',
      x: 57.25,
      y: 330,
      draws: false,
    },
    {
      name: 'only the vertical distance is below two pixels',
      x: 165,
      y: 74.5,
      draws: false,
    },
    {
      name: 'both distances are exactly two pixels',
      x: 57.5,
      y: 75,
      draws: true,
    },
    {
      name: 'the horizontal distance is exactly two pixels',
      x: 57.5,
      y: 330,
      draws: true,
    },
    {
      name: 'the vertical distance is exactly two pixels',
      x: 165,
      y: 75,
      draws: true,
    },
  ])(
    'draws only when the distances reach two pixels: $name',
    ({ x, y, draws }) => {
      const harness = bind()
      startDrawing(harness, 0, 57, 74)
      fire(harness, harness.frame, 'pointermove', { clientX: x, clientY: y })
      expect(harness.update).toHaveBeenCalledTimes(draws ? 1 : 0)
    },
  )

  it('uses the smallest crop for a two pixel drag', () => {
    const harness = bind()
    startDrawing(harness, 0, 57, 74)
    fire(harness, harness.frame, 'pointermove', { clientX: 57.5, clientY: 75 })
    expect(harness.update).toHaveBeenCalledExactlyOnceWith(
      cropUpdate(0, { x: 108, y: 128, width: 2, height: 2 }),
    )
  })

  it.each(['pointerup', 'pointercancel'])(
    'ends the gesture and draw mode on %s',
    (ending) => {
      const harness = bind()
      const added = vi.spyOn(harness.frame, 'addEventListener')
      const removed = vi.spyOn(harness.frame, 'removeEventListener')
      startDrawing(harness, 1, 57, 74)
      expect(added.mock.calls.map(([type]) => type)).toEqual([
        'pointermove',
        'pointerup',
        'pointercancel',
      ])
      fire(harness, harness.frame, 'pointermove', {
        clientX: 165,
        clientY: 330,
      })
      expect(harness.update).toHaveBeenCalledTimes(1)
      expect(harness.frame.dataset['drawing']).toBe('true')

      fire(harness, harness.frame, ending)
      expect(removed.mock.calls.map(([type]) => type)).toEqual([
        'pointermove',
        'pointerup',
        'pointercancel',
      ])
      removed.mock.calls.forEach(([, listener], position) => {
        expect(listener).toBe(added.mock.calls[position]?.[1])
      })
      expect(drawingState(harness)).toEqual({
        drawing: 'false',
        pressed: ['false', 'false'],
        hint: HINT_IDLE,
      })
      fire(harness, harness.frame, 'pointermove', {
        clientX: 100,
        clientY: 200,
      })
      expect(harness.update).toHaveBeenCalledTimes(1)
    },
  )

  it('stops drawing when Escape cancels draw mode during the gesture', () => {
    const harness = bind()
    startDrawing(harness, 0, 57, 74)
    fire(harness, harness.fixture.document, 'keydown', { key: 'Escape' })
    expect(harness.frame.dataset['drawing']).toBe('false')
    fire(harness, harness.frame, 'pointermove', { clientX: 165, clientY: 330 })
    expect(harness.update).not.toHaveBeenCalled()
  })

  it('does not start a gesture while draw mode is off', () => {
    const harness = bind()
    const capture = vi.spyOn(harness.frame, 'setPointerCapture')
    const down = fire(harness, harness.frame, 'pointerdown', {
      button: 0,
      clientX: 57,
      clientY: 74,
    })
    fire(harness, harness.frame, 'pointermove', { clientX: 165, clientY: 330 })
    expect(down.defaultPrevented).toBe(false)
    expect(capture).not.toHaveBeenCalled()
    expect(harness.remember).not.toHaveBeenCalled()
    expect(harness.update).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'there is no composition',
      prepare: (harness: Harness) => {
        harness.state.composition = null
      },
      button: 0,
    },
    {
      name: 'there is no video metadata',
      prepare: (harness: Harness) => {
        harness.state.metadata = null
      },
      button: 0,
    },
    {
      name: 'editing is not possible',
      prepare: (harness: Harness) => {
        harness.state.canEdit = false
      },
      button: 0,
    },
    {
      name: 'the primary button is not used',
      prepare: () => undefined,
      button: 2,
    },
  ])('does not start a gesture when $name', ({ prepare, button }) => {
    const harness = bind()
    harness.draw[0].click()
    prepare(harness)
    const capture = vi.spyOn(harness.frame, 'setPointerCapture')
    const down = fire(harness, harness.frame, 'pointerdown', {
      button,
      clientX: 57,
      clientY: 74,
    })
    fire(harness, harness.frame, 'pointermove', { clientX: 165, clientY: 330 })
    expect(down.defaultPrevented).toBe(false)
    expect(capture).not.toHaveBeenCalled()
    expect(harness.remember).not.toHaveBeenCalled()
    expect(harness.update).not.toHaveBeenCalled()
  })

  it('crops the region whose draw button was pressed even after the selection moves', () => {
    const harness = bind()
    startDrawing(harness, 1, 57, 74)
    harness.state.selected = 0
    fire(harness, harness.frame, 'pointermove', { clientX: 165, clientY: 330 })
    expect(harness.update).toHaveBeenCalledExactlyOnceWith(
      cropUpdate(1, { x: 108, y: 128, width: 432, height: 512 }),
    )
  })
})

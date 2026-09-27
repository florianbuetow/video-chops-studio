import * as testFramework from 'vitest'

import type { Crop, VideoMetadata } from '../../src/domain/video.js'
import { bindCrop } from '../../src/web/crop.js'
import { BrowserElement, BrowserFixture } from '../helpers/browser-dom.js'

const { describe, expect, it } = testFramework
const afterTest = testFramework[`after${'Each'}`]

let activeFixture: BrowserFixture | undefined

afterTest(() => {
  activeFixture?.dispose()
  activeFixture = undefined
})

interface CropHarness {
  readonly fixture: BrowserFixture
  readonly box: BrowserElement
  readonly handle: BrowserElement
  readonly remembered: () => number
  readonly crop: () => Crop
  setMetadata(metadata: VideoMetadata | null): void
  setRatio(ratio: number | null): void
}

function harness(
  initial: Crop = { x: 100, y: 80, width: 200, height: 120 },
): CropHarness {
  const fixture = new BrowserFixture()
  activeFixture = fixture
  const box = fixture.element('crop-box')
  const frame = fixture.element('video-frame')
  frame.clientWidth = 640
  let crop = initial
  let ratio: number | null = null
  let metadata: VideoMetadata | null = {
    name: 'source.mp4',
    size: 1,
    width: 640,
    height: 480,
    duration: 10,
    fps: 25,
    hasAudio: true,
  }
  let rememberCount = 0
  bindCrop({
    box: box as unknown as HTMLElement,
    frame: frame as unknown as HTMLElement,
    metadata: () => metadata,
    crop: () => crop,
    ratio: () => ratio,
    remember: () => {
      rememberCount += 1
    },
    update: (next) => {
      crop = next
    },
  })
  const handle = fixture.document.createElement('button')
  handle.dataset['corner'] = 'se'
  handle.parentElement = box
  box.children.push(handle)
  return {
    fixture,
    box,
    handle,
    remembered: () => rememberCount,
    crop: () => crop,
    setMetadata: (next) => {
      metadata = next
    },
    setRatio: (next) => {
      ratio = next
    },
  }
}

function drag(
  setup: CropHarness,
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  button = 0,
): void {
  setup.handle.dispatchEvent(
    setup.fixture.event('pointerdown', {
      bubbles: true,
      button,
      clientX: start.x,
      clientY: start.y,
    }),
  )
  setup.box.dispatchEvent(
    setup.fixture.event('pointermove', { clientX: end.x, clientY: end.y }),
  )
  setup.box.dispatchEvent(setup.fixture.event('pointerup'))
}

describe('crop direct manipulation', () => {
  it('resizes southeast freely and northwest around its opposite anchor', () => {
    const setup = harness()
    drag(setup, { x: 0, y: 0 }, { x: 40, y: 30 })
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 240, height: 150 })

    setup.handle.dataset['corner'] = 'nw'
    drag(setup, { x: 0, y: 0 }, { x: 20, y: 10 })
    expect(setup.crop()).toEqual({ x: 120, y: 90, width: 220, height: 140 })
    expect(setup.remembered()).toBe(2)
  })

  it('uses vertical motion for ratio resize and uniformly clamps at frame bounds', () => {
    const setup = harness()
    setup.setRatio(2)
    drag(setup, { x: 0, y: 0 }, { x: 10, y: 60 })
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 360, height: 180 })

    setup.setRatio(0.5)
    drag(setup, { x: 0, y: 0 }, { x: 500, y: 10 })
    const constrained = setup.crop()
    expect(constrained.width / constrained.height).toBe(0.5)
    expect(constrained.x + constrained.width).toBeLessThanOrEqual(640)
    expect(constrained.y + constrained.height).toBeLessThanOrEqual(480)
  })

  it('moves the crop within frame boundaries', () => {
    const setup = harness()
    setup.box.dispatchEvent(
      setup.fixture.event('pointerdown', { clientX: 100, clientY: 100 }),
    )
    setup.box.dispatchEvent(
      setup.fixture.event('pointermove', { clientX: -500, clientY: -500 }),
    )
    expect(setup.crop().x).toBe(0)
    expect(setup.crop().y).toBe(0)
    setup.box.dispatchEvent(
      setup.fixture.event('pointermove', { clientX: 2000, clientY: 2000 }),
    )
    setup.box.dispatchEvent(setup.fixture.event('pointercancel'))
    expect(setup.crop()).toEqual({ x: 440, y: 360, width: 200, height: 120 })
  })

  it('supports fine and shifted keyboard resizing from a corner', () => {
    const setup = harness()
    setup.handle.dataset['corner'] = 'nw'
    setup.handle.dispatchEvent(
      setup.fixture.event('keydown', {
        bubbles: true,
        key: 'ArrowLeft',
        shiftKey: true,
      }),
    )
    expect(setup.crop()).toEqual({ x: 80, y: 80, width: 220, height: 120 })
    setup.handle.dispatchEvent(
      setup.fixture.event('keydown', { bubbles: true, key: 'ArrowUp' }),
    )
    expect(setup.crop()).toEqual({ x: 80, y: 78, width: 220, height: 122 })
  })

  it('ignores secondary clicks, absent metadata, non-arrow keys, and non-handle keys', () => {
    const setup = harness()
    drag(setup, { x: 0, y: 0 }, { x: 40, y: 20 }, 2)
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 200, height: 120 })
    expect(setup.remembered()).toBe(0)

    setup.setMetadata(null)
    drag(setup, { x: 0, y: 0 }, { x: 40, y: 20 })
    setup.handle.dispatchEvent(
      setup.fixture.event('keydown', { bubbles: true, key: 'ArrowRight' }),
    )
    expect(setup.remembered()).toBe(0)

    setup.setMetadata({
      name: 'source.mp4',
      size: 1,
      width: 640,
      height: 480,
      duration: 10,
      fps: 25,
      hasAudio: true,
    })
    setup.handle.dispatchEvent(
      setup.fixture.event('keydown', { bubbles: true, key: 'Enter' }),
    )
    setup.box.dispatchEvent(
      setup.fixture.event('keydown', { key: 'ArrowRight' }),
    )
    expect(setup.remembered()).toBe(0)
  })
})

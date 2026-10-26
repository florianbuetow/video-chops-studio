import * as testFramework from 'vitest'

import type { Crop, VideoMetadata } from '../../src/domain/video.js'
import { bindCrop } from '../../src/web/crop.js'
import {
  BrowserElement,
  BrowserEvent,
  BrowserFixture,
} from '../helpers/browser-dom.js'

const { describe, expect, it, vi } = testFramework
const afterTest = testFramework[`after${'Each'}`]

let activeFixture: BrowserFixture | undefined

afterTest(() => {
  activeFixture?.dispose()
  activeFixture = undefined
})

const sourceMetadata: VideoMetadata = {
  name: 'source.mp4',
  size: 1,
  width: 640,
  height: 480,
  duration: 10,
  fps: 25,
  hasAudio: true,
}

interface CropHarness {
  readonly fixture: BrowserFixture
  readonly box: BrowserElement
  readonly handle: BrowserElement
  readonly remembered: () => number
  readonly crop: () => Crop
  setMetadata(metadata: VideoMetadata | null): void
  setRatio(ratio: number | null): void
}

function harness(frameWidth = 640): CropHarness {
  const fixture = new BrowserFixture()
  activeFixture = fixture
  const box = fixture.element('crop-box')
  const frame = fixture.element('video-frame')
  frame.clientWidth = frameWidth
  let crop: Crop = { x: 100, y: 80, width: 200, height: 120 }
  let ratio: number | null = null
  let metadata: VideoMetadata | null = sourceMetadata
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

function press(
  setup: CropHarness,
  target: BrowserElement,
  options: ConstructorParameters<typeof BrowserEvent>[1],
): BrowserEvent {
  const event = setup.fixture.event('keydown', { bubbles: true, ...options })
  target.dispatchEvent(event)
  return event
}

function dragHandle(
  setup: CropHarness,
  corner: string,
  end: { readonly x: number; readonly y: number },
): void {
  setup.handle.dataset['corner'] = corner
  setup.handle.dispatchEvent(
    setup.fixture.event('pointerdown', {
      bubbles: true,
      clientX: 0,
      clientY: 0,
    }),
  )
  setup.box.dispatchEvent(
    setup.fixture.event('pointermove', { clientX: end.x, clientY: end.y }),
  )
  setup.box.dispatchEvent(setup.fixture.event('pointerup'))
}

describe('crop drag scaling', () => {
  it('converts pointer distance to source pixels when the frame is shown at half size', () => {
    const setup = harness(320)
    setup.box.dispatchEvent(
      setup.fixture.event('pointerdown', { clientX: 100, clientY: 100 }),
    )
    setup.box.dispatchEvent(
      setup.fixture.event('pointermove', { clientX: 125, clientY: 90 }),
    )
    expect(setup.crop()).toEqual({ x: 150, y: 60, width: 200, height: 120 })
  })

  it('scales corner resizes by the same source-to-screen factor', () => {
    const setup = harness(320)
    dragHandle(setup, 'se', { x: 20, y: 10 })
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 240, height: 140 })
  })

  it('scales down for a frame shown larger than the source', () => {
    const setup = harness(1280)
    dragHandle(setup, 'se', { x: 40, y: 20 })
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 220, height: 130 })
  })
})

describe('crop free resizing bounds', () => {
  it('stops a south-east drag at the right and bottom frame edges', () => {
    const setup = harness()
    dragHandle(setup, 'se', { x: 1000, y: 1000 })
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 540, height: 400 })
  })

  it('stops a north-west drag at the left and top frame edges', () => {
    const setup = harness()
    dragHandle(setup, 'nw', { x: -1000, y: -1000 })
    expect(setup.crop()).toEqual({ x: 0, y: 0, width: 300, height: 200 })
  })

  it('collapses to the two pixel minimum around the opposite corner', () => {
    const setup = harness()
    dragHandle(setup, 'se', { x: -1000, y: -1000 })
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 2, height: 2 })
    const second = harness()
    dragHandle(second, 'nw', { x: 1000, y: 1000 })
    expect(second.crop()).toEqual({ x: 298, y: 198, width: 2, height: 2 })
  })

  it('resizes from north-east and south-west around the matching anchors', () => {
    const northEast = harness()
    dragHandle(northEast, 'ne', { x: 30, y: -20 })
    expect(northEast.crop()).toEqual({ x: 100, y: 60, width: 230, height: 140 })
    const southWest = harness()
    dragHandle(southWest, 'sw', { x: -30, y: 20 })
    expect(southWest.crop()).toEqual({ x: 70, y: 80, width: 230, height: 140 })
  })
})

describe('crop aspect-locked resizing', () => {
  it('follows the vertical delta on an exact tie', () => {
    const setup = harness()
    setup.setRatio(2)
    dragHandle(setup, 'se', { x: 40, y: 40 })
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 320, height: 160 })
  })

  it('follows the horizontal delta when it strictly dominates', () => {
    const setup = harness()
    setup.setRatio(2)
    dragHandle(setup, 'se', { x: 40, y: 39 })
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 240, height: 120 })
  })

  it('shrinks both sides uniformly when the width would leave the frame', () => {
    const setup = harness()
    setup.setRatio(2)
    dragHandle(setup, 'se', { x: 0, y: 300 })
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 540, height: 270 })
  })

  it('shrinks both sides uniformly when the height would leave the frame', () => {
    const setup = harness()
    setup.setRatio(0.5)
    dragHandle(setup, 'se', { x: 900, y: 0 })
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 200, height: 400 })
  })
})

describe('crop pointer capture and cleanup', () => {
  it('prevents the default action and captures the pointer on a primary press', () => {
    const setup = harness()
    const capture = vi.spyOn(setup.box, 'setPointerCapture')
    const down = setup.fixture.event('pointerdown', {
      bubbles: true,
      pointerId: 7,
      clientX: 5,
      clientY: 5,
    })
    setup.handle.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith(7)
  })

  it('leaves secondary presses and presses without metadata untouched', () => {
    const setup = harness()
    const capture = vi.spyOn(setup.box, 'setPointerCapture')
    const secondary = setup.fixture.event('pointerdown', {
      bubbles: true,
      button: 2,
    })
    setup.handle.dispatchEvent(secondary)
    setup.setMetadata(null)
    const detached = setup.fixture.event('pointerdown', { bubbles: true })
    setup.handle.dispatchEvent(detached)
    expect(secondary.defaultPrevented).toBe(false)
    expect(detached.defaultPrevented).toBe(false)
    expect(capture).not.toHaveBeenCalled()
  })

  it.each(['pointerup', 'pointercancel'] as const)(
    'stops following the pointer after %s',
    (ending) => {
      const setup = harness()
      setup.box.dispatchEvent(
        setup.fixture.event('pointerdown', { clientX: 0, clientY: 0 }),
      )
      setup.box.dispatchEvent(
        setup.fixture.event('pointermove', { clientX: 10, clientY: 10 }),
      )
      expect(setup.crop()).toEqual({ x: 110, y: 90, width: 200, height: 120 })
      setup.box.dispatchEvent(setup.fixture.event(ending))
      setup.box.dispatchEvent(
        setup.fixture.event('pointermove', { clientX: 50, clientY: 50 }),
      )
      expect(setup.crop()).toEqual({ x: 110, y: 90, width: 200, height: 120 })
    },
  )

  it.each(['pointerup', 'pointercancel'] as const)(
    'removes exactly the listeners it added when the drag ends with %s',
    (ending) => {
      const setup = harness()
      const added = vi.spyOn(setup.box, 'addEventListener')
      const removed = vi.spyOn(setup.box, 'removeEventListener')
      setup.box.dispatchEvent(setup.fixture.event('pointerdown'))
      expect(added.mock.calls.map(([type]) => type)).toEqual([
        'pointermove',
        'pointerup',
        'pointercancel',
      ])
      expect(removed).not.toHaveBeenCalled()
      setup.box.dispatchEvent(setup.fixture.event(ending))
      expect(
        removed.mock.calls.map(([type, listener]) => [type, listener]),
      ).toEqual(added.mock.calls.map(([type, listener]) => [type, listener]))
    },
  )

  it('starts a fresh independent drag after the previous one ended', () => {
    const setup = harness()
    dragHandle(setup, 'se', { x: 10, y: 10 })
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 210, height: 130 })
    dragHandle(setup, 'se', { x: 20, y: 0 })
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 230, height: 130 })
    expect(setup.remembered()).toBe(2)
  })
})

describe('crop keyboard resizing', () => {
  it.each([
    ['ArrowRight', false, { x: 100, y: 80, width: 202, height: 120 }],
    ['ArrowLeft', false, { x: 100, y: 80, width: 198, height: 120 }],
    ['ArrowDown', false, { x: 100, y: 80, width: 200, height: 122 }],
    ['ArrowUp', false, { x: 100, y: 80, width: 200, height: 118 }],
    ['ArrowRight', true, { x: 100, y: 80, width: 220, height: 120 }],
    ['ArrowLeft', true, { x: 100, y: 80, width: 180, height: 120 }],
    ['ArrowDown', true, { x: 100, y: 80, width: 200, height: 140 }],
    ['ArrowUp', true, { x: 100, y: 80, width: 200, height: 100 }],
  ])(
    'moves the south-east corner with %s (shift %s)',
    (key, shiftKey, expected) => {
      const setup = harness()
      const event = press(setup, setup.handle, { key, shiftKey })
      expect(event.defaultPrevented).toBe(true)
      expect(setup.crop()).toEqual(expected)
      expect(setup.remembered()).toBe(1)
    },
  )

  it('remembers the crop once per accepted key press', () => {
    const setup = harness()
    press(setup, setup.handle, { key: 'ArrowRight' })
    press(setup, setup.handle, { key: 'ArrowDown' })
    press(setup, setup.handle, { key: 'ArrowRight' })
    expect(setup.remembered()).toBe(3)
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 204, height: 122 })
  })

  it('swallows arrows on the box itself without changing the crop', () => {
    const setup = harness()
    const event = press(setup, setup.box, { key: 'ArrowLeft' })
    expect(event.defaultPrevented).toBe(true)
    expect(setup.crop()).toEqual({ x: 100, y: 80, width: 200, height: 120 })
    expect(setup.remembered()).toBe(0)
  })

  it('does not swallow other keys or arrows without metadata', () => {
    const setup = harness()
    expect(press(setup, setup.handle, { key: 'Enter' }).defaultPrevented).toBe(
      false,
    )
    expect(press(setup, setup.box, { key: 'a' }).defaultPrevented).toBe(false)
    setup.setMetadata(null)
    expect(
      press(setup, setup.handle, { key: 'ArrowRight' }).defaultPrevented,
    ).toBe(false)
    expect(setup.remembered()).toBe(0)
  })
})

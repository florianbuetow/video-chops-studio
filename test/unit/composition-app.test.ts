import { afterEach, describe, expect, it } from 'vitest'

import {
  regionSize,
  type Composition,
  type EditRequest,
} from '../../src/domain/video.js'
import {
  BrowserElement,
  BrowserFixture,
  BrowserVideo,
  loadBrowserApp,
} from '../helpers/browser-dom.js'

let activeFixture: BrowserFixture | undefined

afterEach(() => {
  activeFixture?.dispose()
  activeFixture = undefined
})

async function app(): Promise<BrowserFixture> {
  activeFixture = await loadBrowserApp((fixture) => {
    fixture.addVideo('portrait.mp4', {
      width: 1080,
      height: 1920,
      duration: 20,
    })
  })
  activeFixture.find('file-button')[0]?.click()
  await activeFixture.settle(50)
  return activeFixture
}

function change(fixture: BrowserFixture, id: string, value: string): void {
  const input = fixture.element(id)
  input.value = value
  input.dispatchEvent(fixture.event('change'))
}

function enter(fixture: BrowserFixture, id: string, value: string): void {
  const control = fixture.element(id)
  control.value = value
  control.dispatchEvent(fixture.event('input'))
}

function exportedEdit(fixture: BrowserFixture): EditRequest {
  const request = fixture.requests.findLast(
    ({ path, method }) => path === '/api/exports' && method === 'POST',
  )
  if (request === undefined) throw new Error('Export request was not recorded')
  return request.body as EditRequest
}

function composition(edit: EditRequest): Composition {
  if (edit.composition === undefined)
    throw new Error('Export did not include a composition')
  return edit.composition
}

function appendResizeHandle(
  fixture: BrowserFixture,
  destination: BrowserElement,
): BrowserElement {
  const handle = fixture.document.createElement('button')
  handle.dataset['corner'] = 'se'
  handle.parentElement = destination
  destination.children.push(handle)
  return handle
}

describe('browser composition editor', () => {
  it('plays and pauses the output with retained cuts, shared audio, and an edited timecode', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()
    change(fixture, 'clip-in', '2')
    change(fixture, 'clip-out', '4')
    fixture.element('preview-cuts').checked = false
    const video = fixture.element('video') as BrowserVideo
    video.currentTime = 0
    expect(fixture.element('output-play').disabled).toBe(false)
    expect(fixture.element('output-preview-duration').textContent).toBe(
      '00:02.00',
    )
    fixture.element('output-play').click()
    await fixture.settle()
    expect(video.paused).toBe(false)
    expect(video.muted).toBe(false)
    expect(video.currentTime).toBe(2)
    expect(fixture.element('preview-cuts').checked).toBe(true)
    expect(fixture.element('output-play-label').textContent).toBe(
      'Pause output',
    )
    video.currentTime = 3
    video.dispatchEvent(fixture.event('timeupdate'))
    expect(fixture.element('output-current-time').textContent).toBe('00:01.00')
    fixture.element('output-play').click()
    await fixture.settle()
    expect(video.paused).toBe(true)
    expect(fixture.element('output-play-label').textContent).toBe('Play output')
    fixture.element('remove').click()
    expect(fixture.element('output-play').disabled).toBe(true)
  })
  it('switches between single and two-region layouts without losing the single crop', async () => {
    const fixture = await app()
    change(fixture, 'crop-width', '600')
    change(fixture, 'crop-height', '800')
    change(fixture, 'crop-x', '100')
    change(fixture, 'crop-y', '200')

    fixture.element('layout-two-regions').click()
    expect(
      fixture.element('layout-two-regions').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      fixture.element('layout-one-region').getAttribute('aria-pressed'),
    ).toBe('false')
    expect(fixture.element('composition-settings').hidden).toBe(false)
    expect(fixture.element('output-panel').hidden).toBe(false)
    expect(fixture.element('source-region-1').hidden).toBe(false)
    expect(fixture.element('source-region-2').hidden).toBe(false)

    fixture.element('layout-one-region').click()
    expect(
      fixture.element('layout-one-region').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      fixture.element('layout-two-regions').getAttribute('aria-pressed'),
    ).toBe('false')
    expect(fixture.element('output-panel').hidden).toBe(true)
    expect(fixture.element('crop-width').value).toBe('600')
    expect(fixture.element('crop-height').value).toBe('800')
    expect(fixture.element('crop-x').value).toBe('100')
    expect(fixture.element('crop-y').value).toBe('200')
  })

  it('draws two independent source rectangles and maps output edits into the export', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()
    const sourceFrame = fixture.element('video-frame')
    const bounds = sourceFrame.getBoundingClientRect()

    fixture.element('draw-region-1').click()
    sourceFrame.dispatchEvent(
      fixture.event('pointerdown', { button: 0, clientX: 0, clientY: 0 }),
    )
    sourceFrame.dispatchEvent(
      fixture.event('pointermove', {
        clientX: bounds.width / 2,
        clientY: bounds.height / 2,
      }),
    )
    sourceFrame.dispatchEvent(fixture.event('pointerup'))

    fixture.element('draw-region-2').click()
    sourceFrame.dispatchEvent(
      fixture.event('pointerdown', {
        button: 0,
        clientX: bounds.width / 2,
        clientY: bounds.height / 2,
      }),
    )
    sourceFrame.dispatchEvent(
      fixture.event('pointermove', {
        clientX: bounds.width,
        clientY: bounds.height,
      }),
    )
    sourceFrame.dispatchEvent(fixture.event('pointerup'))

    expect(fixture.element('source-region-1').style['left']).toBe('0px')
    expect(fixture.element('source-region-1').style['top']).toBe('0px')
    expect(fixture.element('source-region-2').style['left']).toBe(
      `${bounds.width / 2}px`,
    )
    expect(fixture.element('source-region-2').style['top']).toBe(
      `${bounds.height / 2}px`,
    )

    fixture.element('select-region-1').click()
    enter(fixture, 'region-scale-slider', '40')
    change(fixture, 'region-output-x', '120')
    change(fixture, 'region-output-y', '180')
    expect(Number(fixture.element('region-scale').value)).toBeLessThanOrEqual(
      100,
    )

    const destination = fixture.element('output-region-1')
    const handle = appendResizeHandle(fixture, destination)
    handle.dispatchEvent(
      fixture.event('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 200,
        clientY: 200,
      }),
    )
    destination.dispatchEvent(
      fixture.event('pointermove', { clientX: 2000, clientY: 2000 }),
    )
    destination.dispatchEvent(fixture.event('pointerup'))
    expect(Number(fixture.element('region-scale').value)).toBeLessThanOrEqual(
      100,
    )

    const video = fixture.element('video') as BrowserVideo
    video.currentTime = 5
    fixture.element('split').click()
    fixture.element('export-button').click()
    await fixture.settle(50)

    const edit = exportedEdit(fixture)
    const output = composition(edit)
    expect(edit.segments).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 20 },
    ])
    expect(edit.muted).toBe(false)
    expect(output.regions[0].crop).not.toEqual(output.regions[1].crop)
    expect(output.regions[0].x).toBe(
      Number(fixture.element('region-output-x').value),
    )
    expect(output.regions[0].y).toBe(
      Number(fixture.element('region-output-y').value),
    )
    expect(output.regions[0].scale).toBeLessThanOrEqual(1)

    const outputDraw = fixture.canvasDraw.mock.calls.findLast(
      (call) =>
        call.length === 9 &&
        call[0] === video &&
        call[5] === output.regions[0].x,
    )
    expect(outputDraw?.slice(1, 5)).toEqual([
      output.regions[0].crop.x * (video.videoWidth / 1080),
      output.regions[0].crop.y * (video.videoHeight / 1920),
      output.regions[0].crop.width * (video.videoWidth / 1080),
      output.regions[0].crop.height * (video.videoHeight / 1920),
    ])
  })

  it('changes common output presets by restacking and restores the prior layout with undo', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()
    change(fixture, 'region-scale', '40')
    change(fixture, 'region-output-x', '200')
    change(fixture, 'region-output-y', '300')
    const customLeft = fixture.element('output-region-1').style['left']

    change(fixture, 'output-aspect', '16:9')
    expect(fixture.element('output-resolution').textContent).toBe('1920 × 1080')
    expect(fixture.element('output-aspect-label').textContent).toBe('16:9')
    expect(fixture.element('output-region-1').style['left']).not.toBe(
      customLeft,
    )

    fixture.element('undo').click()
    expect(fixture.element('output-aspect').value).toBe('9:16')
    expect(fixture.element('region-output-x').value).toBe('200')
    expect(fixture.element('region-output-y').value).toBe('300')

    fixture.element('stack-regions').click()
    expect(Number(fixture.element('region-output-y').value)).toBeLessThan(960)
  })

  it('shows the aspect ratio of the visible source and output frames', async () => {
    const fixture = await app()
    expect(fixture.element('source-aspect-label').textContent).toBe('9:16')
    change(fixture, 'aspect', '1')
    fixture.element('view-result').click()
    expect(fixture.element('source-aspect-label').textContent).toBe('1:1')
    fixture.element('layout-two-regions').click()
    expect(fixture.element('source-aspect-label').textContent).toBe('9:16')
    change(fixture, 'output-aspect', '3:2')
    expect(fixture.element('output-aspect-label').textContent).toBe('3:2')
    expect(fixture.element('source-aspect-label').textContent).toBe('9:16')
  })

  it('exports horizontal and vertical gaps, remembers each direction, and undoes a reset', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()
    change(fixture, 'stack-gap', '32')
    fixture.element('stack-horizontal').click()
    expect(fixture.element('stack-gap').value).toBe('0')
    expect(fixture.element('stack-gap-label').textContent).toBe(
      'Horizontal gap',
    )
    change(fixture, 'stack-gap', '80')
    change(fixture, 'output-aspect', '16:9')
    expect(
      fixture.element('stack-horizontal').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(fixture.element('stack-gap').value).toBe('80')
    fixture.element('export-button').click()
    await fixture.settle(50)
    const horizontal = composition(exportedEdit(fixture))
    const [left, right] = horizontal.regions
    expect(right.x - left.x - regionSize(left).width).toBe(80)
    expect(left.y).toBe(right.y)

    fixture.element('stack-vertical').click()
    expect(fixture.element('stack-gap').value).toBe('32')
    expect(fixture.element('stack-gap-label').textContent).toBe('Vertical gap')
    fixture.element('export-button').click()
    await fixture.settle(50)
    const [top, bottom] = composition(exportedEdit(fixture)).regions
    expect(bottom.y - top.y - regionSize(top).height).toBe(32)
    expect(top.x).toBe(bottom.x)

    fixture.element('stack-horizontal').click()
    expect(fixture.element('stack-gap').value).toBe('80')
    fixture.element('reset').click()
    expect(fixture.element('stack-vertical').getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(fixture.element('stack-gap').value).toBe('0')
    fixture.element('undo').click()
    expect(
      fixture.element('stack-horizontal').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(fixture.element('stack-gap').value).toBe('80')
  })

  it('clamps oversized gaps and restores one slider gesture with a single undo', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()
    change(fixture, 'stack-gap', '32')
    const slider = fixture.element('stack-gap-slider')
    slider.dispatchEvent(fixture.event('pointerdown'))
    enter(fixture, 'stack-gap-slider', '40')
    enter(fixture, 'stack-gap-slider', '100')
    slider.dispatchEvent(fixture.event('pointerup'))
    expect(fixture.element('stack-gap').value).toBe('100')
    fixture.element('undo').click()
    expect(fixture.element('stack-gap').value).toBe('32')
    expect(slider.value).toBe('32')
    change(fixture, 'stack-gap', '99999')
    expect(fixture.element('stack-gap').value).toBe(slider.max)
    expect(slider.value).toBe(slider.max)
    change(fixture, 'stack-gap', '')
    expect(fixture.element('stack-gap').value).toBe(slider.max)
    fixture.element('export-button').click()
    await fixture.settle(50)
    const [first, second] = composition(exportedEdit(fixture)).regions
    expect(second.y - first.y - regionSize(first).height).toBe(
      Number(slider.max),
    )
    expect(second.y + regionSize(second).height).toBeLessThanOrEqual(1920)
  })

  it('exports background color and frame choices and previews their canvas paint', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()
    change(fixture, 'background-color', '#123456')
    change(fixture, 'frame-target', 'regions')
    change(fixture, 'frame-color', '#fedcba')
    change(fixture, 'frame-width', '12')

    fixture.element('export-button').click()
    await fixture.settle(50)
    const output = composition(exportedEdit(fixture))
    expect(output.background).toBe('#123456')
    expect(output.frame).toEqual({
      target: 'regions',
      color: '#fedcba',
      width: 12,
    })
    expect(fixture.canvasFillStyles).toContain('#123456')
    expect(fixture.canvasFillStyles).toContain('#fedcba')
    expect(fixture.canvasFill).toHaveBeenCalledWith(
      output.regions[0].x,
      output.regions[0].y,
      expect.any(Number),
      12,
    )
  })

  it('uploads, previews, removes, and excludes a background image', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()
    const file = new File(['image'], 'my backdrop.png', { type: 'image/png' })
    fixture.setFiles('background-image', [file])
    fixture.element('background-image').dispatchEvent(fixture.event('change'))
    await fixture.settle(50)

    const upload = fixture.requests.find(({ path }) =>
      path.startsWith('/api/backgrounds?name='),
    )
    expect(upload?.method).toBe('POST')
    expect(upload?.body).toBe(file)
    expect(fixture.element('background-name').textContent).toContain(
      'my backdrop.png',
    )
    expect(
      fixture.canvasDraw.mock.calls.some(
        (call) => call[0]?.constructor.name === 'BrowserImage',
      ),
    ).toBe(true)

    fixture.element('export-button').click()
    await fixture.settle(50)
    expect(composition(exportedEdit(fixture)).backgroundImage).toBe(
      'uploaded-background.png',
    )

    fixture.element('remove-background').click()
    fixture.element('export-button').click()
    await fixture.settle(50)
    expect(composition(exportedEdit(fixture)).backgroundImage).toBeUndefined()
  })
})

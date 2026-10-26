import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BrowserFixture,
  BrowserVideo,
  loadBrowserApp,
} from '../helpers/browser-dom.js'

let activeFixture: BrowserFixture | undefined

afterEach(() => {
  activeFixture?.dispose()
  activeFixture = undefined
})

async function app(
  configure?: (fixture: BrowserFixture) => void,
): Promise<BrowserFixture> {
  activeFixture = await loadBrowserApp((fixture) => {
    fixture.addVideo('wide.mp4', { width: 640, height: 360 })
    configure?.(fixture)
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

function pressed(fixture: BrowserFixture, id: string): string | null {
  return fixture.element(id).getAttribute('aria-pressed')
}

function detailsOpen(fixture: BrowserFixture): unknown {
  return (fixture.element('source-bounds') as unknown as { open?: boolean })
    .open
}

function values(fixture: BrowserFixture, ...ids: string[]): string[] {
  return ids.map((id) => fixture.element(id).value)
}

function uploadBackground(fixture: BrowserFixture, name: string): void {
  fixture.setFiles('background-image', [
    new File(['image'], name, { type: 'image/png' }),
  ])
  fixture.element('background-image').dispatchEvent(fixture.event('change'))
}

describe('browser composition controls', () => {
  it('switches every mode-dependent control between one region and two regions', async () => {
    const fixture = await app()
    const hiddenIds = [
      'output-panel',
      'composition-settings',
      'composition-appearance',
      'single-preview-controls',
      'single-crop-options',
      'region-draw-actions',
      'region-selector',
      'source-bounds-label',
    ]
    const hidden = (): boolean[] =>
      hiddenIds.map((id) => fixture.element(id).hidden)

    expect(hidden()).toEqual([true, true, true, false, false, true, true, true])
    expect(fixture.element('preview-pair').className).toBe('preview-pair')
    expect(fixture.element('workspace').className).toBe('workspace')
    expect(fixture.element('crop-heading').textContent).toBe('Crop')
    expect(fixture.element('preview-heading').textContent).toBe('Preview')
    expect(fixture.element('reset-crop').textContent).toBe('Reset crop')
    expect(pressed(fixture, 'layout-one-region')).toBe('true')
    expect(pressed(fixture, 'layout-two-regions')).toBe('false')
    expect(fixture.element('crop-box').hidden).toBe(false)

    fixture.element('layout-two-regions').click()
    expect(hidden()).toEqual([
      false,
      false,
      false,
      true,
      true,
      false,
      false,
      false,
    ])
    expect(fixture.element('preview-pair').className).toBe(
      'preview-pair has-composition',
    )
    expect(fixture.element('workspace').className).toBe(
      'workspace composition-mode',
    )
    expect(fixture.element('crop-heading').textContent).toBe('Source regions')
    expect(fixture.element('preview-heading').textContent).toBe('Source')
    expect(fixture.element('reset-crop').textContent).toBe('Reset region')
    expect(pressed(fixture, 'layout-one-region')).toBe('false')
    expect(pressed(fixture, 'layout-two-regions')).toBe('true')
    expect(fixture.element('crop-box').hidden).toBe(true)

    fixture.element('layout-one-region').click()
    expect(hidden()).toEqual([true, true, true, false, false, true, true, true])
    expect(fixture.element('preview-pair').className).toBe('preview-pair')
    expect(fixture.element('workspace').className).toBe('workspace')
    expect(fixture.element('crop-heading').textContent).toBe('Crop')
    expect(fixture.element('preview-heading').textContent).toBe('Preview')
    expect(fixture.element('reset-crop').textContent).toBe('Reset crop')
    expect(pressed(fixture, 'layout-one-region')).toBe('true')
    expect(pressed(fixture, 'layout-two-regions')).toBe('false')
    expect(fixture.element('crop-box').hidden).toBe(false)
  })

  it('collapses the source bounds only when the layout changes', async () => {
    const fixture = await app()
    expect(detailsOpen(fixture)).toBeUndefined()

    fixture.element('layout-two-regions').click()
    expect(detailsOpen(fixture)).toBe(false)
    const details = fixture.element('source-bounds') as unknown as {
      open: boolean
    }
    details.open = true
    change(fixture, 'crop-width', '400')
    expect(detailsOpen(fixture)).toBe(true)

    fixture.element('layout-one-region').click()
    expect(detailsOpen(fixture)).toBe(true)
    details.open = false
    change(fixture, 'crop-width', '400')
    expect(detailsOpen(fixture)).toBe(false)

    fixture.element('layout-two-regions').click()
    expect(detailsOpen(fixture)).toBe(false)
    fixture.element('layout-one-region').click()
    expect(detailsOpen(fixture)).toBe(true)
  })

  it('shows the initial region geometry and appearance defaults', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()

    const label = fixture.element('output-aspect-label')
    expect(fixture.element('output-aspect').value).toBe('9:16')
    expect(label.textContent).toBe('9:16')
    expect(label.title).toBe('1080 × 1920')
    expect(fixture.element('output-resolution').textContent).toBe('1080 × 1920')
    expect(pressed(fixture, 'stack-vertical')).toBe('true')
    expect(pressed(fixture, 'stack-horizontal')).toBe('false')
    expect(fixture.element('stack-gap-label').textContent).toBe('Vertical gap')
    expect(values(fixture, 'stack-gap', 'stack-gap-slider')).toEqual(['0', '0'])
    expect(fixture.element('stack-gap').max).toBe('1916')
    expect(fixture.element('stack-gap-slider').max).toBe('1916')
    expect(values(fixture, 'region-scale', 'region-scale-slider')).toEqual([
      '100',
      '100',
    ])
    expect(values(fixture, 'region-output-x', 'region-output-y')).toEqual([
      '220',
      '780',
    ])
    expect(
      values(fixture, 'crop-x', 'crop-y', 'crop-width', 'crop-height'),
    ).toEqual(['0', '0', '640', '180'])
    expect(fixture.element('background-color').value).toBe('#000000')
    expect(fixture.element('background-color-label').textContent).toBe(
      '#000000',
    )
    expect(fixture.element('remove-background').hidden).toBe(true)
    expect(fixture.element('background-name').textContent).toBe(
      'PNG, JPG or WebP. The image fills the canvas.',
    )
    expect(fixture.element('frame-target').value).toBe('none')
    expect(fixture.element('frame-color').value).toBe('#ffffff')
    expect(fixture.element('frame-width').value).toBe('8')
    expect(fixture.element('frame-options').hidden).toBe(true)
    expect(pressed(fixture, 'select-region-1')).toBe('true')
    expect(pressed(fixture, 'select-region-2')).toBe('false')

    fixture.element('stack-horizontal').click()
    expect(pressed(fixture, 'stack-vertical')).toBe('false')
    expect(pressed(fixture, 'stack-horizontal')).toBe('true')
    expect(fixture.element('stack-gap-label').textContent).toBe(
      'Horizontal gap',
    )
    expect(fixture.element('stack-gap').max).toBe('1068')
    expect(fixture.element('stack-gap-slider').max).toBe('1068')

    fixture.element('stack-vertical').click()
    expect(pressed(fixture, 'stack-vertical')).toBe('true')
    expect(pressed(fixture, 'stack-horizontal')).toBe('false')
    expect(fixture.element('stack-gap').max).toBe('1916')
  })

  it('shows the geometry of whichever region is selected', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()

    fixture.element('select-region-2').click()
    expect(pressed(fixture, 'select-region-1')).toBe('false')
    expect(pressed(fixture, 'select-region-2')).toBe('true')
    expect(
      values(fixture, 'crop-x', 'crop-y', 'crop-width', 'crop-height'),
    ).toEqual(['0', '180', '640', '180'])
    expect(values(fixture, 'region-output-x', 'region-output-y')).toEqual([
      '220',
      '960',
    ])

    fixture.element('select-region-1').click()
    expect(pressed(fixture, 'select-region-1')).toBe('true')
    expect(pressed(fixture, 'select-region-2')).toBe('false')
    expect(values(fixture, 'crop-y', 'region-output-y')).toEqual(['0', '780'])
  })

  it('rounds the displayed scale to two decimals as a percentage', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()
    enter(fixture, 'region-scale-slider', '33.333')
    expect(values(fixture, 'region-scale', 'region-scale-slider')).toEqual([
      '33.33',
      '33.33',
    ])
    change(fixture, 'region-scale', '50')
    expect(values(fixture, 'region-scale', 'region-scale-slider')).toEqual([
      '50',
      '50',
    ])
  })

  it('edits the selected region crop without touching the single-region crop or its ratio lock', async () => {
    const fixture = await app()
    change(fixture, 'aspect', '1')
    expect(
      values(fixture, 'crop-x', 'crop-y', 'crop-width', 'crop-height'),
    ).toEqual(['140', '0', '360', '360'])

    fixture.element('layout-two-regions').click()
    expect(fixture.element('aspect').value).toBe('1')
    expect(
      values(fixture, 'crop-x', 'crop-y', 'crop-width', 'crop-height'),
    ).toEqual(['0', '0', '640', '180'])

    change(fixture, 'crop-width', '400')
    expect(
      values(fixture, 'crop-x', 'crop-y', 'crop-width', 'crop-height'),
    ).toEqual(['0', '0', '400', '180'])
    fixture.element('select-region-2').click()
    expect(
      values(fixture, 'crop-x', 'crop-y', 'crop-width', 'crop-height'),
    ).toEqual(['0', '180', '640', '180'])

    fixture.element('layout-one-region').click()
    expect(
      values(fixture, 'crop-x', 'crop-y', 'crop-width', 'crop-height'),
    ).toEqual(['140', '0', '360', '360'])
  })

  it('previews frame choices and falls back to the defaults when the frame is removed', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()
    change(fixture, 'frame-target', 'regions')
    expect(fixture.element('frame-target').value).toBe('regions')
    expect(fixture.element('frame-color').value).toBe('#ffffff')
    expect(fixture.element('frame-width').value).toBe('8')
    expect(fixture.element('frame-options').hidden).toBe(false)

    change(fixture, 'frame-color', '#ff0000')
    change(fixture, 'frame-width', '12')
    expect(
      values(fixture, 'frame-target', 'frame-color', 'frame-width'),
    ).toEqual(['regions', '#ff0000', '12'])
    expect(fixture.element('frame-options').hidden).toBe(false)

    change(fixture, 'frame-target', 'none')
    expect(
      values(fixture, 'frame-target', 'frame-color', 'frame-width'),
    ).toEqual(['none', '#ffffff', '8'])
    expect(fixture.element('frame-options').hidden).toBe(true)
  })

  it('describes the background image and offers its removal only while one is set', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()
    uploadBackground(fixture, 'my backdrop.png')
    await fixture.settle(50)
    expect(fixture.element('remove-background').hidden).toBe(false)
    expect(fixture.element('background-name').textContent).toBe(
      'my backdrop.png · Fills the canvas',
    )

    fixture.element('remove-background').click()
    expect(fixture.element('remove-background').hidden).toBe(true)
    expect(fixture.element('background-name').textContent).toBe(
      'PNG, JPG or WebP. The image fills the canvas.',
    )

    uploadBackground(fixture, '')
    await fixture.settle(50)
    expect(fixture.element('remove-background').hidden).toBe(false)
    expect(fixture.element('background-name').textContent).toBe(
      'Background image · Fills the canvas',
    )
  })

  it('keeps the upload message while the composition controls re-render', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()
    uploadBackground(fixture, 'backdrop.png')
    expect(fixture.element('background-name').textContent).toBe(
      'Preparing background image…',
    )

    fixture.element('select-region-2').click()
    expect(fixture.element('background-name').textContent).toBe(
      'Preparing background image…',
    )
    expect(pressed(fixture, 'select-region-2')).toBe('true')

    await fixture.settle(50)
    expect(fixture.element('background-name').textContent).toBe(
      'backdrop.png · Fills the canvas',
    )
  })
})

describe('browser composition view wiring', () => {
  const frames = [
    'source-region-1',
    'source-region-2',
    'output-region-1',
    'output-region-2',
  ]

  it('marks the selected region in both frames and follows focus changes', async () => {
    const fixture = await app()
    fixture.element('layout-two-regions').click()
    const marks = (): Array<string | undefined>[] =>
      frames.map((id) => [
        fixture.element(id).dataset['selected'],
        fixture.element(id).style['zIndex'],
      ])

    expect(marks()).toEqual([
      ['true', '2'],
      ['false', '1'],
      ['true', '2'],
      ['false', '1'],
    ])
    fixture.element('source-region-2').dispatchEvent(fixture.event('focusin'))
    expect(pressed(fixture, 'select-region-2')).toBe('true')
    expect(fixture.element('crop-y').value).toBe('180')
    expect(marks()).toEqual([
      ['false', '1'],
      ['true', '2'],
      ['false', '1'],
      ['true', '2'],
    ])

    fixture.element('output-region-1').dispatchEvent(fixture.event('focusin'))
    expect(pressed(fixture, 'select-region-1')).toBe('true')
    expect(pressed(fixture, 'select-region-2')).toBe('false')
    expect(fixture.element('crop-y').value).toBe('0')
  })

  it('ignores region drawing and selection while one region is shown', async () => {
    const fixture = await app()
    fixture.element('draw-region-2').dispatchEvent(fixture.event('click'))
    fixture.element('source-region-2').dispatchEvent(fixture.event('focusin'))
    fixture.element('output-region-2').dispatchEvent(fixture.event('focusin'))
    fixture
      .element('source-region-2')
      .dispatchEvent(
        fixture.event('pointerdown', { button: 0, clientX: 10, clientY: 10 }),
      )
    fixture.element('source-region-2').dispatchEvent(fixture.event('pointerup'))

    fixture.element('layout-two-regions').click()
    expect(pressed(fixture, 'select-region-1')).toBe('true')
    expect(pressed(fixture, 'select-region-2')).toBe('false')
    expect(pressed(fixture, 'draw-region-2')).toBe('false')
  })

  it('only lets regions be edited when the preview is ready', async () => {
    const fixture = await app((browser) => {
      browser.autoLoadMedia = false
    })
    fixture.element('layout-two-regions').click()
    expect(pressed(fixture, 'select-region-1')).toBe('true')
    expect(fixture.element('draw-region-1').disabled).toBe(true)
    expect(fixture.element('draw-region-2').disabled).toBe(true)

    fixture.element('source-region-2').dispatchEvent(fixture.event('focusin'))
    expect(pressed(fixture, 'select-region-1')).toBe('true')

    fixture.autoLoadMedia = true
    const video = fixture.element('video') as BrowserVideo
    video.readyState = 4
    video.dispatchEvent(fixture.event('loadeddata'))
    await fixture.settle(50)
    expect(fixture.element('draw-region-1').disabled).toBe(false)
    expect(fixture.element('draw-region-2').disabled).toBe(false)
    fixture.element('source-region-2').dispatchEvent(fixture.event('focusin'))
    expect(pressed(fixture, 'select-region-2')).toBe('true')
  })

  it('does not change the selected region while an export runs', async () => {
    vi.useFakeTimers()
    const fixture = await app((browser) => {
      browser.queueExport(
        { id: '', status: 'running', progress: 0.5 },
        { id: '', status: 'complete', progress: 1 },
      )
    })
    fixture.element('layout-two-regions').click()
    fixture.element('export-button').click()
    await fixture.settle()

    fixture.element('source-region-2').dispatchEvent(fixture.event('focusin'))
    fixture.element('output-region-2').dispatchEvent(fixture.event('focusin'))
    expect(pressed(fixture, 'select-region-1')).toBe('true')
    expect(pressed(fixture, 'select-region-2')).toBe('false')

    await vi.advanceTimersByTimeAsync(400)
    await fixture.settle()
    fixture.element('source-region-2').dispatchEvent(fixture.event('focusin'))
    expect(pressed(fixture, 'select-region-2')).toBe('true')
  })

  it('locks the layout buttons while a background uploads or an export runs', async () => {
    vi.useFakeTimers()
    const fixture = await app((browser) => {
      browser.queueExport(
        { id: '', status: 'running', progress: 0.5 },
        { id: '', status: 'complete', progress: 1 },
      )
    })
    const buttons = (): boolean[] => [
      fixture.element('layout-one-region').disabled,
      fixture.element('layout-two-regions').disabled,
    ]
    fixture.element('layout-two-regions').click()
    expect(buttons()).toEqual([false, false])

    uploadBackground(fixture, 'backdrop.png')
    expect(buttons()).toEqual([true, true])
    await fixture.settle(50)
    expect(buttons()).toEqual([false, false])

    fixture.element('export-button').click()
    expect(buttons()).toEqual([true, true])
    await fixture.settle()
    await vi.advanceTimersByTimeAsync(400)
    await fixture.settle()
    expect(buttons()).toEqual([false, false])
  })
})

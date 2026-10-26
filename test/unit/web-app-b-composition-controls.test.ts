import { afterEach, describe, expect, it } from 'vitest'

import type { Composition, EditRequest } from '../../src/domain/video.js'
import { BrowserFixture, loadBrowserApp } from '../helpers/browser-dom.js'

let activeFixture: BrowserFixture | undefined

afterEach(() => {
  activeFixture?.dispose()
  activeFixture = undefined
})

async function app(
  metadata: { width: number; height: number } = { width: 1080, height: 1920 },
  selectSource = true,
): Promise<BrowserFixture> {
  activeFixture = await loadBrowserApp((fixture) => {
    fixture.addVideo('portrait.mp4', { ...metadata, duration: 20 })
  })
  if (selectSource) {
    activeFixture.find('file-button')[0]?.click()
    await activeFixture.settle(50)
  }
  return activeFixture
}

async function stackedApp(): Promise<BrowserFixture> {
  const fixture = await app()
  fixture.element('layout-two-regions').click()
  return fixture
}

function change(fixture: BrowserFixture, id: string, value: string): void {
  const input = fixture.element(id)
  input.value = value
  input.dispatchEvent(fixture.event('change'))
}

function enter(fixture: BrowserFixture, id: string, value: string): void {
  const input = fixture.element(id)
  input.value = value
  input.dispatchEvent(fixture.event('input'))
}

function press(fixture: BrowserFixture, id: string): void {
  fixture.element(id).dispatchEvent(fixture.event('click'))
}

function pressed(fixture: BrowserFixture, id: string): string | null {
  return fixture.element(id).getAttribute('aria-pressed')
}

function fieldValue(fixture: BrowserFixture, id: string): string {
  return fixture.element(id).value
}

async function exportedComposition(
  fixture: BrowserFixture,
): Promise<Composition> {
  fixture.element('export-button').click()
  await fixture.settle(50)
  const request = fixture.requests.findLast(
    ({ path, method }) => path === '/api/exports' && method === 'POST',
  )
  const composition = (request?.body as EditRequest | undefined)?.composition
  if (composition === undefined) throw new Error('No composition was exported')
  return composition
}

describe('browser layout switching', () => {
  it('records each switch once and restores the previous layout on undo', async () => {
    const fixture = await app()
    expect(fixture.element('undo').disabled).toBe(true)

    fixture.element('layout-two-regions').click()
    fixture.element('layout-two-regions').click()
    expect(pressed(fixture, 'layout-two-regions')).toBe('true')
    expect(fixture.element('output-panel').hidden).toBe(false)

    fixture.element('undo').click()
    expect(pressed(fixture, 'layout-one-region')).toBe('true')
    expect(pressed(fixture, 'layout-two-regions')).toBe('false')
    expect(fixture.element('output-panel').hidden).toBe(true)
    expect(fixture.element('undo').disabled).toBe(true)
    fixture.element('redo').click()
    expect(pressed(fixture, 'layout-two-regions')).toBe('true')
  })

  it('keeps an edited composition when switching back and forth', async () => {
    const fixture = await stackedApp()
    change(fixture, 'region-scale', '50')
    change(fixture, 'region-output-x', '200')

    fixture.element('layout-one-region').click()
    fixture.element('layout-two-regions').click()

    expect(fieldValue(fixture, 'region-scale')).toBe('50')
    expect(fieldValue(fixture, 'region-output-x')).toBe('200')
  })

  it('shows the cropped result only until the layout changes', async () => {
    const fixture = await app()
    fixture.element('view-result').click()
    expect(fixture.element('crop-box').hidden).toBe(true)
    expect(pressed(fixture, 'view-result')).toBe('true')

    fixture.element('layout-two-regions').click()
    fixture.element('layout-one-region').click()

    expect(fixture.element('crop-box').hidden).toBe(false)
    expect(pressed(fixture, 'view-source')).toBe('true')
    expect(pressed(fixture, 'view-result')).toBe('false')
  })

  it('does nothing before a source is opened', async () => {
    const fixture = await app(undefined, false)

    press(fixture, 'layout-two-regions')
    press(fixture, 'stack-vertical')
    press(fixture, 'stack-regions')
    change(fixture, 'output-aspect', '16:9')

    expect(fixture.element('notice').hidden).toBe(true)
    expect(fixture.element('undo').disabled).toBe(true)
  })
})

describe('browser single-layout guards', () => {
  const actions: ReadonlyArray<{
    readonly label: string
    readonly run: (fixture: BrowserFixture) => void
  }> = [
    {
      label: 'the vertical stack button',
      run: (f) => press(f, 'stack-vertical'),
    },
    {
      label: 'the horizontal stack button',
      run: (f) => press(f, 'stack-horizontal'),
    },
    { label: 'the restack button', run: (f) => press(f, 'stack-regions') },
    { label: 'the gap field', run: (f) => change(f, 'stack-gap', '40') },
    {
      label: 'the gap slider',
      run: (f) => {
        f.element('stack-gap-slider').dispatchEvent(f.event('pointerdown'))
        enter(f, 'stack-gap-slider', '40')
      },
    },
    {
      label: 'the scale slider',
      run: (f) => {
        f.element('region-scale-slider').dispatchEvent(f.event('pointerdown'))
        enter(f, 'region-scale-slider', '40')
      },
    },
    {
      label: 'the output preset',
      run: (f) => change(f, 'output-aspect', '16:9'),
    },
    { label: 'the scale field', run: (f) => change(f, 'region-scale', '40') },
    { label: 'the x field', run: (f) => change(f, 'region-output-x', '100') },
    { label: 'the y field', run: (f) => change(f, 'region-output-y', '100') },
    {
      label: 'the canvas colour',
      run: (f) => change(f, 'background-color', '#123456'),
    },
    {
      label: 'the frame style',
      run: (f) => change(f, 'frame-target', 'regions'),
    },
    {
      label: 'the frame colour',
      run: (f) => {
        f.element('frame-target').value = 'regions'
        change(f, 'frame-color', '#123456')
      },
    },
    {
      label: 'the frame thickness',
      run: (f) => {
        f.element('frame-target').value = 'canvas'
        change(f, 'frame-width', '20')
      },
    },
    {
      label: 'the remove image button',
      run: (f) => press(f, 'remove-background'),
    },
  ]

  it.each(actions)(
    'ignores $label while one region is active',
    async (action) => {
      const fixture = await app()

      action.run(fixture)

      expect(fixture.element('notice').hidden).toBe(true)
      expect(fixture.element('undo').disabled).toBe(true)
      expect(pressed(fixture, 'layout-one-region')).toBe('true')
    },
  )
})

describe('browser stacking controls', () => {
  it('records stack direction, restacking, and typed gaps for undo', async () => {
    const fixture = await stackedApp()
    expect(pressed(fixture, 'stack-vertical')).toBe('true')

    press(fixture, 'stack-horizontal')
    expect(pressed(fixture, 'stack-horizontal')).toBe('true')
    fixture.element('undo').click()
    expect(pressed(fixture, 'stack-vertical')).toBe('true')
    expect(pressed(fixture, 'layout-two-regions')).toBe('true')

    press(fixture, 'stack-vertical')
    fixture.element('undo').click()
    expect(pressed(fixture, 'layout-two-regions')).toBe('true')

    change(fixture, 'stack-gap', '40')
    expect(fieldValue(fixture, 'stack-gap')).toBe('40')
    fixture.element('undo').click()
    expect(fieldValue(fixture, 'stack-gap')).toBe('0')
    expect(pressed(fixture, 'layout-two-regions')).toBe('true')
  })

  it('restacks moved regions and records the restack for undo', async () => {
    const fixture = await stackedApp()
    change(fixture, 'region-output-y', '300')
    expect(fieldValue(fixture, 'region-output-y')).toBe('300')

    press(fixture, 'stack-regions')
    expect(fieldValue(fixture, 'region-output-y')).toBe('0')
    fixture.element('undo').click()
    expect(fieldValue(fixture, 'region-output-y')).toBe('300')
  })

  it('records a slider gesture once and every keyboard step separately', async () => {
    const fixture = await stackedApp()
    const slider = fixture.element('stack-gap-slider')

    enter(fixture, 'stack-gap-slider', '20')
    expect(fieldValue(fixture, 'stack-gap')).toBe('20')
    fixture.element('undo').click()
    expect(fieldValue(fixture, 'stack-gap')).toBe('0')
    expect(pressed(fixture, 'layout-two-regions')).toBe('true')

    for (const ending of ['pointerup', 'pointercancel', 'blur']) {
      slider.dispatchEvent(fixture.event('pointerdown'))
      enter(fixture, 'stack-gap-slider', '20')
      enter(fixture, 'stack-gap-slider', '40')
      slider.dispatchEvent(fixture.event(ending))
      enter(fixture, 'stack-gap-slider', '60')
      expect(fieldValue(fixture, 'stack-gap')).toBe('60')
      fixture.element('undo').click()
      expect(fieldValue(fixture, 'stack-gap')).toBe('40')
      fixture.element('undo').click()
      expect(fieldValue(fixture, 'stack-gap')).toBe('0')
      expect(pressed(fixture, 'layout-two-regions')).toBe('true')
    }
  })
})

describe('browser region controls', () => {
  it('selects a region and shows its own source crop', async () => {
    const fixture = await stackedApp()
    expect(pressed(fixture, 'select-region-1')).toBe('true')
    expect(fieldValue(fixture, 'crop-y')).toBe('0')

    fixture.element('select-region-2').click()
    expect(pressed(fixture, 'select-region-1')).toBe('false')
    expect(pressed(fixture, 'select-region-2')).toBe('true')
    expect(fieldValue(fixture, 'crop-y')).toBe('960')
    expect(fieldValue(fixture, 'crop-height')).toBe('960')

    fixture.element('select-region-1').click()
    expect(pressed(fixture, 'select-region-1')).toBe('true')
    expect(pressed(fixture, 'select-region-2')).toBe('false')
    expect(fieldValue(fixture, 'crop-y')).toBe('0')
  })

  it('scales through the number field, clamping and recording history', async () => {
    const fixture = await stackedApp()

    change(fixture, 'region-scale', '40')
    expect(fieldValue(fixture, 'region-scale')).toBe('40')
    expect(fieldValue(fixture, 'region-scale-slider')).toBe('40')
    change(fixture, 'region-scale', '150')
    expect(fieldValue(fixture, 'region-scale')).toBe('100')
    fixture.element('undo').click()
    expect(fieldValue(fixture, 'region-scale')).toBe('40')
    fixture.element('undo').click()
    expect(fieldValue(fixture, 'region-scale')).toBe('100')
    expect(pressed(fixture, 'layout-two-regions')).toBe('true')
  })

  it('records a scale slider gesture once and every keyboard step separately', async () => {
    const fixture = await stackedApp()
    const slider = fixture.element('region-scale-slider')

    enter(fixture, 'region-scale-slider', '40')
    expect(fieldValue(fixture, 'region-scale')).toBe('40')
    expect(fieldValue(fixture, 'region-scale-slider')).toBe('40')
    fixture.element('undo').click()
    expect(fieldValue(fixture, 'region-scale')).toBe('100')
    expect(pressed(fixture, 'layout-two-regions')).toBe('true')

    for (const ending of ['pointerup', 'pointercancel', 'blur']) {
      slider.dispatchEvent(fixture.event('pointerdown'))
      enter(fixture, 'region-scale-slider', '30')
      enter(fixture, 'region-scale-slider', '50')
      slider.dispatchEvent(fixture.event(ending))
      enter(fixture, 'region-scale-slider', '70')
      expect(fieldValue(fixture, 'region-scale')).toBe('70')
      fixture.element('undo').click()
      expect(fieldValue(fixture, 'region-scale')).toBe('50')
      fixture.element('undo').click()
      expect(fieldValue(fixture, 'region-scale')).toBe('100')
      expect(pressed(fixture, 'layout-two-regions')).toBe('true')
    }
  })

  it('normalises typed positions and records them for undo', async () => {
    const fixture = await stackedApp()
    change(fixture, 'region-scale', '50')

    change(fixture, 'region-output-x', '5000')
    expect(fieldValue(fixture, 'region-output-x')).toBe('540')
    change(fixture, 'region-output-y', '7')
    expect(fieldValue(fixture, 'region-output-y')).toBe('6')
    fixture.element('undo').click()
    expect(fieldValue(fixture, 'region-output-y')).toBe('0')
    expect(fieldValue(fixture, 'region-output-x')).toBe('540')
  })

  it('applies and undoes the canvas colour', async () => {
    const fixture = await stackedApp()

    change(fixture, 'background-color', '#123456')
    expect(fixture.element('background-color-label').textContent).toBe(
      '#123456',
    )
    fixture.element('undo').click()
    expect(fieldValue(fixture, 'background-color')).toBe('#000000')
    expect(fixture.element('background-color-label').textContent).toBe(
      '#000000',
    )
  })
})

describe('browser frame controls', () => {
  it('rejects unknown styles and missing thickness without changing the frame', async () => {
    const fixture = await stackedApp()

    change(fixture, 'frame-target', 'bogus')
    expect(fixture.element('notice').textContent).toBe(
      'Choose a supported frame style.',
    )
    expect(fixture.element('frame-options').hidden).toBe(true)

    change(fixture, 'frame-width', '')
    change(fixture, 'frame-target', 'regions')
    expect(fixture.element('notice').textContent).toBe(
      'Enter a frame thickness from 1 to 64 pixels.',
    )
    expect(fixture.element('frame-options').hidden).toBe(true)
  })

  it('accepts each style, rounds and clamps the thickness, and removes the frame', async () => {
    const fixture = await stackedApp()
    change(fixture, 'frame-target', 'regions')
    change(fixture, 'frame-color', '#abcdef')
    expect(fieldValue(fixture, 'frame-color')).toBe('#abcdef')

    for (const [target, typed, shown] of [
      ['regions', '12.6', '13'],
      ['canvas', '0', '1'],
      ['canvas', '100', '64'],
      ['regions', '64', '64'],
    ] as const) {
      change(fixture, 'frame-target', target)
      change(fixture, 'frame-width', typed)
      expect(fixture.element('notice').hidden).toBe(true)
      expect(fieldValue(fixture, 'frame-target')).toBe(target)
      expect(fieldValue(fixture, 'frame-width')).toBe(shown)
      expect(fixture.element('frame-options').hidden).toBe(false)
    }
    expect((await exportedComposition(fixture)).frame).toEqual({
      target: 'regions',
      color: '#abcdef',
      width: 64,
    })

    change(fixture, 'frame-width', '')
    change(fixture, 'frame-target', 'none')
    expect(fixture.element('notice').hidden).toBe(true)
    expect(fieldValue(fixture, 'frame-target')).toBe('none')
    expect(fixture.element('frame-options').hidden).toBe(true)
    expect((await exportedComposition(fixture)).frame).toBeUndefined()

    fixture.element('undo').click()
    expect(fieldValue(fixture, 'frame-target')).toBe('regions')
    expect(fixture.element('frame-options').hidden).toBe(false)
  })
})

describe('browser reset controls', () => {
  it('ignores both reset buttons before a source is opened', async () => {
    const fixture = await app(undefined, false)

    expect(() => {
      press(fixture, 'reset')
      press(fixture, 'reset-crop')
    }).not.toThrow()

    expect(fixture.element('undo').disabled).toBe(true)
  })

  it('resets the crop of the active region only and records it', async () => {
    const fixture = await stackedApp()
    expect(fixture.element('reset-crop').textContent).toBe('Reset region')
    change(fixture, 'crop-height', '400')
    change(fixture, 'crop-y', '100')
    fixture.element('select-region-2').click()
    change(fixture, 'crop-height', '600')
    expect(fieldValue(fixture, 'crop-y')).toBe('960')
    fixture.element('select-region-1').click()
    expect(fieldValue(fixture, 'crop-y')).toBe('100')
    expect(fieldValue(fixture, 'crop-height')).toBe('400')

    press(fixture, 'reset-crop')
    expect(fieldValue(fixture, 'crop-y')).toBe('0')
    expect(fieldValue(fixture, 'crop-height')).toBe('960')
    fixture.element('select-region-2').click()
    expect(fieldValue(fixture, 'crop-height')).toBe('600')
    fixture.element('select-region-2').click()
    press(fixture, 'reset-crop')
    expect(fieldValue(fixture, 'crop-y')).toBe('960')
    expect(fieldValue(fixture, 'crop-height')).toBe('960')

    fixture.element('undo').click()
    expect(fieldValue(fixture, 'crop-height')).toBe('600')
    fixture.element('layout-one-region').click()
    expect(fieldValue(fixture, 'crop-height')).toBe('1920')
    expect(fieldValue(fixture, 'crop-y')).toBe('0')
  })

  it('resets the single crop and its aspect lock and records it', async () => {
    const fixture = await app()
    expect(fixture.element('reset-crop').textContent).toBe('Reset crop')
    change(fixture, 'aspect', '1')
    change(fixture, 'crop-x', '100')
    expect(fieldValue(fixture, 'crop-width')).toBe('1080')
    expect(fieldValue(fixture, 'crop-height')).toBe('1080')

    press(fixture, 'reset-crop')
    expect(fieldValue(fixture, 'aspect')).toBe('free')
    expect(fieldValue(fixture, 'crop-height')).toBe('1920')
    expect(fieldValue(fixture, 'crop-x')).toBe('0')
    fixture.element('undo').click()
    expect(fieldValue(fixture, 'aspect')).toBe('1')
    expect(fieldValue(fixture, 'crop-height')).toBe('1080')
  })

  it('restores the preset composition and keeps the layout on reset', async () => {
    const fixture = await stackedApp()
    change(fixture, 'output-aspect', '16:9')
    change(fixture, 'region-scale', '40')
    change(fixture, 'stack-gap', '40')

    press(fixture, 'reset')

    expect(pressed(fixture, 'layout-two-regions')).toBe('true')
    expect(fieldValue(fixture, 'output-aspect')).toBe('16:9')
    expect(fixture.element('output-resolution').textContent).toBe('1920 × 1080')
    expect(fieldValue(fixture, 'region-scale')).not.toBe('40')
    expect(fieldValue(fixture, 'stack-gap')).toBe('0')
  })

  it('resets a single-region edit without building a composition', async () => {
    const fixture = await app({ width: 1, height: 1 })
    change(fixture, 'aspect', '1')

    expect(() => press(fixture, 'reset')).not.toThrow()

    expect(fixture.element('notice').hidden).toBe(true)
    expect(fieldValue(fixture, 'aspect')).toBe('free')
    fixture.element('undo').click()
    expect(fieldValue(fixture, 'aspect')).toBe('1')
  })
})

import { afterEach, describe, expect, it } from 'vitest'

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
  activeFixture = await loadBrowserApp()
  return activeFixture
}

function click(fixture: BrowserFixture, id: string): void {
  fixture.element(id).dispatchEvent(fixture.event('click'))
}

function values(fixture: BrowserFixture, ...ids: string[]): string[] {
  return ids.map((id) => fixture.element(id).value)
}

describe('browser editor before a source is open', () => {
  it('offers every output preset with its label', async () => {
    const fixture = await app()
    const options = fixture.element('output-aspect').children
    const summary = options.map((option) => {
      if (!(option instanceof BrowserElement)) throw new Error('not an element')
      return [
        option.tagName,
        option.className,
        option.value,
        option.textContent,
      ]
    })

    expect(summary).toEqual([
      ['OPTION', '', '9:16', 'Portrait · 9:16'],
      ['OPTION', '', '16:9', 'Landscape · 16:9'],
      ['OPTION', '', '1:1', 'Square · 1:1'],
      ['OPTION', '', '3:2', 'Landscape · 3:2'],
      ['OPTION', '', '2:3', 'Portrait · 2:3'],
      ['OPTION', '', '4:3', 'Landscape · 4:3'],
      ['OPTION', '', '3:4', 'Portrait · 3:4'],
      ['OPTION', '', '4:5', 'Portrait · 4:5'],
      ['OPTION', '', '5:4', 'Landscape · 5:4'],
      ['OPTION', '', '21:9', 'Ultrawide · 21:9'],
    ])
  })

  it('renders the untouched draft and ignores history and playback', async () => {
    const fixture = await app()
    const expectUntouchedDraft = (): void => {
      click(fixture, 'select-region-1')
      expect(
        values(fixture, 'crop-x', 'crop-y', 'crop-width', 'crop-height'),
      ).toEqual(['0', '0', '2', '2'])
      expect(fixture.element('aspect').value).toBe('free')
      expect(fixture.element('output-resolution').textContent).toBe('2 × 2')
      expect(
        fixture.element('layout-one-region').getAttribute('aria-pressed'),
      ).toBe('true')
      expect(
        fixture.element('layout-two-regions').getAttribute('aria-pressed'),
      ).toBe('false')
    }

    expectUntouchedDraft()
    click(fixture, 'undo')
    expectUntouchedDraft()
    click(fixture, 'redo')
    expectUntouchedDraft()

    click(fixture, 'play')
    click(fixture, 'output-play')
    await fixture.settle()
    expect((fixture.element('video') as BrowserVideo).paused).toBe(true)
    expect(fixture.element('notice').hidden).toBe(true)
  })

  it('has no clips to preview even when the video element reports data', async () => {
    const fixture = await app()
    const video = fixture.element('video') as BrowserVideo
    video.readyState = 4
    video.dispatchEvent(fixture.event('loadeddata'))
    await fixture.settle()

    click(fixture, 'play')
    await fixture.settle()
    expect(fixture.element('notice').hidden).toBe(false)
    expect(fixture.element('notice').textContent).toBe(
      'Keep at least one clip to preview your edit.',
    )
    expect(video.paused).toBe(true)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BrowserElement,
  BrowserFixture,
  BrowserVideo,
  loadBrowserApp,
} from '../helpers/browser-dom.js'

const ERROR_MESSAGE =
  'Video preview failed. Check that the source is a readable video and FFmpeg is still available.'

let activeFixture: BrowserFixture | undefined

afterEach(() => {
  activeFixture?.dispose()
  activeFixture = undefined
})

interface Options {
  readonly width?: number
  readonly height?: number
  readonly select?: boolean
  readonly autoLoadMedia?: boolean
  readonly configure?: (fixture: BrowserFixture) => void
}

async function app(options: Options = {}): Promise<BrowserFixture> {
  const {
    width = 640,
    height = 480,
    select = true,
    autoLoadMedia = true,
    configure,
  } = options
  activeFixture = await loadBrowserApp((fixture) => {
    fixture.addVideo('source.mp4', { width, height, duration: 10, fps: 25 })
    fixture.autoLoadMedia = autoLoadMedia
    configure?.(fixture)
  })
  if (select) {
    activeFixture.find('file-button')[0]?.click()
    await activeFixture.settle(50)
  }
  return activeFixture
}

function player(fixture: BrowserFixture): BrowserVideo {
  return fixture.element('video') as BrowserVideo
}

function change(fixture: BrowserFixture, id: string, value: string): void {
  const input = fixture.element(id)
  input.value = value
  input.dispatchEvent(fixture.event('change'))
}

function fieldValue(fixture: BrowserFixture, id: string): string {
  return fixture.element(id).value
}

function output(fixture: BrowserFixture): string | undefined {
  return fixture.element('output-resolution').textContent
}

function captureCreatedVideos(fixture: BrowserFixture): BrowserVideo[] {
  const created: BrowserVideo[] = []
  const original = fixture.document.createElement.bind(fixture.document)
  fixture.document.createElement = (tag: string): BrowserElement => {
    const made = original(tag)
    if (made instanceof BrowserVideo) created.push(made)
    return made
  }
  return created
}

async function stalledPreview(): Promise<{
  fixture: BrowserFixture
  filmstrip: BrowserVideo
}> {
  const fixture = await app({ autoLoadMedia: false })
  const created = captureCreatedVideos(fixture)
  const video = player(fixture)
  video.readyState = 4
  video.dispatchEvent(fixture.event('loadeddata'))
  await fixture.settle(50)
  const filmstrip = created[0]
  if (filmstrip === undefined) throw new Error('No filmstrip video was created')
  expect(fixture.element('play').disabled).toBe(false)
  return { fixture, filmstrip }
}

describe('browser crop and aspect controls', () => {
  it('ignores crop and aspect edits before a source is opened', async () => {
    const fixture = await app({ select: false })

    change(fixture, 'aspect', '1')
    change(fixture, 'crop-width', '100')
    change(fixture, 'crop-x', '10')

    expect(fixture.element('notice').hidden).toBe(true)
    expect(fixture.element('undo').disabled).toBe(true)
  })

  it('keeps the crop when the aspect returns to free and records each change', async () => {
    const fixture = await app()

    change(fixture, 'aspect', '1')
    expect(output(fixture)).toBe('480 × 480')
    expect(fieldValue(fixture, 'crop-x')).toBe('80')
    change(fixture, 'aspect', 'free')
    expect(output(fixture)).toBe('480 × 480')
    expect(fieldValue(fixture, 'crop-x')).toBe('80')

    fixture.element('undo').click()
    expect(fieldValue(fixture, 'aspect')).toBe('1')
    expect(output(fixture)).toBe('480 × 480')
    fixture.element('undo').click()
    expect(fieldValue(fixture, 'aspect')).toBe('free')
    expect(output(fixture)).toBe('640 × 480')
    expect(fixture.element('undo').disabled).toBe(true)
  })

  it('derives the other side of a locked ratio and records the edit', async () => {
    const fixture = await app()
    change(fixture, 'aspect', '2')
    expect(output(fixture)).toBe('640 × 320')

    change(fixture, 'crop-width', '400')
    expect(output(fixture)).toBe('400 × 200')
    change(fixture, 'crop-height', '150')
    expect(output(fixture)).toBe('300 × 150')
    change(fixture, 'crop-x', '100')
    change(fixture, 'crop-y', '20')
    expect(output(fixture)).toBe('300 × 150')
    expect(fieldValue(fixture, 'crop-x')).toBe('100')
    expect(fieldValue(fixture, 'crop-y')).toBe('20')

    fixture.element('undo').click()
    fixture.element('undo').click()
    fixture.element('undo').click()
    expect(output(fixture)).toBe('400 × 200')
    fixture.element('undo').click()
    expect(output(fixture)).toBe('640 × 320')
  })

  it('changes one side of a free crop without touching the other', async () => {
    const fixture = await app()

    change(fixture, 'crop-height', '200')
    expect(output(fixture)).toBe('640 × 200')
    change(fixture, 'crop-width', '320')
    expect(output(fixture)).toBe('320 × 200')
    fixture.element('undo').click()
    expect(output(fixture)).toBe('640 × 200')
  })

  it('records a mute change for undo', async () => {
    const fixture = await app()
    const video = player(fixture)

    fixture.element('keep-audio').checked = false
    fixture.element('keep-audio').dispatchEvent(fixture.event('change'))
    expect(video.muted).toBe(true)
    expect(fixture.element('audio-encoding').hidden).toBe(true)

    fixture.element('undo').click()
    expect(fixture.element('keep-audio').checked).toBe(true)
    expect(video.muted).toBe(false)
    expect(fixture.element('audio-encoding').hidden).toBe(false)
  })

  it('applies the speed of the speed selector only', async () => {
    const fixture = await app()
    const video = player(fixture)
    const other = fixture.element('output-name')
    other.value = '3'
    const event = fixture.event('change')
    event.target = other

    fixture.element('speed').dispatchEvent(event)
    expect(video.playbackRate).toBe(1)

    change(fixture, 'speed', '0.5')
    expect(video.playbackRate).toBe(0.5)
  })

  it('seeks from the scrubber only when the preview is ready', async () => {
    const fixture = await app()
    const video = player(fixture)

    fixture.element('scrubber').value = '3.5'
    fixture.element('scrubber').dispatchEvent(fixture.event('input'))

    expect(video.currentTime).toBe(3.5)
    expect(fixture.element('current-time').textContent).toBe('00:03.50')
  })

  it('does not move the single crop by dragging while two regions are active', async () => {
    const fixture = await app({ width: 640, height: 360 })
    change(fixture, 'crop-width', '320')
    change(fixture, 'crop-height', '180')
    const box = fixture.element('crop-box')

    fixture.element('layout-two-regions').click()
    const down = fixture.event('pointerdown', {
      button: 0,
      clientX: 10,
      clientY: 10,
    })
    box.dispatchEvent(down)
    box.dispatchEvent(
      fixture.event('pointermove', { clientX: 60, clientY: 40 }),
    )
    box.dispatchEvent(fixture.event('pointerup'))
    expect(down.defaultPrevented).toBe(false)
    fixture.element('layout-one-region').click()

    expect(fieldValue(fixture, 'crop-x')).toBe('0')
    expect(fieldValue(fixture, 'crop-y')).toBe('0')
    fixture.element('layout-one-region').click()
    box.dispatchEvent(
      fixture.event('pointerdown', { button: 0, clientX: 10, clientY: 10 }),
    )
    box.dispatchEvent(
      fixture.event('pointermove', { clientX: 60, clientY: 40 }),
    )
    box.dispatchEvent(fixture.event('pointerup'))
    expect(Number(fieldValue(fixture, 'crop-x'))).toBeGreaterThan(0)
  })
})

describe('browser preview lifecycle', () => {
  it('hides the loading notice and enables playback once the preview is ready', async () => {
    const fixture = await app()

    expect(fixture.element('preview-loading').hidden).toBe(true)
    expect(fixture.element('play').disabled).toBe(false)
    expect(fixture.element('output-play').disabled).toBe(false)
    expect(fixture.element('workspace-status').textContent).toBe(
      'All changes are local · Source file preserved',
    )
  })

  it('treats a preview with current data as ready but one below it as not ready', async () => {
    const fixture = await app({ autoLoadMedia: false })
    const video = player(fixture)
    expect(fixture.element('preview-loading').hidden).toBe(false)

    video.readyState = 1
    video.dispatchEvent(fixture.event('loadeddata'))
    expect(fixture.element('play').disabled).toBe(true)
    expect(fixture.element('preview-loading').hidden).toBe(false)

    video.readyState = 2
    video.dispatchEvent(fixture.event('loadeddata'))
    expect(fixture.element('play').disabled).toBe(false)
    expect(fixture.element('preview-loading').hidden).toBe(true)
  })

  it('reports a failed preview and disables playback and seeking', async () => {
    const fixture = await app({ autoLoadMedia: false })
    const video = player(fixture)
    video.readyState = 4
    video.dispatchEvent(fixture.event('loadeddata'))
    await fixture.settle(50)
    expect(fixture.element('output-play').disabled).toBe(false)

    video.dispatchEvent(fixture.event('error'))

    expect(fixture.element('play').disabled).toBe(true)
    expect(fixture.element('output-play').disabled).toBe(true)
    expect(fixture.element('preview-loading').hidden).toBe(false)
    expect(fixture.element('preview-loading').textContent).toBe(
      'Could not prepare this video. Refresh the page to retry, or choose another source.',
    )
    expect(fixture.element('notice').hidden).toBe(false)
    expect(fixture.element('notice').textContent).toBe(ERROR_MESSAGE)
    fixture.element('scrubber').value = '5'
    fixture.element('scrubber').dispatchEvent(fixture.event('input'))
    expect(video.currentTime).toBe(0)
  })

  it('ignores errors from a source that is no longer the preview', async () => {
    const fixture = await app({ autoLoadMedia: false })
    const video = player(fixture)
    video.readyState = 4
    video.dispatchEvent(fixture.event('loadeddata'))
    await fixture.settle(50)
    const current = video.currentSrc

    video.currentSrc = 'http://127.0.0.1:43123/api/preview?name=old.mp4'
    video.dispatchEvent(fixture.event('error'))

    expect(fixture.element('play').disabled).toBe(false)
    expect(fixture.element('output-play').disabled).toBe(false)
    expect(fixture.element('preview-loading').hidden).toBe(true)
    expect(fixture.element('notice').hidden).toBe(true)
    video.currentSrc = current
    fixture.element('scrubber').value = '5'
    fixture.element('scrubber').dispatchEvent(fixture.event('input'))
    expect(video.currentTime).toBe(5)
  })

  it('reports a thumbnail failure only while its source is still open', async () => {
    const current = await stalledPreview()
    current.filmstrip.dispatchEvent(current.fixture.event('error'))
    await current.fixture.settle(50)
    expect(current.fixture.element('notice').textContent).toBe(
      'Timeline preview could not be loaded.',
    )
    current.fixture.dispose()

    const stale = await stalledPreview()
    activeFixture = stale.fixture
    stale.fixture.find('file-button')[0]?.click()
    stale.filmstrip.dispatchEvent(stale.fixture.event('error'))
    await stale.fixture.settle(50)
    expect(stale.fixture.element('notice').hidden).toBe(true)
  })

  it('stops drawing thumbnails once an export has started and another source action followed', async () => {
    const { fixture, filmstrip } = await stalledPreview()

    fixture.element('export-button').click()
    await fixture.settle(50)
    expect(fixture.element('export-result').hidden).toBe(false)
    fixture.find('file-button')[0]?.click()
    filmstrip.dispatchEvent(fixture.event('loadeddata'))
    await fixture.settle(50)

    expect(fixture.canvasDraw).not.toHaveBeenCalled()
  })

  it('draws every thumbnail when the source stays the same', async () => {
    const { fixture, filmstrip } = await stalledPreview()

    filmstrip.dispatchEvent(fixture.event('loadeddata'))
    await fixture.settle(100)

    expect(fixture.canvasDraw).toHaveBeenCalledTimes(10)
  })

  it('keeps the play controls in sync when the icons are missing', async () => {
    const fixture = await app()
    fixture.document.elements.delete('play-icon')
    fixture.document.elements.delete('output-play-icon')

    fixture.element('play').click()
    await fixture.settle()
    expect(fixture.element('notice').hidden).toBe(true)
    expect(fixture.element('play').getAttribute('aria-label')).toBe(
      'Pause video',
    )
    expect(fixture.element('output-play-label').textContent).toBe(
      'Pause output',
    )
    fixture.element('play').click()
    await fixture.settle()
    expect(fixture.element('notice').hidden).toBe(true)
    expect(fixture.element('play').getAttribute('aria-label')).toBe(
      'Play video',
    )
    expect(fixture.element('output-play-label').textContent).toBe('Play output')
  })

  it('swaps both play icons between play and pause', async () => {
    const fixture = await app()
    const PLAY = 'm8 5 11 7-11 7z'
    const PAUSE = 'M8 5v14M16 5v14'
    expect(fixture.element('play-icon').getAttribute('d')).toBe(PLAY)

    fixture.element('play').click()
    await fixture.settle()
    expect(fixture.element('play-icon').getAttribute('d')).toBe(PAUSE)
    expect(fixture.element('output-play-icon').getAttribute('d')).toBe(PAUSE)

    fixture.element('play').click()
    expect(fixture.element('play-icon').getAttribute('d')).toBe(PLAY)
    expect(fixture.element('output-play-icon').getAttribute('d')).toBe(PLAY)
  })
})

describe('browser preview frame observer', () => {
  it('re-renders the frame whenever the stage is resized', async () => {
    const observers = new Map<unknown, () => void>()
    const fixture = await app({
      width: 640,
      height: 360,
      configure: () => {
        class RecordingObserver {
          constructor(private readonly callback: () => void) {}
          observe(target: unknown): void {
            observers.set(target, this.callback)
          }
          disconnect(): void {}
          unobserve(): void {}
        }
        vi.stubGlobal('ResizeObserver', RecordingObserver)
      },
    })
    const stage = fixture.element('video-stage')
    const notify = observers.get(stage)
    if (notify === undefined) throw new Error('The stage is not observed')
    expect(fixture.element('video-frame').style['width']).toBe(
      `${640 * ((540 - 32) / 360)}px`,
    )

    stage.clientWidth = 500
    notify()

    expect(fixture.element('video-frame').style['width']).toBe(
      `${640 * ((500 - 32) / 640)}px`,
    )
    expect(fixture.element('video-frame').style['height']).toBe(
      `${360 * ((500 - 32) / 640)}px`,
    )
  })
})

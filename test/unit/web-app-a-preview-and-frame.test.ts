import { afterEach, describe, expect, it, vi } from 'vitest'

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

async function app(
  configure?: (fixture: BrowserFixture) => void,
): Promise<BrowserFixture> {
  activeFixture = await loadBrowserApp(configure)
  return activeFixture
}

async function select(fixture: BrowserFixture, index = 0): Promise<void> {
  fixture.find('file-button')[index]?.click()
  await fixture.settle(50)
}

function change(fixture: BrowserFixture, id: string, value: string): void {
  const input = fixture.element(id)
  input.value = value
  input.dispatchEvent(fixture.event('change'))
}

function press(
  fixture: BrowserFixture,
  options: Parameters<BrowserFixture['event']>[1],
): void {
  fixture.document.dispatchEvent(fixture.event('keydown', options))
}

function styles(element: BrowserElement, ...keys: string[]): string[] {
  return keys.map((key) => element.style[key] ?? '')
}

interface SourceWatch {
  readonly sources: BrowserVideo[]
  readonly seekTimes: number[][]
  readonly loads: Array<ReturnType<typeof vi.fn>>
}

function watchFilmstripSources(
  fixture: BrowserFixture,
  options: {
    readonly dimensions?: ReadonlyArray<readonly [number, number]>
    readonly interrupt?: {
      readonly event: 'loadeddata' | 'seeked'
      readonly action: () => void
    }
  } = {},
): SourceWatch {
  const watch: SourceWatch = { sources: [], seekTimes: [], loads: [] }
  const original = fixture.document.createElement.bind(fixture.document)
  fixture.document.createElement = (tag: string): BrowserElement => {
    const created = original(tag)
    if (created instanceof BrowserVideo) {
      const size = options.dimensions?.[watch.sources.length]
      if (size !== undefined) {
        created.videoWidth = size[0]
        created.videoHeight = size[1]
      }
      const times: number[] = []
      const load = vi.fn()
      created.load = load
      created.addEventListener('seeked', () => {
        times.push(created.currentTime)
      })
      if (options.interrupt !== undefined) {
        const { event, action } = options.interrupt
        let interrupted = false
        created.addEventListener(event, () => {
          if (interrupted) return
          interrupted = true
          action()
        })
      }
      watch.sources.push(created)
      watch.seekTimes.push(times)
      watch.loads.push(load)
    }
    return created
  }
  return watch
}

function watchContextKinds(
  fixture: BrowserFixture,
  id: string,
): readonly string[] {
  const canvas = fixture.element(id) as unknown as {
    getContext(kind: string): unknown
  }
  const kinds: string[] = []
  const original = canvas.getContext.bind(canvas)
  canvas.getContext = (kind: string): unknown => {
    kinds.push(kind)
    return original(kind)
  }
  return kinds
}

describe('browser preview frame geometry', () => {
  it('fits the source and the crop overlay into the stage minus its padding', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('wide.mp4', { width: 1856, height: 400 })
      browser.addVideo('tall.mp4', { width: 400, height: 1016 })
    })
    const frame = fixture.element('video-frame')
    const video = fixture.element('video')
    const box = fixture.element('crop-box')
    const label = fixture.element('source-aspect-label')

    await select(fixture, 0)
    expect(styles(frame, 'width', 'height')).toEqual(['928px', '200px'])
    expect(styles(video, 'width', 'height', 'left', 'top')).toEqual([
      '928px',
      '200px',
      '0px',
      '0px',
    ])
    expect(box.hidden).toBe(false)
    expect(styles(box, 'left', 'top', 'width', 'height')).toEqual([
      '0px',
      '0px',
      '928px',
      '200px',
    ])
    expect(fixture.element('crop-size').textContent).toBe('1856 × 400')
    expect(label.textContent).toBe('4.64:1')
    expect(label.title).toBe('1856 × 400')
    expect(fixture.element('view-source').getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(fixture.element('view-result').getAttribute('aria-pressed')).toBe(
      'false',
    )

    change(fixture, 'crop-width', '928')
    change(fixture, 'crop-height', '200')
    change(fixture, 'crop-x', '464')
    change(fixture, 'crop-y', '100')
    expect(styles(box, 'left', 'top', 'width', 'height')).toEqual([
      '232px',
      '50px',
      '464px',
      '100px',
    ])
    expect(fixture.element('crop-size').textContent).toBe('928 × 200')
    expect(label.textContent).toBe('4.64:1')
    expect(label.title).toBe('1856 × 400')

    fixture.element('view-result').click()
    expect(styles(frame, 'width', 'height')).toEqual(['928px', '200px'])
    expect(styles(video, 'width', 'height', 'left', 'top')).toEqual([
      '1856px',
      '400px',
      '-464px',
      '-100px',
    ])
    expect(box.hidden).toBe(true)
    expect(label.textContent).toBe('4.64:1')
    expect(label.title).toBe('928 × 200')
    expect(fixture.element('view-source').getAttribute('aria-pressed')).toBe(
      'false',
    )
    expect(fixture.element('view-result').getAttribute('aria-pressed')).toBe(
      'true',
    )

    fixture.element('view-source').click()
    expect(styles(frame, 'width', 'height')).toEqual(['928px', '200px'])
    expect(styles(video, 'width', 'height', 'left', 'top')).toEqual([
      '928px',
      '200px',
      '0px',
      '0px',
    ])
    expect(box.hidden).toBe(false)
    expect(label.title).toBe('1856 × 400')

    await select(fixture, 1)
    expect(styles(frame, 'width', 'height')).toEqual(['200px', '508px'])
    expect(styles(video, 'width', 'height', 'left', 'top')).toEqual([
      '200px',
      '508px',
      '0px',
      '0px',
    ])
    expect(styles(box, 'left', 'top', 'width', 'height')).toEqual([
      '0px',
      '0px',
      '200px',
      '508px',
    ])
    expect(label.textContent).toBe('1:2.54')
    expect(label.title).toBe('400 × 1016')
  })

  it.each([
    [1920, 1080, '16:9'],
    [1280, 720, '16:9'],
    [2520, 1080, '21:9'],
    [2100, 900, '21:9'],
    [1000, 700, '10:7'],
    [50, 49, '50:49'],
    [49, 50, '49:50'],
    [51, 50, '1.02:1'],
    [50, 51, '1:1.02'],
    [4096, 2160, '1.90:1'],
    [2160, 4096, '1:1.90'],
  ])('labels a %ix%i source as %s', async (width, height, expected) => {
    const fixture = await app((browser) => {
      browser.addVideo('shape.mp4', { width, height })
    })
    await select(fixture)
    const label = fixture.element('source-aspect-label')
    expect(label.textContent).toBe(expected)
    expect(label.title).toBe(`${width} × ${height}`)
  })

  it('keeps the source dimensions in the two-region layout even when the cropped view is selected', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('wide.mp4', { width: 1856, height: 400 })
    })
    await select(fixture)
    change(fixture, 'crop-width', '928')
    change(fixture, 'crop-height', '200')
    change(fixture, 'crop-x', '464')
    change(fixture, 'crop-y', '100')
    const frame = fixture.element('video-frame')
    const video = fixture.element('video')
    const box = fixture.element('crop-box')
    const label = fixture.element('source-aspect-label')

    fixture.element('layout-two-regions').click()
    expect(box.hidden).toBe(true)
    fixture.element('view-result').click()
    expect(box.hidden).toBe(true)
    expect(styles(frame, 'width', 'height')).toEqual(['928px', '200px'])
    expect(styles(video, 'width', 'height', 'left', 'top')).toEqual([
      '928px',
      '200px',
      '0px',
      '0px',
    ])
    expect(label.textContent).toBe('4.64:1')
    expect(label.title).toBe('1856 × 400')

    fixture.element('layout-one-region').click()
    expect(box.hidden).toBe(false)
  })
})

describe('browser preview time and seeking', () => {
  it('updates every time display as soon as the scrubber moves the playhead', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo
    const scrubber = fixture.element('scrubber')

    scrubber.value = '3.5'
    scrubber.dispatchEvent(fixture.event('input'))
    expect(video.currentTime).toBe(3.5)
    expect(fixture.element('current-time').textContent).toBe('00:03.50')
    expect(fixture.element('output-current-time').textContent).toBe('00:03.50')
    expect(fixture.element('playhead').style['left']).toBe('35%')
    expect(scrubber.value).toBe('3.5')

    scrubber.value = '12'
    scrubber.dispatchEvent(fixture.event('input'))
    expect(video.currentTime).toBe(10)
    expect(fixture.element('current-time').textContent).toBe('00:10.00')
    expect(fixture.element('playhead').style['left']).toBe('100%')
    expect(scrubber.value).toBe('10')

    scrubber.value = '-4'
    scrubber.dispatchEvent(fixture.event('input'))
    expect(video.currentTime).toBe(0)
    expect(fixture.element('playhead').style['left']).toBe('0%')
  })

  it('redraws the composition output whenever the playhead time is rendered', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    fixture.element('layout-two-regions').click()
    await fixture.settle()
    const video = fixture.element('video') as BrowserVideo

    fixture.canvasFill.mockClear()
    fixture.canvasDraw.mockClear()
    video.dispatchEvent(fixture.event('timeupdate'))
    expect(fixture.canvasFill).toHaveBeenCalledTimes(1)
    expect(fixture.canvasFill).toHaveBeenCalledWith(0, 0, 1080, 1920)
    expect(fixture.canvasDraw).toHaveBeenCalledTimes(2)

    fixture.canvasFill.mockClear()
    const scrubber = fixture.element('scrubber')
    scrubber.value = '4'
    scrubber.dispatchEvent(fixture.event('input'))
    expect(fixture.canvasFill).toHaveBeenCalledTimes(1)
  })

  it('ignores time updates and seeks until a source is open and its preview is ready', async () => {
    const fresh = await app()
    const freshVideo = fresh.element('video') as BrowserVideo
    expect(() => {
      freshVideo.dispatchEvent(fresh.event('timeupdate'))
    }).not.toThrow()
    expect(fresh.element('current-time').textContent).toBe('00:00.00')
    fresh.dispose()

    const pending = await loadBrowserApp((browser) => {
      browser.addVideo('a.mp4')
      browser.autoLoadMedia = false
    })
    activeFixture = pending
    await select(pending)
    const video = pending.element('video') as BrowserVideo
    const scrubber = pending.element('scrubber')
    scrubber.value = '5'
    scrubber.dispatchEvent(pending.event('input'))
    press(pending, { key: 'ArrowRight', shiftKey: true })
    expect(video.currentTime).toBe(0)
    expect(pending.element('current-time').textContent).toBe('00:00.00')
    pending.dispose()

    const orphan = await loadBrowserApp()
    activeFixture = orphan
    const orphanVideo = orphan.element('video') as BrowserVideo
    orphanVideo.readyState = 4
    orphanVideo.dispatchEvent(orphan.event('loadeddata'))
    await orphan.settle()
    expect(orphan.element('play').disabled).toBe(false)
    expect(orphan.element('notice').hidden).toBe(true)
    const orphanScrubber = orphan.element('scrubber')
    orphanScrubber.value = '5'
    expect(() => {
      orphanScrubber.dispatchEvent(orphan.event('input'))
    }).not.toThrow()
    expect(orphanVideo.currentTime).toBe(0)
  })

  it('does not move the playhead when a stale clip chip is activated', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo
    video.currentTime = 4
    fixture.element('split').click()
    const staleChip = fixture.find('clip-chip', fixture.element('clip-list'))[1]
    fixture.element('remove').click()
    video.currentTime = 1
    await fixture.settle()

    expect(() => staleChip?.click()).not.toThrow()
    expect(video.currentTime).toBe(1)
  })
})

describe('browser preview playback', () => {
  it('does not start playback before the preview is ready', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.autoLoadMedia = false
    })
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo

    fixture.element('play').dispatchEvent(fixture.event('click'))
    await fixture.settle()
    expect(video.paused).toBe(true)
    expect(fixture.element('notice').hidden).toBe(true)
    press(fixture, { code: 'Space' })
    await fixture.settle()
    expect(video.paused).toBe(true)
  })

  it('restarts from the first kept clip when playback starts after the last one', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo
    change(fixture, 'clip-in', '1')
    video.currentTime = 10

    fixture.element('play').click()
    await fixture.settle()
    expect(fixture.element('notice').hidden).toBe(true)
    expect(video.currentTime).toBe(1)
    expect(video.paused).toBe(false)
  })

  it('skips only real gaps and keeps requesting frames while playing', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const video = fixture.element('video') as BrowserVideo
    change(fixture, 'clip-in', '0.02')
    video.currentTime = 5

    fixture.element('play').click()
    await fixture.settle()
    expect(video.paused).toBe(false)
    expect(frames).toHaveLength(1)

    const seeked = vi.fn()
    video.addEventListener('seeked', seeked)
    frames.splice(0).forEach((frame) => frame(0))
    await fixture.settle()
    expect(seeked).not.toHaveBeenCalled()
    expect(video.currentTime).toBe(5)
    expect(frames).toHaveLength(1)

    video.currentTime = 0
    await fixture.settle()
    seeked.mockClear()
    frames.splice(0).forEach((frame) => frame(0))
    await fixture.settle()
    expect(seeked).not.toHaveBeenCalled()
    expect(video.currentTime).toBe(0)
    expect(frames).toHaveLength(1)

    video.currentTime = 0
    change(fixture, 'clip-in', '2')
    await fixture.settle()
    seeked.mockClear()
    frames.splice(0).forEach((frame) => frame(0))
    await fixture.settle()
    expect(seeked).toHaveBeenCalledTimes(1)
    expect(video.currentTime).toBe(2)

    video.pause()
    frames.splice(0).forEach((frame) => frame(0))
    expect(frames).toHaveLength(0)
  })
})

describe('browser timeline filmstrip', () => {
  it('draws ten centered square thumbnails from a muted preload copy and releases it', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('wide.mp4', { duration: 20 })
      browser.addVideo('tall.mp4', { duration: 30 })
    })
    const watch = watchFilmstripSources(fixture, {
      dimensions: [
        [800, 600],
        [600, 800],
      ],
    })
    const kinds = watchContextKinds(fixture, 'filmstrip')

    await select(fixture, 0)
    expect(watch.sources).toHaveLength(1)
    const wide = fixture.canvasDraw.mock.calls
    expect(wide.map((call) => call[0])).toEqual(
      Array.from({ length: 10 }, () => watch.sources[0]),
    )
    expect(wide.map((call) => call.slice(1))).toEqual(
      Array.from({ length: 10 }, (_, index) => [
        100,
        0,
        600,
        600,
        index * 100,
        0,
        100,
        100,
      ]),
    )
    expect(watch.seekTimes[0]).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19])
    expect(watch.sources[0]?.muted).toBe(true)
    expect(watch.sources[0]?.preload).toBe('auto')
    expect(watch.sources[0]?.src).toBe('')
    expect(watch.sources[0]?.currentSrc).toBe('')
    expect(watch.loads[0]).toHaveBeenCalledTimes(1)
    expect(fixture.element('filmstrip').getAttribute('aria-hidden')).toBe(
      'true',
    )

    fixture.canvasDraw.mockClear()
    await select(fixture, 1)
    expect(watch.sources).toHaveLength(2)
    expect(fixture.canvasDraw.mock.calls.map((call) => call.slice(1))).toEqual(
      Array.from({ length: 10 }, (_, index) => [
        0,
        100,
        600,
        600,
        index * 100,
        0,
        100,
        100,
      ]),
    )
    expect(watch.seekTimes[1]).toEqual([
      1.5, 4.5, 7.5, 10.5, 13.5, 16.5, 19.5, 22.5, 25.5, 28.5,
    ])
    expect(watch.loads[1]).toHaveBeenCalledTimes(1)
    expect(kinds).toEqual(['2d', '2d', '2d', '2d'])
    expect(fixture.canvasClear).toHaveBeenCalledTimes(2)
    expect(fixture.canvasClear).toHaveBeenLastCalledWith(0, 0, 1000, 100)
  })

  it('stops before seeking when the source changes while the thumbnail copy loads', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.addVideo('b.mp4')
    })
    fixture.deferProbe('b.mp4')
    const watch = watchFilmstripSources(fixture, {
      interrupt: {
        event: 'loadeddata',
        action: () => fixture.find('file-button')[1]?.click(),
      },
    })

    await select(fixture, 0)
    expect(watch.sources).toHaveLength(1)
    expect(watch.seekTimes[0]).toEqual([])
    expect(fixture.canvasDraw).not.toHaveBeenCalled()
    expect(fixture.element('notice').hidden).toBe(true)
    expect(watch.sources[0]?.src).toBe('')
    expect(watch.loads[0]).toHaveBeenCalledTimes(1)
  })

  it('stops before drawing when the source changes while a thumbnail seek is pending', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.addVideo('b.mp4')
    })
    fixture.deferProbe('b.mp4')
    const watch = watchFilmstripSources(fixture, {
      interrupt: {
        event: 'seeked',
        action: () => fixture.find('file-button')[1]?.click(),
      },
    })

    await select(fixture, 0)
    expect(watch.seekTimes[0]).toEqual([0.5])
    expect(fixture.canvasDraw).not.toHaveBeenCalled()
    expect(fixture.element('notice').hidden).toBe(true)
    expect(watch.loads[0]).toHaveBeenCalledTimes(1)
  })

  it('detaches its listeners and timers after a completed run', async () => {
    vi.useFakeTimers()
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    const watch = watchFilmstripSources(fixture)
    await select(fixture)

    expect(fixture.canvasDraw).toHaveBeenCalledTimes(10)
    expect(vi.getTimerCount()).toBe(0)
    const source = watch.sources[0]
    expect(source?.listenerCount('loadeddata')).toBe(0)
    expect(source?.listenerCount('error')).toBe(0)
    expect(source?.listenerCount('seeked')).toBe(1)
  })

  it('reports a copy that fails to load and detaches its listeners', async () => {
    vi.useFakeTimers()
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.failFilmstrip = true
    })
    const watch = watchFilmstripSources(fixture)
    await select(fixture)

    expect(fixture.element('notice').textContent).toBe(
      'Timeline preview could not be loaded.',
    )
    expect(vi.getTimerCount()).toBe(0)
    const source = watch.sources[0]
    expect(source?.listenerCount('loadeddata')).toBe(0)
    expect(source?.listenerCount('error')).toBe(0)
    expect(source?.src).toBe('')
    expect(watch.loads[0]).toHaveBeenCalledTimes(1)
  })

  it('gives up after thirty seconds without a loaded thumbnail copy', async () => {
    vi.useFakeTimers()
    const fixture = await app((browser) => {
      browser.addVideo('slow.mp4')
      browser.autoLoadMedia = false
    })
    const watch = watchFilmstripSources(fixture)
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo
    video.readyState = 4
    video.dispatchEvent(fixture.event('loadeddata'))
    await fixture.settle()

    const source = watch.sources[0]
    expect(watch.sources).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    expect(source?.listenerCount('loadeddata')).toBe(1)
    expect(source?.listenerCount('error')).toBe(1)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fixture.element('notice').hidden).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.element('notice').hidden).toBe(false)
    expect(fixture.element('notice').textContent).toBe(
      'Timeline preview took too long to load.',
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(source?.listenerCount('loadeddata')).toBe(0)
    expect(source?.listenerCount('error')).toBe(0)
    expect(source?.src).toBe('')
    expect(watch.loads[0]).toHaveBeenCalledTimes(1)
  })
})

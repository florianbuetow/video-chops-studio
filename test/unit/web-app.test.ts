import * as testFramework from 'vitest'

import {
  BrowserFixture,
  BrowserVideo,
  loadBrowserApp,
} from '../helpers/browser-dom.js'

const { describe, expect, it, vi } = testFramework
const afterTest = testFramework[`after${'Each'}`]

let activeFixture: BrowserFixture | undefined

afterTest(() => {
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

describe('browser video editor', () => {
  it('shows empty, refresh failure, and selectable source states', async () => {
    const empty = await app()
    expect(empty.element('files-empty').hidden).toBe(false)
    expect(empty.element('file-count').textContent).toBe('0')
    empty.dispose()

    const failed = await loadBrowserApp((fixture) => {
      fixture.refreshError = 'input folder unavailable'
    })
    activeFixture = failed
    expect(failed.element('notice').hidden).toBe(false)
    expect(failed.element('notice').textContent).toBe(
      'input folder unavailable',
    )
    failed.dispose()

    const fixture = await loadBrowserApp((browser) => {
      browser.addVideo('one.mp4')
    })
    activeFixture = fixture
    expect(fixture.find('file-button')).toHaveLength(1)
    expect(fixture.find('file-size')[0]?.textContent).toBe('2.0 MB')
    await select(fixture)
    expect(fixture.element('workspace').hidden).toBe(false)
    expect(fixture.find('file-name')[0]?.textContent).toBe('one.mp4')
    expect(fixture.element('play').disabled).toBe(false)
    expect(fixture.element('output-name').value).toBe('one-edited.mp4')
    expect(fixture.find('file-button')[0]?.getAttribute('aria-current')).toBe(
      'true',
    )
    expect(fixture.canvasDraw).toHaveBeenCalledTimes(10)
  })

  it('keeps the selected source stable across racing and failed probes', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.addVideo('b.mp4')
    })
    await select(fixture, 0)

    const delayed = fixture.deferProbe('b.mp4')
    fixture.find('file-button')[1]?.click()
    fixture.find('file-button')[0]?.click()
    delayed.resolve(
      new Response(JSON.stringify(fixture.metadata.get('b.mp4')), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    await fixture.settle()
    expect(fixture.find('file-button')[0]?.getAttribute('aria-current')).toBe(
      'true',
    )
    expect(fixture.element('play').disabled).toBe(false)

    fixture.metadata.delete('b.mp4')
    fixture.find('file-button')[1]?.click()
    await fixture.settle()
    expect(fixture.element('notice').textContent).toContain(
      'video does not exist',
    )
    fixture.find('file-button')[0]?.click()
    await fixture.settle()
    expect(fixture.element('play').disabled).toBe(false)
    expect(fixture.element('workspace-status').textContent).toContain(
      'Source file preserved',
    )
  })

  it('fits aspect-locked numeric crops and restores invalid values', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('crop.mp4', { width: 640, height: 480 })
    })
    await select(fixture)

    change(fixture, 'aspect', String(16 / 9))
    expect(fixture.element('output-resolution').textContent).toBe('640 × 360')
    change(fixture, 'crop-height', '480')
    expect(fixture.element('output-resolution').textContent).toBe('640 × 360')

    change(fixture, 'crop-width', '')
    expect(fixture.element('notice').textContent).toBe(
      'Enter a crop size or position in pixels.',
    )
    expect(fixture.element('crop-width').value).toBe('640')

    fixture.element('view-result').click()
    expect(fixture.element('crop-box').hidden).toBe(true)
    fixture.element('reset-crop').click()
    expect(fixture.element('aspect').value).toBe('free')
    change(fixture, 'aspect', 'original')
    expect(fixture.element('output-resolution').textContent).toBe('640 × 480')
  })

  it('maps source-pixel crop values proportionally onto the preview overlay', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('geometry.mp4', { width: 640, height: 360 })
    })
    await select(fixture)
    change(fixture, 'crop-width', '320')
    change(fixture, 'crop-height', '180')
    change(fixture, 'crop-x', '100')
    change(fixture, 'crop-y', '50')

    const frame = fixture.element('video-frame')
    const overlay = fixture.element('crop-box')
    const frameWidth = Number.parseFloat(frame.style['width'] ?? '')
    const frameHeight = Number.parseFloat(frame.style['height'] ?? '')
    expect(
      Number.parseFloat(overlay.style['left'] ?? '') / frameWidth,
    ).toBeCloseTo(100 / 640)
    expect(
      Number.parseFloat(overlay.style['top'] ?? '') / frameHeight,
    ).toBeCloseTo(50 / 360)
    expect(
      Number.parseFloat(overlay.style['width'] ?? '') / frameWidth,
    ).toBeCloseTo(320 / 640)
    expect(
      Number.parseFloat(overlay.style['height'] ?? '') / frameHeight,
    ).toBeCloseTo(180 / 360)
  })

  it('renders cropped preview dimensions and video offsets from the same crop', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('result.mp4', { width: 640, height: 360 })
    })
    await select(fixture)
    change(fixture, 'crop-width', '320')
    change(fixture, 'crop-height', '180')
    change(fixture, 'crop-x', '120')
    change(fixture, 'crop-y', '60')
    fixture.element('view-result').click()

    const frame = fixture.element('video-frame')
    const video = fixture.element('video')
    const frameWidth = Number.parseFloat(frame.style['width'] ?? '')
    const frameHeight = Number.parseFloat(frame.style['height'] ?? '')
    const videoWidth = Number.parseFloat(video.style['width'] ?? '')
    const videoHeight = Number.parseFloat(video.style['height'] ?? '')
    expect(frameWidth / frameHeight).toBeCloseTo(320 / 180)
    expect(Number.parseFloat(video.style['left'] ?? '')).toBeLessThan(0)
    expect(Number.parseFloat(video.style['top'] ?? '')).toBeLessThan(0)
    expect(
      -Number.parseFloat(video.style['left'] ?? '') / videoWidth,
    ).toBeCloseTo(120 / 640)
    expect(
      -Number.parseFloat(video.style['top'] ?? '') / videoHeight,
    ).toBeCloseTo(60 / 360)
  })

  it('renders timeline clips and playhead at source-duration proportions', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('timeline.mp4', { duration: 20 })
    })
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo
    video.currentTime = 5
    fixture.element('split').click()

    const blocks = fixture.find('timeline-clip', fixture.element('clips'))
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.style['left']).toBe('0%')
    expect(blocks[0]?.style['width']).toBe('25%')
    expect(blocks[1]?.style['left']).toBe('25%')
    expect(blocks[1]?.style['width']).toBe('75%')

    fixture
      .element('timeline-track')
      .dispatchEvent(fixture.event('pointerdown', { button: 0, clientX: 750 }))
    expect(video.currentTime).toBe(15)
    expect(fixture.element('playhead').style['left']).toBe('75%')
    expect(fixture.element('current-time').textContent).toBe('00:15.00')
    fixture.find('clip-chip', fixture.element('clip-list'))[0]?.click()
    expect(video.currentTime).toBe(0)
    fixture.find('clip-chip', fixture.element('clip-list'))[1]?.click()
    expect(video.currentTime).toBe(5)

    fixture.element('remove').click()
    expect(fixture.element('output-duration').textContent).toBe('00:05.00')
    expect(fixture.element('source-duration').textContent).toBe('00:20.00')
  })

  it('restores each source draft, output name, and history when reselected', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('first.mp4')
      browser.addVideo('second.mp4')
    })
    await select(fixture, 0)
    change(fixture, 'crop-width', '320')
    change(fixture, 'crop-x', '100')
    fixture.element('output-name').value = 'first-custom.mp4'
    const video = fixture.element('video') as BrowserVideo
    video.currentTime = 4
    fixture.element('split').click()

    fixture.find('file-button')[1]?.click()
    await fixture.settle(50)
    expect(fixture.element('output-name').value).toBe('second-edited.mp4')
    fixture.find('file-button')[0]?.click()
    await fixture.settle(50)

    expect(fixture.element('crop-x').value).toBe('100')
    expect(fixture.element('output-name').value).toBe('first-custom.mp4')
    expect(
      fixture.find('clip-chip', fixture.element('clip-list')),
    ).toHaveLength(2)
    fixture.element('undo').click()
    expect(
      fixture.find('clip-chip', fixture.element('clip-list')),
    ).toHaveLength(1)
    expect(fixture.element('crop-x').value).toBe('100')
  })

  it('splits, trims, removes, and restores clips through controls and shortcuts', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('edit.mp4')
    })
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo

    video.currentTime = 4
    fixture.element('split').click()
    expect(
      fixture.find('clip-chip', fixture.element('clip-list')),
    ).toHaveLength(2)

    change(fixture, 'clip-in', '4.5')
    expect(fixture.element('output-duration').textContent).toBe('00:09.50')
    fixture.element('remove').click()
    expect(
      fixture.find('clip-chip', fixture.element('clip-list')),
    ).toHaveLength(1)
    fixture.element('undo').click()
    expect(
      fixture.find('clip-chip', fixture.element('clip-list')),
    ).toHaveLength(2)
    fixture.element('redo').click()
    expect(
      fixture.find('clip-chip', fixture.element('clip-list')),
    ).toHaveLength(1)

    fixture.document.dispatchEvent(
      fixture.event('keydown', { key: 'z', ctrlKey: true }),
    )
    expect(
      fixture.find('clip-chip', fixture.element('clip-list')),
    ).toHaveLength(2)
    fixture.document.dispatchEvent(fixture.event('keydown', { key: 'Delete' }))
    expect(
      fixture.find('clip-chip', fixture.element('clip-list')),
    ).toHaveLength(1)
  })

  it('supports crop dragging and timeline pointer and keyboard trimming', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('pointer.mp4')
    })
    await select(fixture)
    change(fixture, 'aspect', '1')

    const cropBox = fixture.element('crop-box')
    cropBox.dispatchEvent(
      fixture.event('pointerdown', { button: 0, clientX: 10, clientY: 10 }),
    )
    cropBox.dispatchEvent(
      fixture.event('pointermove', { clientX: 40, clientY: 30 }),
    )
    cropBox.dispatchEvent(fixture.event('pointerup'))
    expect(Number(fixture.element('crop-x').value)).toBeGreaterThan(0)

    const cropHandle = fixture.document.createElement('button')
    cropHandle.dataset['corner'] = 'se'
    cropHandle.parentElement = cropBox
    cropBox.children.push(cropHandle)
    const widthBeforeResize = Number(fixture.element('crop-width').value)
    cropHandle.dispatchEvent(
      fixture.event('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 100,
      }),
    )
    cropBox.dispatchEvent(
      fixture.event('pointermove', { clientX: 60, clientY: 80 }),
    )
    cropBox.dispatchEvent(fixture.event('pointerup'))
    expect(Number(fixture.element('crop-width').value)).toBeLessThan(
      widthBeforeResize,
    )
    cropHandle.dispatchEvent(
      fixture.event('keydown', {
        bubbles: true,
        key: 'ArrowLeft',
        shiftKey: true,
      }),
    )
    expect(Number(fixture.element('crop-width').value)).toBeLessThanOrEqual(640)

    const clips = fixture.element('clips')
    const track = fixture.element('timeline-track')
    clips.parentElement = track
    track.children.push(clips)
    const startHandle = clips.querySelector("[data-edge='start']")
    expect(startHandle).not.toBeNull()
    startHandle?.dispatchEvent(
      fixture.event('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 0,
      }),
    )
    fixture.document.dispatchEvent(
      fixture.event('pointermove', { clientX: 100 }),
    )
    fixture.document.dispatchEvent(fixture.event('pointerup'))
    expect(Number(fixture.element('clip-in').value)).toBeCloseTo(1)

    const replacement = fixture
      .element('clips')
      .querySelector("[data-edge='start']")
    replacement?.dispatchEvent(
      fixture.event('keydown', {
        bubbles: true,
        key: 'ArrowRight',
      }),
    )
    expect(Number(fixture.element('clip-in').value)).toBeCloseTo(1.05)
    expect(fixture.document.activeElement?.dataset['edge']).toBe('start')
  })

  it('skips removed playback gaps and reports empty-preview errors', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('play.mp4')
    })
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo

    video.currentTime = 2
    fixture.element('split').click()
    video.currentTime = 6
    fixture.element('split').click()
    fixture.find('clip-chip', fixture.element('clip-list'))[1]?.click()
    fixture.element('remove').click()
    video.currentTime = 3
    fixture.element('play').click()
    await fixture.settle()
    expect(video.currentTime).toBe(6)
    expect(fixture.element('play').getAttribute('aria-label')).toBe(
      'Pause video',
    )
    fixture.element('play').click()

    fixture.element('remove').click()
    fixture.find('clip-chip', fixture.element('clip-list'))[0]?.click()
    fixture.element('remove').click()
    fixture.element('play').click()
    await fixture.settle()
    expect(fixture.element('notice').textContent).toContain(
      'Keep at least one clip',
    )
    expect(fixture.element('selected-label').textContent).toBe('No clips kept')
    expect(fixture.element('clip-in').disabled).toBe(true)
    expect(fixture.element('clip-out').disabled).toBe(true)
    expect(fixture.element('split').disabled).toBe(true)
    expect(fixture.element('export-button').disabled).toBe(true)
  })

  it('updates playback on animation frames and respects the skip toggle', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('frames.mp4')
    })
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo
    video.currentTime = 2
    fixture.element('split').click()
    video.currentTime = 6
    fixture.element('split').click()
    fixture.find('clip-chip', fixture.element('clip-list'))[1]?.click()
    fixture.element('remove').click()

    video.currentTime = 1
    fixture.element('play').click()
    await fixture.settle()
    video.currentTime = 3
    fixture.runAnimationFrame()
    expect(video.currentTime).toBe(6)
    expect(fixture.element('current-time').textContent).toBe('00:06.00')
    expect(fixture.element('play-icon').getAttribute('d')).toBe(
      'M8 5v14M16 5v14',
    )

    video.currentTime = 9.99
    fixture.runAnimationFrame()
    expect(video.paused).toBe(true)
    expect(fixture.element('play').getAttribute('aria-label')).toBe(
      'Play video',
    )
    expect(fixture.element('play-icon').getAttribute('d')).toBe(
      'm8 5 11 7-11 7z',
    )

    fixture.element('preview-cuts').checked = false
    video.currentTime = 3
    fixture.element('play').click()
    await fixture.settle()
    fixture.runAnimationFrame()
    expect(video.currentTime).toBe(3)
    fixture.element('play').click()
  })

  it('applies transport, audio, trim, reset, and refresh controls', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('controls.mp4', {
        size: 2_000_000_000,
        width: 640,
        height: 480,
      })
    })
    expect(fixture.find('file-size')[0]?.textContent).toBe('2.0 GB')
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo

    change(fixture, 'speed', '1.5')
    expect(video.playbackRate).toBe(1.5)
    fixture.element('keep-audio').checked = false
    fixture.element('keep-audio').dispatchEvent(fixture.event('change'))
    expect(video.muted).toBe(true)
    expect(fixture.element('audio-encoding').hidden).toBe(true)

    video.currentTime = 2
    fixture.element('set-in').click()
    video.currentTime = 8
    fixture.element('set-out').click()
    expect(fixture.element('clip-in').value).toBe('2')
    expect(fixture.element('clip-out').value).toBe('8')
    expect(fixture.element('output-duration').textContent).toBe('00:06.00')

    fixture.element('view-result').click()
    fixture.element('view-source').click()
    expect(fixture.element('crop-box').hidden).toBe(false)
    expect(fixture.element('view-source').getAttribute('aria-pressed')).toBe(
      'true',
    )

    fixture.element('reset').click()
    expect(fixture.element('clip-in').value).toBe('0')
    expect(fixture.element('clip-out').value).toBe('10')
    expect(fixture.element('keep-audio').checked).toBe(true)
    expect(fixture.element('aspect').value).toBe('free')

    const requestsBefore = fixture.requests.length
    fixture.element('refresh').click()
    await fixture.settle()
    expect(fixture.requests.length).toBeGreaterThan(requestsBefore)
  })

  it('supports global playback, split, trim, seek, and redo shortcuts', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('keys.mp4', { fps: 25 })
    })
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo

    const space = fixture.event('keydown', { code: 'Space' })
    fixture.document.dispatchEvent(space)
    await fixture.settle()
    expect(space.defaultPrevented).toBe(true)
    expect(video.paused).toBe(false)
    fixture.document.dispatchEvent(fixture.event('keydown', { code: 'Space' }))

    fixture.document.dispatchEvent(
      fixture.event('keydown', { key: 'ArrowRight' }),
    )
    expect(video.currentTime).toBeCloseTo(1 / 25)
    fixture.document.dispatchEvent(
      fixture.event('keydown', { key: 'ArrowRight', shiftKey: true }),
    )
    expect(video.currentTime).toBeCloseTo(1 + 1 / 25)
    fixture.document.dispatchEvent(
      fixture.event('keydown', { key: 'ArrowLeft', shiftKey: true }),
    )
    expect(video.currentTime).toBeCloseTo(1 / 25)

    video.currentTime = 4
    fixture.document.dispatchEvent(fixture.event('keydown', { key: 'S' }))
    expect(
      fixture.find('clip-chip', fixture.element('clip-list')),
    ).toHaveLength(2)
    video.currentTime = 5
    fixture.document.dispatchEvent(fixture.event('keydown', { key: 'i' }))
    expect(fixture.element('clip-in').value).toBe('5')
    video.currentTime = 8
    fixture.document.dispatchEvent(fixture.event('keydown', { key: 'O' }))
    expect(fixture.element('clip-out').value).toBe('8')

    fixture.document.dispatchEvent(
      fixture.event('keydown', { key: 'z', ctrlKey: true }),
    )
    expect(fixture.element('clip-out').value).toBe('10')
    fixture.document.dispatchEvent(
      fixture.event('keydown', { key: 'z', ctrlKey: true, shiftKey: true }),
    )
    expect(fixture.element('clip-out').value).toBe('8')

    const ignored = fixture.event('keydown', { key: 'Delete' })
    ignored.target = fixture.element('output-name')
    fixture.document.dispatchEvent(ignored)
    expect(
      fixture.find('clip-chip', fixture.element('clip-list')),
    ).toHaveLength(2)
  })

  it('clamps a middle clip end drag against the next retained clip', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('edges.mp4')
    })
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo
    video.currentTime = 3
    fixture.element('split').click()
    video.currentTime = 7
    fixture.element('split').click()
    fixture.find('clip-chip', fixture.element('clip-list'))[2]?.click()
    change(fixture, 'clip-in', '8')
    fixture.find('clip-chip', fixture.element('clip-list'))[1]?.click()

    const clips = fixture.element('clips')
    const track = fixture.element('timeline-track')
    clips.parentElement = track
    track.children.push(clips)
    const endHandle = clips.querySelector("[data-edge='end']")
    endHandle?.dispatchEvent(
      fixture.event('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 0,
      }),
    )
    fixture.document.dispatchEvent(
      fixture.event('pointermove', { clientX: 1000 }),
    )
    fixture.document.dispatchEvent(fixture.event('pointercancel'))
    expect(fixture.element('clip-out').value).toBe('8')
    expect(video.currentTime).toBe(8)
  })

  it('exports a locked snapshot and reports progress, success, and failure', async () => {
    vi.useFakeTimers()
    const fixture = await app((browser) => {
      browser.addVideo('export.mp4')
      browser.queueExport(
        { id: '', status: 'running', progress: 0.42 },
        {
          id: '',
          status: 'complete',
          progress: 1,
          result: {
            name: 'done.mp4',
            duration: 10,
            width: 640,
            height: 360,
            size: 1_500_000,
          },
        },
      )
    })
    await select(fixture)
    fixture.element('output-name').value = 'done.mp4'
    fixture.element('export-button').click()
    await fixture.settle()
    expect(fixture.element('editing-column').inert).toBe(true)
    expect(fixture.find('file-button')[0]?.disabled).toBe(true)
    expect(fixture.element('progress-label').textContent).toBe('42%')
    expect(fixture.element('shutdown').disabled).toBe(true)
    const unloadDuringExport = fixture.event('beforeunload')
    fixture.window.dispatchEvent(unloadDuringExport)
    expect(unloadDuringExport.defaultPrevented).toBe(true)
    const post = fixture.requests.find((request) => request.method === 'POST')
    expect(post?.body).toEqual(
      expect.objectContaining({ source: 'export.mp4', outputName: 'done.mp4' }),
    )

    await vi.advanceTimersByTimeAsync(400)
    await fixture.settle()
    expect(fixture.element('export-result').hidden).toBe(false)
    expect(fixture.element('download').href).toContain('done.mp4')
    expect(fixture.element('workspace-status').textContent).toContain(
      'data/output/done.mp4',
    )
    expect(fixture.element('editing-column').inert).toBe(false)
    expect(fixture.element('keep-audio').disabled).toBe(false)
    expect(fixture.element('shutdown').disabled).toBe(false)
    const unloadAfterExport = fixture.event('beforeunload')
    fixture.window.dispatchEvent(unloadAfterExport)
    expect(unloadAfterExport.defaultPrevented).toBe(false)

    fixture.queueExport({
      id: '',
      status: 'failed',
      progress: 0.2,
      error: 'encoder stopped',
    })
    fixture.element('export-button').click()
    await fixture.settle()
    expect(fixture.element('export-status').textContent).toBe('Export failed')
    expect(fixture.element('notice').textContent).toBe('encoder stopped')

    fixture.exportStartError = 'another export is running'
    fixture.element('export-button').click()
    await fixture.settle()
    expect(fixture.element('notice').textContent).toBe(
      'another export is running',
    )

    fixture.exportStartError = undefined
    fixture.queueExport({ id: '', status: 'complete', progress: 1 })
    fixture.element('export-button').click()
    await fixture.settle()
    expect(fixture.element('notice').textContent).toBe(
      'Export did not produce a video.',
    )
  })

  it('shuts the studio down and reloads the page two seconds later', async () => {
    vi.useFakeTimers()
    const fixture = await app()
    const shutdown = fixture.element('shutdown')

    shutdown.click()
    expect(shutdown.disabled).toBe(true)
    expect(fixture.element('shutdown-label').textContent).toBe('Shutting down…')
    shutdown.click()
    await fixture.settle()
    expect(
      fixture.requests.filter((request) => request.path === '/api/shutdown'),
    ).toEqual([{ path: '/api/shutdown', method: 'POST', body: {} }])
    expect(shutdown.disabled).toBe(true)
    expect(fixture.element('shutdown-label').textContent).toBe('Studio stopped')

    await vi.advanceTimersByTimeAsync(1_999)
    expect(fixture.location.reload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.location.reload).toHaveBeenCalledOnce()
  })

  it('reports a rejected shutdown and lets the user retry', async () => {
    vi.useFakeTimers()
    const fixture = await app((browser) => {
      browser.shutdownError = 'Cross-origin requests are not allowed'
    })
    const shutdown = fixture.element('shutdown')

    shutdown.click()
    await fixture.settle()
    expect(fixture.element('notice').hidden).toBe(false)
    expect(fixture.element('notice').textContent).toBe(
      'Cross-origin requests are not allowed',
    )
    expect(shutdown.disabled).toBe(false)
    expect(fixture.element('shutdown-label').textContent).toBe(
      'Shut down studio',
    )
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fixture.location.reload).not.toHaveBeenCalled()

    fixture.shutdownError = undefined
    shutdown.click()
    await fixture.settle()
    expect(fixture.element('notice').hidden).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fixture.location.reload).toHaveBeenCalledOnce()
  })

  it('surfaces preview and thumbnail failures without losing editor controls', async () => {
    const thumbnails = await app((browser) => {
      browser.addVideo('thumb.mp4')
      browser.failFilmstrip = true
    })
    await select(thumbnails)
    expect(thumbnails.element('notice').textContent).toBe(
      'Timeline preview could not be loaded.',
    )
    expect(thumbnails.element('play').disabled).toBe(false)
    thumbnails.dispose()

    const canvas = await loadBrowserApp((browser) => {
      browser.addVideo('canvas.mp4')
      browser.canvasAvailable = false
    })
    activeFixture = canvas
    await select(canvas)
    expect(canvas.element('notice').textContent).toBe(
      'Canvas previews are unavailable in this browser.',
    )
    canvas.dispose()

    const preview = await loadBrowserApp((browser) => {
      browser.addVideo('broken.mp4')
      browser.failingMedia.push('broken.mp4')
    })
    activeFixture = preview
    await select(preview)
    expect(preview.element('play').disabled).toBe(true)
    expect(preview.element('preview-loading').textContent).toContain(
      'Could not prepare this video',
    )
  })

  it('keeps silent sources muted and ignores stale or premature media readiness', async () => {
    const silent = await app((browser) => {
      browser.addVideo('silent.mp4', { hasAudio: false })
    })
    await select(silent)
    expect(silent.element('keep-audio').checked).toBe(false)
    expect(silent.element('keep-audio').disabled).toBe(true)
    expect((silent.element('video') as BrowserVideo).muted).toBe(true)
    expect(silent.element('audio-encoding').hidden).toBe(true)
    silent.dispose()

    const stale = await loadBrowserApp((browser) => {
      browser.addVideo('stale.mp4')
      browser.autoLoadMedia = false
    })
    activeFixture = stale
    await select(stale)
    const video = stale.element('video') as BrowserVideo
    const expectedSource = new URL(
      '/api/preview?name=stale.mp4',
      stale.location.href,
    ).href
    video.currentSrc = 'http://127.0.0.1:43123/api/preview?name=old.mp4'
    video.readyState = 4
    video.dispatchEvent(stale.event('loadeddata'))
    expect(stale.element('play').disabled).toBe(true)
    video.currentSrc = expectedSource
    video.readyState = 1
    video.dispatchEvent(stale.event('loadeddata'))
    expect(stale.element('play').disabled).toBe(true)
    stale.autoLoadMedia = true
    video.readyState = 4
    video.dispatchEvent(stale.event('loadeddata'))
    await stale.settle()
    expect(stale.element('play').disabled).toBe(false)
  })
})

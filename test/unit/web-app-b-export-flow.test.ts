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
  activeFixture = await loadBrowserApp(configure)
  return activeFixture
}

async function select(fixture: BrowserFixture): Promise<void> {
  fixture.find('file-button')[0]?.click()
  await fixture.settle(50)
}

function change(fixture: BrowserFixture, id: string, value: string): void {
  const input = fixture.element(id)
  input.value = value
  input.dispatchEvent(fixture.event('change'))
}

function exportPosts(fixture: BrowserFixture): typeof fixture.requests {
  return fixture.requests.filter(
    ({ path, method }) => path === '/api/exports' && method === 'POST',
  )
}

function pressExport(fixture: BrowserFixture): void {
  fixture.element('export-button').dispatchEvent(fixture.event('click'))
}

const RESULT = {
  name: 'my cut.mp4',
  duration: 10,
  width: 640,
  height: 480,
  size: 1_500_000,
}

describe('browser export flow', () => {
  it('locks the editor synchronously and posts the exact edit snapshot', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('clip.mp4', { width: 640, height: 480 })
      browser.queueExport({
        id: '',
        status: 'complete',
        progress: 1,
        result: RESULT,
      })
    })
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo
    change(fixture, 'crop-width', '320')
    change(fixture, 'crop-height', '240')
    change(fixture, 'crop-x', '100')
    change(fixture, 'crop-y', '40')
    video.currentTime = 4
    fixture.element('split').click()
    fixture.element('keep-audio').checked = false
    fixture.element('keep-audio').dispatchEvent(fixture.event('change'))
    fixture.element('output-name').value = '  final cut.mp4  '
    change(fixture, 'crop-width', '')
    expect(fixture.element('notice').hidden).toBe(false)
    await video.play()
    expect(video.paused).toBe(false)
    expect(fixture.element('undo').disabled).toBe(false)

    pressExport(fixture)

    expect(fixture.element('notice').hidden).toBe(true)
    expect(video.paused).toBe(true)
    expect(fixture.element('play').getAttribute('aria-label')).toBe(
      'Play video',
    )
    expect(fixture.element('export-result').hidden).toBe(true)
    expect(fixture.element('export-progress').hidden).toBe(false)
    expect(fixture.element('export-status').textContent).toBe(
      'Exporting video…',
    )
    expect(fixture.element('progress-label').textContent).toBe('0%')
    expect(fixture.element('progress-bar').value).toBe(0)
    expect(fixture.element('export-button').disabled).toBe(true)
    expect(fixture.element('output-play').disabled).toBe(true)
    expect(fixture.element('undo').disabled).toBe(true)
    expect(fixture.element('redo').disabled).toBe(true)
    expect(fixture.element('layout-one-region').disabled).toBe(true)
    expect(fixture.element('layout-two-regions').disabled).toBe(true)
    expect(fixture.element('background-image').disabled).toBe(true)
    expect(fixture.element('output-name').disabled).toBe(true)
    expect(fixture.element('keep-audio').disabled).toBe(true)
    expect(fixture.element('reset').disabled).toBe(true)
    expect(fixture.element('shutdown').disabled).toBe(true)
    expect(fixture.element('crop-settings').inert).toBe(true)
    expect(fixture.element('composition-settings').inert).toBe(true)
    expect(fixture.element('composition-appearance').inert).toBe(true)
    expect(fixture.find('file-button')[0]?.disabled).toBe(true)

    await fixture.settle(50)

    const posts = exportPosts(fixture)
    expect(posts).toHaveLength(1)
    const body = posts[0]?.body
    expect(body).toEqual({
      source: 'clip.mp4',
      segments: [
        { start: 0, end: 4 },
        { start: 4, end: 10 },
      ],
      crop: { x: 100, y: 40, width: 320, height: 240 },
      outputName: 'final cut.mp4',
      muted: true,
      overwrite: false,
    })
    expect(Object.keys(body as object).sort()).toEqual([
      'crop',
      'muted',
      'outputName',
      'overwrite',
      'segments',
      'source',
    ])
    expect(fixture.confirmations).toEqual([])
    expect(fixture.requests.filter(({ method }) => method === 'HEAD')).toEqual([
      {
        path: '/api/output?name=final%20cut.mp4',
        method: 'HEAD',
        body: undefined,
      },
    ])
    expect(fixture.requests.at(-1)).toEqual({
      path: '/api/exports/job-1',
      method: 'GET',
      body: undefined,
    })
    expect(fixture.element('export-progress').hidden).toBe(true)
    expect(fixture.element('export-file').textContent).toBe(
      'my cut.mp4 · 1.5 MB',
    )
    expect(fixture.element('download').href).toBe(
      '/api/output?name=my%20cut.mp4',
    )
    expect(fixture.element('download').download).toBe('my cut.mp4')
    expect(fixture.element('export-result').hidden).toBe(false)
    expect(fixture.element('workspace-status').textContent).toBe(
      'Saved to data/output/my cut.mp4',
    )
    expect(fixture.element('export-button').disabled).toBe(false)
    expect(fixture.element('output-play').disabled).toBe(false)
    expect(fixture.element('undo').disabled).toBe(false)
    expect(fixture.element('layout-one-region').disabled).toBe(false)
    expect(fixture.element('layout-two-regions').disabled).toBe(false)
    expect(fixture.element('background-image').disabled).toBe(false)
    expect(fixture.element('output-name').disabled).toBe(false)
    expect(fixture.element('keep-audio').disabled).toBe(false)
    expect(fixture.element('reset').disabled).toBe(false)
    expect(fixture.element('shutdown').disabled).toBe(false)
    expect(fixture.element('editing-column').inert).toBe(false)
    expect(fixture.find('file-button')[0]?.disabled).toBe(false)
  })

  it('posts a two-region composition only in the stacked layout', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('portrait.mp4', { width: 1080, height: 1920 })
    })
    await select(fixture)
    fixture.element('layout-two-regions').click()
    pressExport(fixture)
    await fixture.settle(50)
    fixture.element('layout-one-region').click()
    pressExport(fixture)
    await fixture.settle(50)

    const [stacked, single] = exportPosts(fixture).map(
      ({ body }) => body as Record<string, unknown>,
    )
    expect(stacked).toHaveProperty('composition')
    expect(single).not.toHaveProperty('composition')
  })

  it('asks before replacing an existing output and posts the confirmation', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('clip.mp4')
      browser.outputs.add('clip-edited.mp4')
    })
    await select(fixture)

    pressExport(fixture)
    await fixture.settle(50)

    expect(fixture.confirmations).toEqual([
      'clip-edited.mp4 already exists. Overwrite it?',
    ])
    expect(
      exportPosts(fixture).map(
        ({ body }) => (body as Record<string, unknown>)['overwrite'],
      ),
    ).toEqual([true])
    expect(fixture.element('export-result').hidden).toBe(false)
  })

  it('cancels the export when replacing the existing output is declined', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('clip.mp4')
      browser.outputs.add('clip-edited.mp4')
      browser.confirmAnswer = false
    })
    await select(fixture)

    pressExport(fixture)
    await fixture.settle(50)

    expect(fixture.confirmations).toHaveLength(1)
    expect(exportPosts(fixture)).toHaveLength(0)
    expect(fixture.element('export-progress').hidden).toBe(true)
    expect(fixture.element('export-result').hidden).toBe(true)
    expect(fixture.element('notice').hidden).toBe(true)
    expect(fixture.element('export-button').disabled).toBe(false)
    expect(fixture.element('editing-column').inert).toBe(false)
  })

  it('reports progress while the job runs and polls every 400 ms', async () => {
    vi.useFakeTimers()
    const fixture = await app((browser) => {
      browser.addVideo('slow.mp4', { hasAudio: false })
      browser.queueExport(
        { id: '', status: 'running', progress: 0.25 },
        { id: '', status: 'running', progress: 0.5 },
        { id: '', status: 'complete', progress: 1, result: RESULT },
      )
    })
    await select(fixture)
    const jobReads = (): number =>
      fixture.requests.filter(({ path }) => path === '/api/exports/job-1')
        .length

    pressExport(fixture)
    await fixture.settle(50)
    expect(jobReads()).toBe(1)
    expect(fixture.element('progress-bar').value).toBe(0.25)
    expect(fixture.element('progress-label').textContent).toBe('25%')
    expect(fixture.element('export-progress').hidden).toBe(false)
    expect(fixture.element('export-result').hidden).toBe(true)
    expect(fixture.element('keep-audio').disabled).toBe(true)
    expect(fixture.element('export-button').disabled).toBe(true)
    expect(fixture.element('layout-two-regions').disabled).toBe(true)

    await vi.advanceTimersByTimeAsync(399)
    expect(jobReads()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await fixture.settle(50)
    expect(jobReads()).toBe(2)
    expect(fixture.element('progress-bar').value).toBe(0.5)
    expect(fixture.element('progress-label').textContent).toBe('50%')

    await vi.advanceTimersByTimeAsync(400)
    await fixture.settle(50)
    expect(jobReads()).toBe(3)
    expect(fixture.element('export-progress').hidden).toBe(true)
    expect(fixture.element('export-result').hidden).toBe(false)
    expect(fixture.element('export-button').disabled).toBe(false)
    expect(fixture.element('keep-audio').disabled).toBe(true)
  })

  it('does not let a failed job with a result look like a success', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('fail.mp4')
      browser.queueExport({
        id: '',
        status: 'failed',
        progress: 0.5,
        error: 'ffmpeg exploded',
        result: RESULT,
      })
      browser.queueExport({
        id: '',
        status: 'failed',
        progress: 0.5,
        result: RESULT,
      })
    })
    await select(fixture)

    pressExport(fixture)
    await fixture.settle(50)
    expect(fixture.element('notice').textContent).toBe('ffmpeg exploded')
    expect(fixture.element('notice').hidden).toBe(false)
    expect(fixture.element('export-status').textContent).toBe('Export failed')
    expect(fixture.element('export-result').hidden).toBe(true)
    expect(fixture.element('export-progress').hidden).toBe(false)
    expect(fixture.element('export-file').textContent).toBe('')
    expect(fixture.element('editing-column').inert).toBe(false)
    expect(fixture.element('export-button').disabled).toBe(false)

    pressExport(fixture)
    await fixture.settle(50)
    expect(fixture.element('notice').textContent).toBe(
      'Export did not produce a video.',
    )
    expect(fixture.element('export-result').hidden).toBe(true)
  })

  it('ignores export requests without a source, clips, or while already exporting', async () => {
    vi.useFakeTimers()
    const fixture = await app((browser) => {
      browser.addVideo('guard.mp4')
      browser.queueExport(
        { id: '', status: 'running', progress: 0.1 },
        { id: '', status: 'complete', progress: 1, result: RESULT },
      )
    })
    pressExport(fixture)
    await fixture.settle(50)
    expect(exportPosts(fixture)).toHaveLength(0)
    expect(fixture.element('export-progress').hidden).toBe(true)
    expect(fixture.element('editing-column').inert).toBe(false)

    await select(fixture)
    fixture.element('remove').click()
    expect(fixture.element('export-button').disabled).toBe(true)
    pressExport(fixture)
    await fixture.settle(50)
    expect(exportPosts(fixture)).toHaveLength(0)
    expect(fixture.element('export-progress').hidden).toBe(true)
    fixture.element('undo').click()

    pressExport(fixture)
    await fixture.settle(50)
    pressExport(fixture)
    await fixture.settle(50)
    expect(exportPosts(fixture)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(400)
    await fixture.settle(50)
    expect(fixture.element('export-result').hidden).toBe(false)
  })

  it('keeps the edit untouched by shortcuts and control changes while exporting', async () => {
    vi.useFakeTimers()
    const fixture = await app((browser) => {
      browser.addVideo('portrait.mp4', { width: 1080, height: 1920 })
      browser.queueExport(
        { id: '', status: 'running', progress: 0.1 },
        { id: '', status: 'complete', progress: 1, result: RESULT },
      )
    })
    await select(fixture)
    fixture.element('layout-two-regions').click()
    change(fixture, 'region-output-y', '300')
    const video = fixture.element('video') as BrowserVideo
    video.currentTime = 4
    fixture.element('split').click()
    const clips = (): number =>
      fixture.find('clip-chip', fixture.element('clip-list')).length
    expect(clips()).toBe(2)
    const regionTop = fixture.element('output-region-1').style['top']

    pressExport(fixture)
    await fixture.settle(50)
    const press = (options: Parameters<BrowserFixture['event']>[1]): void => {
      fixture.document.dispatchEvent(fixture.event('keydown', options))
    }
    press({ key: 'Delete' })
    press({ key: 'Backspace' })
    press({ key: 's' })
    press({ key: 'z', ctrlKey: true })
    press({ key: 'ArrowRight' })
    press({ code: 'Space' })
    expect(clips()).toBe(2)
    expect(video.currentTime).toBe(4)
    expect(video.paused).toBe(true)
    change(fixture, 'region-output-y', '500')
    fixture.element('stack-horizontal').dispatchEvent(fixture.event('click'))
    fixture.element('layout-one-region').dispatchEvent(fixture.event('click'))
    fixture
      .element('region-scale-slider')
      .dispatchEvent(fixture.event('pointerdown'))

    await vi.advanceTimersByTimeAsync(400)
    await fixture.settle(50)
    expect(fixture.element('output-region-1').style['top']).toBe(regionTop)
    expect(
      fixture.element('stack-horizontal').getAttribute('aria-pressed'),
    ).toBe('false')
    expect(
      fixture.element('layout-two-regions').getAttribute('aria-pressed'),
    ).toBe('true')
    fixture.element('undo').click()
    expect(clips()).toBe(1)
  })
})

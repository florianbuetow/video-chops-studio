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

function toggleAudio(fixture: BrowserFixture): void {
  const box = fixture.element('keep-audio')
  box.checked = !box.checked
  box.dispatchEvent(fixture.event('change'))
}

function child(parent: BrowserElement, index: number): BrowserElement {
  const found = parent.children[index]
  if (!(found instanceof BrowserElement)) {
    throw new Error(`missing element child ${index}`)
  }
  return found
}

function chips(fixture: BrowserFixture): BrowserElement[] {
  return fixture.find('clip-chip', fixture.element('clip-list'))
}

function chipLabels(fixture: BrowserFixture): string[] {
  return chips(fixture).map((chip) => chip.textContent)
}

function exportPosts(fixture: BrowserFixture): number {
  return fixture.requests.filter(
    ({ path, method }) => path === '/api/exports' && method === 'POST',
  ).length
}

function startBackgroundUpload(fixture: BrowserFixture): void {
  fixture.setFiles('background-image', [
    new File(['image'], 'backdrop.png', { type: 'image/png' }),
  ])
  fixture.element('background-image').dispatchEvent(fixture.event('change'))
}

function split(fixture: BrowserFixture, time: number): void {
  const video = fixture.element('video') as BrowserVideo
  video.currentTime = time
  fixture.element('split').click()
}

const runningThenComplete = [
  { id: '', status: 'running', progress: 0.5 },
  {
    id: '',
    status: 'complete',
    progress: 1,
    result: {
      name: 'out.mp4',
      duration: 10,
      width: 640,
      height: 360,
      size: 1_500_000,
    },
  },
] as const

describe('browser timeline rendering', () => {
  it('renders blocks, trim handles, chips, fields, and totals for the kept clips', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    expect(fixture.element('kept-summary').textContent).toBe(
      '1 clip · 00:10.00 kept',
    )
    split(fixture, 4)

    const blocks = fixture.element('clips').children
    expect(blocks).toHaveLength(2)
    const first = child(fixture.element('clips'), 0)
    const second = child(fixture.element('clips'), 1)
    expect(first.tagName).toBe('DIV')
    expect(first.className).toBe('timeline-clip')
    expect(first.dataset['index']).toBe('0')
    expect(first.textContent).toBe('01')
    expect(first.children).toHaveLength(1)
    expect(child(first, 0).tagName).toBe('SPAN')
    expect(child(first, 0).className).toBe('')
    expect(second.tagName).toBe('DIV')
    expect(second.className).toBe('timeline-clip selected')
    expect(second.dataset['index']).toBe('1')
    expect(second.textContent).toBe('02')
    expect(second.children).toHaveLength(3)
    expect(child(second, 0).textContent).toBe('02')
    expect(child(second, 0).className).toBe('')
    expect([first.style['left'], first.style['width']]).toEqual(['0%', '40%'])
    expect([second.style['left'], second.style['width']]).toEqual([
      '40%',
      '60%',
    ])
    for (const [position, edge] of [
      [1, 'start'],
      [2, 'end'],
    ] as const) {
      const handle = child(second, position)
      expect(handle.tagName).toBe('BUTTON')
      expect(handle.className).toBe(`trim-handle ${edge}`)
      expect(handle.dataset['edge']).toBe(edge)
      expect(handle.dataset['index']).toBe('1')
      expect(handle.getAttribute('aria-label')).toBe(`Trim clip 2 ${edge}`)
      expect(handle.title).toBe(
        'Drag to trim; use arrow keys for fine adjustments',
      )
      expect(handle.textContent).toBe('')
    }

    const list = fixture.element('clip-list')
    expect(list.children).toHaveLength(2)
    expect(chipLabels(fixture)).toEqual([
      '01  00:00.00 – 00:04.00',
      '02  00:04.00 – 00:10.00',
    ])
    expect(chips(fixture).map((chip) => chip.tagName)).toEqual([
      'BUTTON',
      'BUTTON',
    ])
    expect(
      chips(fixture).map((chip) => chip.getAttribute('aria-pressed')),
    ).toEqual(['false', 'true'])

    expect(fixture.element('selected-label').textContent).toBe('Clip 2')
    expect(fixture.element('clip-in').disabled).toBe(false)
    expect(fixture.element('clip-out').disabled).toBe(false)
    expect(fixture.element('clip-in').value).toBe('4')
    expect(fixture.element('clip-out').value).toBe('10')
    expect(fixture.element('clip-in').max).toBe('10')
    expect(fixture.element('clip-out').max).toBe('10')
    expect(fixture.element('remove').disabled).toBe(false)
    expect(fixture.element('set-in').disabled).toBe(false)
    expect(fixture.element('set-out').disabled).toBe(false)
    expect(fixture.element('split').disabled).toBe(false)
    expect(fixture.element('kept-summary').textContent).toBe(
      '2 clips · 00:10.00 kept',
    )
    expect(fixture.element('output-duration').textContent).toBe('00:10.00')
    expect(fixture.element('output-preview-duration').textContent).toBe(
      '00:10.00',
    )
    expect(fixture.element('output-play').disabled).toBe(false)
    expect(fixture.element('export-button').disabled).toBe(false)

    const ruler = fixture.element('timeline-ruler')
    expect(ruler.children).toHaveLength(5)
    for (let index = 0; index < 5; index += 1) {
      expect(child(ruler, index).tagName).toBe('SPAN')
      expect(child(ruler, index).className).toBe('')
    }
    expect(ruler.textContent).toBe('00:00.0000:02.5000:05.0000:07.5000:10.00')

    chips(fixture)[0]?.click()
    expect(fixture.element('selected-label').textContent).toBe('Clip 1')
    expect(
      chips(fixture).map((chip) => chip.getAttribute('aria-pressed')),
    ).toEqual(['true', 'false'])
    expect(child(fixture.element('clips'), 0).className).toBe(
      'timeline-clip selected',
    )
    expect(child(fixture.element('clips'), 1).className).toBe('timeline-clip')
    expect(
      child(child(fixture.element('clips'), 0), 1).getAttribute('aria-label'),
    ).toBe('Trim clip 1 start')
    expect(fixture.element('clip-in').value).toBe('0')
    expect(fixture.element('clip-out').value).toBe('4')
  })

  it('rounds the clip fields to milliseconds and totals the retained time', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    change(fixture, 'clip-in', '1.23456')
    change(fixture, 'clip-out', '9.87654')
    expect(fixture.element('clip-in').value).toBe('1.235')
    expect(fixture.element('clip-out').value).toBe('9.877')
    expect(fixture.element('kept-summary').textContent).toBe(
      '1 clip · 00:08.64 kept',
    )
    expect(fixture.element('output-duration').textContent).toBe('00:08.64')
  })

  it('refreshes the time displays when the timeline is rendered', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    split(fixture, 4)
    expect(fixture.element('current-time').textContent).toBe('00:04.00')
    expect(fixture.element('output-current-time').textContent).toBe('00:04.00')
    expect(fixture.element('playhead').style['left']).toBe('40%')
  })

  it('shows an empty timeline when every clip is removed and ignores further removals', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    split(fixture, 4)
    fixture.element('remove').click()
    expect(chipLabels(fixture)).toEqual(['01  00:00.00 – 00:04.00'])
    fixture.element('remove').click()

    expect(fixture.element('clips').children).toHaveLength(0)
    expect(fixture.element('clip-list').children).toHaveLength(0)
    expect(fixture.element('selected-label').textContent).toBe('No clips kept')
    expect(fixture.element('clip-in').disabled).toBe(true)
    expect(fixture.element('clip-out').disabled).toBe(true)
    expect(fixture.element('clip-in').value).toBe('')
    expect(fixture.element('clip-out').value).toBe('')
    expect(fixture.element('remove').disabled).toBe(true)
    expect(fixture.element('set-in').disabled).toBe(true)
    expect(fixture.element('set-out').disabled).toBe(true)
    expect(fixture.element('split').disabled).toBe(true)
    expect(fixture.element('output-play').disabled).toBe(true)
    expect(fixture.element('export-button').disabled).toBe(true)
    expect(fixture.element('kept-summary').textContent).toBe(
      '0 clips · 00:00.00 kept',
    )
    expect(fixture.element('output-duration').textContent).toBe('00:00.00')
    expect(fixture.element('output-preview-duration').textContent).toBe(
      '00:00.00',
    )

    press(fixture, { key: 'Delete' })
    fixture.element('remove').dispatchEvent(fixture.event('click'))
    expect(chipLabels(fixture)).toEqual([])

    fixture.element('undo').click()
    expect(chipLabels(fixture)).toEqual(['01  00:00.00 – 00:04.00'])
    fixture.element('undo').click()
    expect(chipLabels(fixture)).toEqual([
      '01  00:00.00 – 00:04.00',
      '02  00:04.00 – 00:10.00',
    ])
    fixture.element('undo').click()
    expect(chipLabels(fixture)).toEqual(['01  00:00.00 – 00:10.00'])
    expect(fixture.element('undo').disabled).toBe(true)
  })

  it('keeps a valid selection after removing the first, middle, or last clip', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    split(fixture, 3)
    split(fixture, 7)
    expect(chipLabels(fixture)).toHaveLength(3)

    chips(fixture)[2]?.click()
    fixture.element('remove').click()
    expect(fixture.element('selected-label').textContent).toBe('Clip 2')
    expect(
      chips(fixture).map((chip) => chip.getAttribute('aria-pressed')),
    ).toEqual(['false', 'true'])

    chips(fixture)[0]?.click()
    fixture.element('remove').click()
    expect(fixture.element('selected-label').textContent).toBe('Clip 1')
    expect(chipLabels(fixture)).toEqual(['01  00:03.00 – 00:07.00'])
    expect(fixture.element('clip-in').value).toBe('3')
  })

  it('pauses playback only when the last clip is removed', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo
    split(fixture, 4)
    video.currentTime = 1
    fixture.element('play').click()
    await fixture.settle()
    expect(video.paused).toBe(false)

    fixture.element('remove').click()
    expect(video.paused).toBe(false)
    fixture.element('remove').click()
    expect(video.paused).toBe(true)
  })

  it('undoes a removal to the exact clips that were removed', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    split(fixture, 4)
    fixture.element('remove').click()
    expect(chipLabels(fixture)).toEqual(['01  00:00.00 – 00:04.00'])

    fixture.element('undo').click()
    expect(chipLabels(fixture)).toEqual([
      '01  00:00.00 – 00:04.00',
      '02  00:04.00 – 00:10.00',
    ])
    fixture.element('undo').click()
    expect(chipLabels(fixture)).toEqual(['01  00:00.00 – 00:10.00'])
    expect(fixture.element('undo').disabled).toBe(true)
  })
})

describe('browser clip limits and guards', () => {
  it('stops offering splits at one hundred and twenty-eight clips', async () => {
    const fixture = await app((browser) =>
      browser.addVideo('long.mp4', { duration: 200 }),
    )
    await select(fixture)
    for (let time = 1; time <= 126; time += 1) split(fixture, time)
    expect(chipLabels(fixture)).toHaveLength(127)
    expect(fixture.element('split').disabled).toBe(false)

    const video = fixture.element('video') as BrowserVideo
    video.currentTime = 150.5
    press(fixture, { key: 's' })
    expect(chipLabels(fixture)).toHaveLength(128)
    expect(fixture.element('split').disabled).toBe(true)
    expect(fixture.element('kept-summary').textContent).toBe(
      '128 clips · 03:20.00 kept',
    )

    video.currentTime = 175.5
    press(fixture, { key: 's' })
    fixture.element('split').dispatchEvent(fixture.event('click'))
    expect(chipLabels(fixture)).toHaveLength(128)
    expect(fixture.element('notice').hidden).toBe(true)
  })

  it('ignores the split shortcut until the preview is ready', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.autoLoadMedia = false
    })
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo
    video.currentTime = 4
    press(fixture, { key: 's' })
    fixture.element('split').dispatchEvent(fixture.event('click'))

    expect(chipLabels(fixture)).toEqual(['01  00:00.00 – 00:10.00'])
    expect(fixture.element('notice').hidden).toBe(true)
    expect(fixture.element('undo').disabled).toBe(true)
  })

  it('keeps invalid trims out of history and clears the notice on the next valid edit', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    change(fixture, 'clip-in', '-1')
    expect(fixture.element('notice').hidden).toBe(false)
    expect(fixture.element('notice').textContent).toBe(
      'Keep this clip between 00:00.00 and 00:10.00, at least 0.05 seconds long.',
    )
    expect(fixture.element('undo').disabled).toBe(true)

    change(fixture, 'clip-in', '1')
    expect(fixture.element('notice').hidden).toBe(true)
    expect(fixture.element('undo').disabled).toBe(false)
    expect(fixture.element('clip-in').value).toBe('1')

    fixture.element('undo').click()
    expect(fixture.element('clip-in').value).toBe('0')
    expect(fixture.element('undo').disabled).toBe(true)
  })

  it('ignores clip edits before a source is open', async () => {
    const fixture = await app()
    change(fixture, 'clip-in', '1')
    change(fixture, 'clip-out', '2')
    expect(fixture.element('notice').hidden).toBe(true)
    expect(fixture.element('undo').disabled).toBe(true)
  })

  it('does not start an export without a source, a clip, or while busy', async () => {
    const fresh = await app()
    fresh.element('export-button').click()
    await fresh.settle()
    expect(exportPosts(fresh)).toBe(0)
    expect(fresh.element('editing-column').inert).toBe(false)
    expect(fresh.element('shutdown').disabled).toBe(false)
    fresh.dispose()

    vi.useFakeTimers()
    const fixture = await loadBrowserApp((browser) => {
      browser.addVideo('a.mp4')
      browser.queueExport(...runningThenComplete)
    })
    activeFixture = fixture
    await select(fixture)
    fixture.element('export-button').click()
    await fixture.settle()
    expect(exportPosts(fixture)).toBe(1)
    fixture.element('export-button').dispatchEvent(fixture.event('click'))
    await fixture.settle()
    expect(exportPosts(fixture)).toBe(1)
    await vi.advanceTimersByTimeAsync(400)
    await fixture.settle()
    expect(fixture.element('export-result').hidden).toBe(false)
    fixture.dispose()

    const empty = await loadBrowserApp((browser) => browser.addVideo('a.mp4'))
    activeFixture = empty
    await select(empty)
    empty.element('remove').click()
    empty.element('export-button').dispatchEvent(empty.event('click'))
    await empty.settle()
    expect(exportPosts(empty)).toBe(0)
    expect(empty.element('editing-column').inert).toBe(false)
    empty.dispose()

    const uploading = await loadBrowserApp((browser) =>
      browser.addVideo('a.mp4'),
    )
    activeFixture = uploading
    await select(uploading)
    uploading.element('layout-two-regions').click()
    startBackgroundUpload(uploading)
    expect(uploading.element('export-button').disabled).toBe(true)
    uploading.element('export-button').dispatchEvent(uploading.event('click'))
    await uploading.settle(50)
    expect(exportPosts(uploading)).toBe(0)
    expect(uploading.element('export-button').disabled).toBe(false)
  })
})

describe('browser editing controls state', () => {
  it('reflects audio availability and mute state in the audio controls', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    const video = fixture.element('video') as BrowserVideo
    expect(fixture.element('keep-audio').checked).toBe(true)
    expect(fixture.element('keep-audio').disabled).toBe(false)
    expect(fixture.element('audio-encoding').hidden).toBe(false)
    expect(video.muted).toBe(false)
    expect(fixture.element('reset').disabled).toBe(false)

    toggleAudio(fixture)
    expect(fixture.element('keep-audio').checked).toBe(false)
    expect(fixture.element('keep-audio').disabled).toBe(false)
    expect(fixture.element('audio-encoding').hidden).toBe(true)
    expect(video.muted).toBe(true)

    toggleAudio(fixture)
    expect(fixture.element('audio-encoding').hidden).toBe(false)
    expect(video.muted).toBe(false)
  })

  it('keeps reset, export, and playback controls locked while an export runs', async () => {
    vi.useFakeTimers()
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.queueExport(...runningThenComplete)
    })
    await select(fixture)
    fixture.element('export-button').click()
    await fixture.settle()

    toggleAudio(fixture)
    expect(fixture.element('reset').disabled).toBe(true)
    expect(fixture.element('export-button').disabled).toBe(true)
    expect(fixture.element('output-play').disabled).toBe(true)
    expect(fixture.element('keep-audio').disabled).toBe(true)

    await vi.advanceTimersByTimeAsync(400)
    await fixture.settle()
    expect(fixture.element('reset').disabled).toBe(false)
    expect(fixture.element('export-button').disabled).toBe(false)
    expect(fixture.element('output-play').disabled).toBe(false)
    expect(fixture.element('keep-audio').disabled).toBe(false)
  })

  it('keeps reset and export locked while a background image uploads', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    fixture.element('layout-two-regions').click()
    startBackgroundUpload(fixture)

    toggleAudio(fixture)
    expect(fixture.element('reset').disabled).toBe(true)
    expect(fixture.element('export-button').disabled).toBe(true)
    await fixture.settle(50)
    expect(fixture.element('reset').disabled).toBe(false)
    expect(fixture.element('export-button').disabled).toBe(false)
  })
})

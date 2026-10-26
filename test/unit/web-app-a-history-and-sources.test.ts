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

function toggleAudio(fixture: BrowserFixture): void {
  const box = fixture.element('keep-audio')
  box.checked = !box.checked
  box.dispatchEvent(fixture.event('change'))
}

function press(
  fixture: BrowserFixture,
  options: Parameters<BrowserFixture['event']>[1],
): void {
  fixture.document.dispatchEvent(fixture.event('keydown', options))
}

function child(parent: BrowserElement, index: number): BrowserElement {
  const found = parent.children[index]
  if (!(found instanceof BrowserElement)) {
    throw new Error(`missing element child ${index}`)
  }
  return found
}

function videoRequests(fixture: BrowserFixture, name: string): string[] {
  return fixture.requests
    .map(({ path }) => path)
    .filter((path) => path === `/api/video?name=${encodeURIComponent(name)}`)
}

function startBackgroundUpload(fixture: BrowserFixture): void {
  fixture.setFiles('background-image', [
    new File(['image'], 'backdrop.png', { type: 'image/png' }),
  ])
  fixture.element('background-image').dispatchEvent(fixture.event('change'))
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

describe('browser draft history', () => {
  it('keeps at most one hundred undo snapshots and reaches the oldest kept one', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    const audio = fixture.element('keep-audio')
    for (let index = 0; index < 101; index += 1) toggleAudio(fixture)
    expect(audio.checked).toBe(false)

    const undo = fixture.element('undo')
    let undone = 0
    while (!undo.disabled) {
      undo.click()
      undone += 1
    }

    expect(undone).toBe(100)
    expect(audio.checked).toBe(false)
    expect(fixture.element('redo').disabled).toBe(false)
  })

  it('starts empty and treats undo and redo as no-ops without history', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    const undo = fixture.element('undo')
    const redo = fixture.element('redo')
    expect(undo.disabled).toBe(true)
    expect(redo.disabled).toBe(true)

    expect(() => {
      press(fixture, { key: 'z', ctrlKey: true })
      press(fixture, { key: 'z', ctrlKey: true, shiftKey: true })
      undo.dispatchEvent(fixture.event('click'))
      redo.dispatchEvent(fixture.event('click'))
    }).not.toThrow()

    expect(undo.disabled).toBe(true)
    expect(redo.disabled).toBe(true)
    expect(fixture.element('clip-out').value).toBe('10')
    expect(fixture.element('keep-audio').checked).toBe(true)
  })

  it('enables undo as soon as a gesture starts and clears redo on the next edit', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    const undo = fixture.element('undo')
    const redo = fixture.element('redo')

    const cropBox = fixture.element('crop-box')
    cropBox.dispatchEvent(
      fixture.event('pointerdown', { button: 0, clientX: 10, clientY: 10 }),
    )
    expect(undo.disabled).toBe(false)
    expect(redo.disabled).toBe(true)
    cropBox.dispatchEvent(fixture.event('pointerup'))

    toggleAudio(fixture)
    undo.click()
    expect(redo.disabled).toBe(false)
    expect(fixture.element('keep-audio').checked).toBe(true)

    toggleAudio(fixture)
    expect(redo.disabled).toBe(true)
    redo.dispatchEvent(fixture.event('click'))
    expect(fixture.element('keep-audio').checked).toBe(false)
    expect(redo.disabled).toBe(true)
  })

  it('hides a finished export result when the draft changes or history is restored', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    const result = fixture.element('export-result')
    expect(result.hidden).toBe(true)

    toggleAudio(fixture)
    expect(result.hidden).toBe(true)
    fixture.element('export-button').click()
    await fixture.settle(50)
    expect(result.hidden).toBe(false)

    toggleAudio(fixture)
    expect(result.hidden).toBe(true)
    fixture.element('export-button').click()
    await fixture.settle(50)
    expect(result.hidden).toBe(false)

    fixture.element('undo').click()
    expect(result.hidden).toBe(true)
  })

  it('disables undo and redo while an export runs and enables them afterwards', async () => {
    vi.useFakeTimers()
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.queueExport(...runningThenComplete)
    })
    await select(fixture)
    toggleAudio(fixture)
    toggleAudio(fixture)
    fixture.element('undo').click()
    const undo = fixture.element('undo')
    const redo = fixture.element('redo')
    expect(undo.disabled).toBe(false)
    expect(redo.disabled).toBe(false)

    fixture.element('export-button').click()
    expect(undo.disabled).toBe(true)
    expect(redo.disabled).toBe(true)
    await fixture.settle()
    expect(undo.disabled).toBe(true)
    expect(redo.disabled).toBe(true)

    await vi.advanceTimersByTimeAsync(400)
    await fixture.settle()
    expect(undo.disabled).toBe(false)
    expect(redo.disabled).toBe(false)
  })

  it('disables undo and redo while a background upload runs', async () => {
    const fixture = await app((browser) => browser.addVideo('a.mp4'))
    await select(fixture)
    fixture.element('layout-two-regions').click()
    toggleAudio(fixture)
    fixture.element('undo').click()
    const undo = fixture.element('undo')
    const redo = fixture.element('redo')
    expect(undo.disabled).toBe(false)
    expect(redo.disabled).toBe(false)

    startBackgroundUpload(fixture)
    expect(undo.disabled).toBe(true)
    expect(redo.disabled).toBe(true)
    await fixture.settle(50)
    expect(undo.disabled).toBe(false)
    expect(redo.disabled).toBe(true)
  })

  it('does not render history controls before a source is open', async () => {
    const fixture = await app()
    expect(() => toggleAudio(fixture)).not.toThrow()
    expect(fixture.element('workspace').hidden).toBe(true)
  })
})

describe('browser source list', () => {
  it('renders one accessible entry per source with its size and selection state', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('one.mp4', { size: 2_000_000 })
      browser.addVideo('big.mkv', { size: 1_000_000_000 })
      browser.addVideo('almost.mp4', { size: 999_999_999 })
      browser.addVideo('huge.mov', { size: 1_500_000_000 })
    })
    const list = fixture.element('file-list')
    expect(list.children).toHaveLength(4)
    expect(fixture.element('file-count').textContent).toBe('4')
    expect(fixture.element('files-empty').hidden).toBe(true)
    expect(fixture.element('files-loading').hidden).toBe(true)

    const expected = [
      ['one.mp4', '2.0 MB'],
      ['big.mkv', '1.0 GB'],
      ['almost.mp4', '1000.0 MB'],
      ['huge.mov', '1.5 GB'],
    ] as const
    expected.forEach(([name, size], index) => {
      const item = child(list, index)
      expect(item.tagName).toBe('LI')
      expect(item.className).toBe('')
      expect(item.textContent).toBe(`▶${name}${size}`)
      expect(item.children).toHaveLength(1)
      const button = child(item, 0)
      expect(button.tagName).toBe('BUTTON')
      expect(button.className).toBe('file-button')
      expect(button.title).toBe(name)
      expect(button.disabled).toBe(false)
      expect(button.getAttribute('aria-current')).toBe('false')
      expect(button.textContent).toBe(`▶${name}${size}`)
      expect(button.children).toHaveLength(2)
      const icon = child(button, 0)
      expect(icon.tagName).toBe('SPAN')
      expect(icon.className).toBe('file-icon')
      expect(icon.textContent).toBe('▶')
      expect(icon.getAttribute('aria-hidden')).toBe('true')
      const info = child(button, 1)
      expect(info.tagName).toBe('SPAN')
      expect(info.className).toBe('file-info')
      expect(info.textContent).toBe(`${name}${size}`)
      expect(info.children).toHaveLength(2)
      const label = child(info, 0)
      expect(label.tagName).toBe('SPAN')
      expect(label.className).toBe('file-name')
      expect(label.textContent).toBe(name)
      const bytes = child(info, 1)
      expect(bytes.tagName).toBe('SPAN')
      expect(bytes.className).toBe('file-size')
      expect(bytes.textContent).toBe(size)
    })

    await select(fixture, 1)
    expect(
      fixture
        .find('file-button')
        .map((button) => button.getAttribute('aria-current')),
    ).toEqual(['false', 'true', 'false', 'false'])
  })

  it('locks the refresh button while listing and clears the previous notice', async () => {
    const fixture = await app((browser) => {
      browser.refreshError = 'input folder unavailable'
    })
    const refresh = fixture.element('refresh')
    expect(fixture.element('notice').textContent).toBe(
      'input folder unavailable',
    )
    expect(fixture.element('files-loading').hidden).toBe(true)
    expect(refresh.disabled).toBe(false)

    fixture.refreshError = undefined
    fixture.addVideo('late.mp4')
    refresh.click()
    expect(refresh.disabled).toBe(true)
    expect(fixture.element('notice').hidden).toBe(true)
    await fixture.settle()
    expect(refresh.disabled).toBe(false)
    expect(fixture.element('file-count').textContent).toBe('1')
    expect(fixture.element('files-empty').hidden).toBe(true)
    expect(fixture.find('file-name')[0]?.textContent).toBe('late.mp4')
  })
})

describe('browser source selection', () => {
  it('shows a preparing state until the browser preview is ready', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('my clip.final.mp4', { duration: 12.5 })
      browser.autoLoadMedia = false
    })
    const video = fixture.element('video') as BrowserVideo
    expect(fixture.element('empty-workspace').hidden).toBe(false)
    await select(fixture)

    expect(videoRequests(fixture, 'my clip.final.mp4')).toHaveLength(1)
    expect(video.src).toBe(
      'http://127.0.0.1:43123/api/preview?name=my%20clip.final.mp4',
    )
    expect(fixture.element('output-name').value).toBe(
      'my clip.final-edited.mp4',
    )
    expect(fixture.element('empty-workspace').hidden).toBe(true)
    expect(fixture.element('workspace').hidden).toBe(false)
    expect(fixture.element('export-result').hidden).toBe(true)
    expect(fixture.element('scrubber').max).toBe('12.5')
    expect(fixture.element('scrubber').value).toBe('0')
    expect(fixture.element('workspace-status').textContent).toBe(
      'Preparing preview…',
    )

    const loading = fixture.element('preview-loading')
    expect(loading.hidden).toBe(false)
    expect(loading.textContent).toBe(
      'Preparing a browser preview…Large videos may take a moment.',
    )
    expect(loading.children).toHaveLength(2)
    const hint = child(loading, 1)
    expect(hint.tagName).toBe('SMALL')
    expect(hint.className).toBe('')
    expect(hint.textContent).toBe('Large videos may take a moment.')

    expect(fixture.element('play').disabled).toBe(true)
    expect(fixture.element('output-play').disabled).toBe(true)
    expect(fixture.element('set-in').disabled).toBe(true)
    expect(fixture.element('set-out').disabled).toBe(true)
    expect(fixture.element('split').disabled).toBe(true)
    expect(fixture.element('undo').disabled).toBe(true)
    expect(fixture.element('redo').disabled).toBe(true)
    expect(fixture.element('clip-in').value).toBe('0')
    expect(fixture.element('clip-out').value).toBe('12.5')
    expect(fixture.element('source-duration').textContent).toBe('00:12.50')
    expect(
      fixture.element('layout-one-region').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      fixture.element('layout-two-regions').getAttribute('aria-pressed'),
    ).toBe('false')
    expect(fixture.canvasClear).toHaveBeenCalledTimes(1)
    expect(fixture.canvasClear).toHaveBeenCalledWith(0, 0, 300, 150)
  })

  it('derives the default output name from the last extension only', async () => {
    const names = ['plain.mp4', 'my.clip.final.mov', 'no-extension']
    const fixture = await app((browser) => {
      for (const name of names) browser.addVideo(name)
    })
    const outputs: string[] = []
    for (let index = 0; index < names.length; index += 1) {
      await select(fixture, index)
      outputs.push(fixture.element('output-name').value)
    }
    expect(outputs).toEqual([
      'plain-edited.mp4',
      'my.clip.final-edited.mp4',
      'no-extension-edited.mp4',
    ])
  })

  it('pauses playback, announces the opening file, and re-renders after a failed probe', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.addVideo('b.mp4')
    })
    await select(fixture, 0)
    const video = fixture.element('video') as BrowserVideo
    fixture.element('play').click()
    await fixture.settle()
    expect(video.paused).toBe(false)

    const pending = fixture.deferProbe('b.mp4')
    fixture.find('file-button')[1]?.click()
    expect(video.paused).toBe(true)
    expect(fixture.element('workspace-status').textContent).toBe(
      'Opening b.mp4…',
    )

    pending.resolve(
      new Response(JSON.stringify({ error: 'video does not exist: b.mp4' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await fixture.settle()
    expect(fixture.element('notice').hidden).toBe(false)
    expect(fixture.element('notice').textContent).toBe(
      'video does not exist: b.mp4',
    )
    expect(fixture.element('workspace-status').textContent).toBe(
      'All changes are local · Source file preserved',
    )
    expect(fixture.find('file-button')[0]?.getAttribute('aria-current')).toBe(
      'true',
    )
  })

  it('reopens the current source without reloading and ignores a stale failed probe', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.addVideo('b.mp4')
    })
    await select(fixture, 0)
    const status = fixture.element('workspace-status')
    const pending = fixture.deferProbe('b.mp4')
    fixture.find('file-button')[1]?.click()

    fixture.element('keep-audio').checked = false
    fixture.find('file-button')[0]?.click()
    await fixture.settle()
    expect(videoRequests(fixture, 'a.mp4')).toHaveLength(1)
    expect(fixture.element('keep-audio').checked).toBe(true)
    expect(status.textContent).toBe(
      'All changes are local · Source file preserved',
    )

    pending.resolve(
      new Response(JSON.stringify({ error: 'late failure' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await fixture.settle()
    expect(fixture.element('notice').hidden).toBe(true)
    expect(status.textContent).toBe(
      'All changes are local · Source file preserved',
    )
    expect(fixture.find('file-button')[0]?.getAttribute('aria-current')).toBe(
      'true',
    )
  })

  it('clears an earlier notice when another source is opened', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.addVideo('b.mp4')
      browser.addVideo('c.mp4')
    })
    await select(fixture, 0)
    fixture.metadata.delete('b.mp4')
    await select(fixture, 1)
    expect(fixture.element('notice').hidden).toBe(false)

    await select(fixture, 2)
    expect(fixture.element('notice').hidden).toBe(true)

    await select(fixture, 1)
    expect(fixture.element('notice').hidden).toBe(false)
    await select(fixture, 2)
    expect(fixture.element('notice').hidden).toBe(true)
  })

  it('restores the draft, output name, undo and redo of a source when it is reopened', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.addVideo('b.mp4')
    })
    await select(fixture, 0)
    toggleAudio(fixture)
    toggleAudio(fixture)
    fixture.element('undo').click()
    fixture.element('output-name').value = 'custom.mp4'
    expect(fixture.element('keep-audio').checked).toBe(false)

    await select(fixture, 1)
    expect(fixture.element('output-name').value).toBe('b-edited.mp4')
    expect(fixture.element('keep-audio').checked).toBe(true)
    expect(fixture.element('undo').disabled).toBe(true)
    expect(fixture.element('redo').disabled).toBe(true)

    await select(fixture, 0)
    expect(fixture.element('output-name').value).toBe('custom.mp4')
    expect(fixture.element('keep-audio').checked).toBe(false)
    expect(fixture.element('undo').disabled).toBe(false)
    expect(fixture.element('redo').disabled).toBe(false)

    fixture.element('redo').click()
    expect(fixture.element('keep-audio').checked).toBe(true)
    fixture.element('undo').click()
    fixture.element('undo').click()
    expect(fixture.element('keep-audio').checked).toBe(true)
    expect(fixture.element('undo').disabled).toBe(true)
  })

  it('starts a new source in the one-region layout and hides a previous export result', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.addVideo('b.mp4')
    })
    await select(fixture, 0)
    fixture.element('layout-two-regions').click()
    fixture.element('export-button').click()
    await fixture.settle(50)
    expect(fixture.element('export-result').hidden).toBe(false)
    expect(fixture.element('output-panel').hidden).toBe(false)

    await select(fixture, 1)
    expect(fixture.element('export-result').hidden).toBe(true)
    expect(fixture.element('output-panel').hidden).toBe(true)
    expect(
      fixture.element('layout-one-region').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      fixture.element('layout-two-regions').getAttribute('aria-pressed'),
    ).toBe('false')
    expect(fixture.element('crop-height').value).toBe('360')
  })

  it('ignores source clicks while an export is running', async () => {
    vi.useFakeTimers()
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.addVideo('b.mp4')
      browser.queueExport(...runningThenComplete)
    })
    await select(fixture, 0)
    fixture.element('export-button').click()
    await fixture.settle()

    const other = fixture.find('file-button')[1]
    expect(other?.disabled).toBe(true)
    other?.dispatchEvent(fixture.event('click'))
    await fixture.settle(50)
    expect(videoRequests(fixture, 'b.mp4')).toEqual([])
    expect(fixture.find('file-button')[0]?.getAttribute('aria-current')).toBe(
      'true',
    )
    expect(fixture.find('file-button')[1]?.getAttribute('aria-current')).toBe(
      'false',
    )

    await vi.advanceTimersByTimeAsync(400)
    await fixture.settle()
    expect(fixture.element('export-result').hidden).toBe(false)
  })

  it('ignores source clicks while a background image uploads', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.addVideo('b.mp4')
    })
    await select(fixture, 0)
    fixture.element('layout-two-regions').click()
    startBackgroundUpload(fixture)

    const other = fixture.find('file-button')[1]
    expect(other?.disabled).toBe(true)
    other?.dispatchEvent(fixture.event('click'))
    await fixture.settle(50)
    expect(videoRequests(fixture, 'b.mp4')).toEqual([])
    expect(fixture.find('file-button')[0]?.getAttribute('aria-current')).toBe(
      'true',
    )
    expect(fixture.find('file-button')[1]?.getAttribute('aria-current')).toBe(
      'false',
    )
    expect(fixture.find('file-button')[1]?.disabled).toBe(false)
  })

  it('ignores probes that finish after newer selections and an export', async () => {
    const fixture = await app((browser) => {
      browser.addVideo('a.mp4')
      browser.addVideo('b.mp4')
      browser.addVideo('c.mp4')
    })
    await select(fixture, 0)
    const pendingB = fixture.deferProbe('b.mp4')
    fixture.find('file-button')[1]?.click()
    const pendingC = fixture.deferProbe('c.mp4')
    fixture.find('file-button')[2]?.click()
    fixture.element('export-button').click()
    await fixture.settle(50)
    expect(fixture.element('export-result').hidden).toBe(false)

    for (const [pending, name] of [
      [pendingB, 'b.mp4'],
      [pendingC, 'c.mp4'],
    ] as const) {
      pending.resolve(
        new Response(JSON.stringify(fixture.metadata.get(name)), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      await fixture.settle()
    }

    expect(fixture.element('output-name').value).toBe('a-edited.mp4')
    expect(
      fixture
        .find('file-button')
        .map((button) => button.getAttribute('aria-current')),
    ).toEqual(['true', 'false', 'false'])
    expect(fixture.element('export-result').hidden).toBe(false)
  })
})

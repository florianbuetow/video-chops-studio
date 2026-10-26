import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BrowserElement,
  BrowserEvent,
  BrowserFixture,
  BrowserVideo,
  loadBrowserApp,
} from '../helpers/browser-dom.js'

let activeFixture: BrowserFixture | undefined

afterEach(() => {
  activeFixture?.dispose()
  activeFixture = undefined
})

async function app(selectSource = true): Promise<BrowserFixture> {
  activeFixture = await loadBrowserApp((fixture) => {
    fixture.addVideo('edit.mp4', { duration: 10, fps: 25 })
  })
  if (selectSource) {
    activeFixture.find('file-button')[0]?.click()
    await activeFixture.settle(50)
  }
  return activeFixture
}

function player(fixture: BrowserFixture): BrowserVideo {
  return fixture.element('video') as BrowserVideo
}

function chips(fixture: BrowserFixture): BrowserElement[] {
  return fixture.find('clip-chip', fixture.element('clip-list'))
}

function blocks(fixture: BrowserFixture): BrowserElement[] {
  return fixture.find('timeline-clip', fixture.element('clips'))
}

function change(fixture: BrowserFixture, id: string, value: string): void {
  const input = fixture.element(id)
  input.value = value
  input.dispatchEvent(fixture.event('change'))
}

function mountClips(fixture: BrowserFixture): void {
  const clips = fixture.element('clips')
  const track = fixture.element('timeline-track')
  clips.parentElement = track
  track.children.push(clips)
}

function handle(
  fixture: BrowserFixture,
  edge: 'start' | 'end',
): BrowserElement {
  const found = fixture
    .element('clips')
    .querySelector<BrowserElement>(`[data-edge='${edge}']`)
  if (found === null) throw new Error(`No ${edge} trim handle is rendered`)
  return found
}

function fakeHandle(
  fixture: BrowserFixture,
  edge: 'start' | 'end',
): BrowserElement {
  const fake = fixture.document.createElement('button')
  fake.dataset['edge'] = edge
  return fake
}

function threeClips(fixture: BrowserFixture): void {
  const video = player(fixture)
  video.currentTime = 3
  fixture.element('split').click()
  video.currentTime = 7
  fixture.element('split').click()
  chips(fixture)[1]?.click()
  mountClips(fixture)
}

function pointer(
  fixture: BrowserFixture,
  type: string,
  clientX: number,
  button = 0,
): BrowserEvent {
  return fixture.event(type, { button, clientX, bubbles: true })
}

function key(
  fixture: BrowserFixture,
  options: Parameters<BrowserFixture['event']>[1],
  target?: BrowserElement,
): BrowserEvent {
  const event = fixture.event('keydown', { bubbles: true, ...options })
  if (target !== undefined) event.target = target
  fixture.document.dispatchEvent(event)
  return event
}

describe('browser timeline pointer interaction', () => {
  it.each([
    {
      label: 'moves the start handle right from a non-zero pointer origin',
      clip: 1,
      edge: 'start' as const,
      from: 200,
      to: 300,
      clipIn: '4',
      clipOut: '7',
      playhead: 4,
    },
    {
      label: 'stops the start handle at the end of the previous clip',
      clip: 1,
      edge: 'start' as const,
      from: 500,
      to: -5000,
      clipIn: '3',
      clipOut: '7',
      playhead: 3,
    },
    {
      label: 'keeps a minimum length when the start handle passes the end',
      clip: 1,
      edge: 'start' as const,
      from: 500,
      to: 5000,
      clipIn: '6.949',
      clipOut: '7',
      playhead: 6.949,
    },
    {
      label: 'stops the first clip start handle at zero',
      clip: 0,
      edge: 'start' as const,
      from: 500,
      to: -5000,
      clipIn: '0',
      clipOut: '3',
      playhead: 0,
    },
    {
      label: 'moves the end handle left from a non-zero pointer origin',
      clip: 1,
      edge: 'end' as const,
      from: 700,
      to: 600,
      clipIn: '3',
      clipOut: '6',
      playhead: 6,
    },
    {
      label: 'stops the end handle at the start of the next clip',
      clip: 1,
      edge: 'end' as const,
      from: 500,
      to: 5000,
      clipIn: '3',
      clipOut: '7',
      playhead: 7,
    },
    {
      label: 'keeps a minimum length when the end handle passes the start',
      clip: 1,
      edge: 'end' as const,
      from: 500,
      to: -5000,
      clipIn: '3',
      clipOut: '3.051',
      playhead: 3.051,
    },
    {
      label: 'stops the last clip end handle at the source duration',
      clip: 2,
      edge: 'end' as const,
      from: 500,
      to: 5000,
      clipIn: '7',
      clipOut: '10',
      playhead: 10,
    },
  ])('$label', async (scenario) => {
    const fixture = await app()
    threeClips(fixture)
    chips(fixture)[scenario.clip]?.click()
    const video = player(fixture)
    const grip = handle(fixture, scenario.edge)

    const down = pointer(fixture, 'pointerdown', scenario.from)
    grip.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    fixture.document.dispatchEvent(pointer(fixture, 'pointermove', scenario.to))

    expect(fixture.element('clip-in').value).toBe(scenario.clipIn)
    expect(fixture.element('clip-out').value).toBe(scenario.clipOut)
    expect(video.currentTime).toBeCloseTo(scenario.playhead, 9)
    expect(fixture.element('selected-label').textContent).toBe(
      `Clip ${scenario.clip + 1}`,
    )
    expect(chips(fixture)).toHaveLength(3)

    fixture.document.dispatchEvent(pointer(fixture, 'pointerup', scenario.to))
    fixture.element('undo').click()
    expect(chips(fixture)).toHaveLength(3)
    expect(fixture.element('kept-summary').textContent).toBe(
      '3 clips · 00:10.00 kept',
    )
    fixture.element('undo').click()
    expect(chips(fixture)).toHaveLength(2)
  })

  it.each(['pointerup', 'pointercancel'])(
    'stops trimming on %s and detaches exactly its listeners',
    async (ending) => {
      const fixture = await app()
      threeClips(fixture)
      const added = vi.spyOn(fixture.document, 'addEventListener')
      const removed = vi.spyOn(fixture.document, 'removeEventListener')

      handle(fixture, 'start').dispatchEvent(
        pointer(fixture, 'pointerdown', 500),
      )
      expect(added.mock.calls.map(([type]) => type)).toEqual([
        'pointermove',
        'pointerup',
        'pointercancel',
      ])
      expect(removed).not.toHaveBeenCalled()
      fixture.document.dispatchEvent(pointer(fixture, 'pointermove', 600))
      expect(fixture.element('clip-in').value).toBe('4')

      fixture.document.dispatchEvent(pointer(fixture, ending, 600))
      expect(removed.mock.calls.map(([type]) => type)).toEqual([
        'pointermove',
        'pointerup',
        'pointercancel',
      ])
      expect(removed.mock.calls.map(([, listener]) => listener)).toEqual(
        added.mock.calls.map(([, listener]) => listener),
      )
      fixture.document.dispatchEvent(pointer(fixture, 'pointermove', 800))
      expect(fixture.element('clip-in').value).toBe('4')
    },
  )

  it('seeks from the pointer position relative to the track', async () => {
    const fixture = await app()
    const track = fixture.element('timeline-track')
    const video = player(fixture)
    track.boundsLeft = 100

    const down = pointer(fixture, 'pointerdown', 600)
    track.dispatchEvent(down)

    expect(video.currentTime).toBe(5)
    expect(fixture.element('current-time').textContent).toBe('00:05.00')
    expect(down.defaultPrevented).toBe(false)
  })

  it('selects the clicked clip, seeks inside it, and refreshes the timeline', async () => {
    const fixture = await app()
    threeClips(fixture)
    chips(fixture)[0]?.click()
    expect(fixture.element('selected-label').textContent).toBe('Clip 1')
    const down = pointer(fixture, 'pointerdown', 250)
    down.target = blocks(fixture)[1] ?? null

    fixture.element('timeline-track').dispatchEvent(down)

    expect(fixture.element('selected-label').textContent).toBe('Clip 2')
    expect(player(fixture).currentTime).toBe(2.5)
    expect(fixture.find('trim-handle', fixture.element('clips'))).toHaveLength(
      2,
    )
    expect(chips(fixture)[1]?.getAttribute('aria-pressed')).toBe('true')
    expect(fixture.element('undo').disabled).toBe(false)
  })

  it('ignores presses without a source, with another button, or on non-elements', async () => {
    const before = await app(false)
    const track = before.element('timeline-track')
    expect(() =>
      track.dispatchEvent(pointer(before, 'pointerdown', 500)),
    ).not.toThrow()
    before.dispose()

    const fixture = await app()
    threeClips(fixture)
    const video = player(fixture)
    video.currentTime = 1
    const selected = fixture.element('selected-label').textContent
    const secondary = pointer(fixture, 'pointerdown', 500, 2)
    secondary.target = blocks(fixture)[0] ?? null
    fixture.element('timeline-track').dispatchEvent(secondary)
    const textual = pointer(fixture, 'pointerdown', 500)
    textual.target = fixture.document.createTextNode('caption')
    expect(() =>
      fixture.element('timeline-track').dispatchEvent(textual),
    ).not.toThrow()

    expect(video.currentTime).toBe(1)
    expect(fixture.element('selected-label').textContent).toBe(selected)
  })

  it('ignores a trim handle press when no clip is kept', async () => {
    const fixture = await app()
    fixture.element('remove').click()
    const added = vi.spyOn(fixture.document, 'addEventListener')
    const down = pointer(fixture, 'pointerdown', 500)
    down.target = fakeHandle(fixture, 'start')

    fixture.element('timeline-track').dispatchEvent(down)

    expect(down.defaultPrevented).toBe(true)
    expect(added).not.toHaveBeenCalled()
    fixture.element('undo').click()
    expect(fixture.element('kept-summary').textContent).toBe(
      '1 clip · 00:10.00 kept',
    )
  })
})

describe('browser timeline handle keyboard', () => {
  it.each([
    { edge: 'start' as const, name: 'ArrowRight', shift: false, at: 2.05 },
    { edge: 'start' as const, name: 'ArrowLeft', shift: false, at: 1.95 },
    { edge: 'start' as const, name: 'ArrowRight', shift: true, at: 3 },
    { edge: 'start' as const, name: 'ArrowLeft', shift: true, at: 1 },
    { edge: 'end' as const, name: 'ArrowRight', shift: false, at: 8.05 },
    { edge: 'end' as const, name: 'ArrowLeft', shift: false, at: 7.95 },
    { edge: 'end' as const, name: 'ArrowRight', shift: true, at: 9 },
    { edge: 'end' as const, name: 'ArrowLeft', shift: true, at: 7 },
  ])(
    'moves the $edge edge with $name (shift $shift) to $at',
    async ({ edge, name, shift, at }) => {
      const fixture = await app()
      change(fixture, 'clip-in', '2')
      change(fixture, 'clip-out', '8')
      mountClips(fixture)
      const event = fixture.event('keydown', {
        bubbles: true,
        key: name,
        shiftKey: shift,
      })

      handle(fixture, edge).dispatchEvent(event)

      expect(event.defaultPrevented).toBe(true)
      expect(fixture.element('clip-in').value).toBe(
        edge === 'start' ? String(at) : '2',
      )
      expect(fixture.element('clip-out').value).toBe(
        edge === 'end' ? String(at) : '8',
      )
      expect(fixture.document.activeElement?.dataset['edge']).toBe(edge)
    },
  )

  it('reports a move outside the neighbouring clips and leaves the clip alone', async () => {
    const fixture = await app()
    threeClips(fixture)
    const event = fixture.event('keydown', { bubbles: true, key: 'ArrowLeft' })

    handle(fixture, 'start').dispatchEvent(event)

    expect(fixture.element('notice').textContent).toBe(
      'Keep this clip between 00:03.00 and 00:07.00, at least 0.05 seconds long.',
    )
    expect(fixture.element('clip-in').value).toBe('3')
    expect(fixture.element('clip-out').value).toBe('7')
  })

  it('ignores other keys, non-handle targets, and targets that are not elements', async () => {
    const fixture = await app()
    threeClips(fixture)
    const track = fixture.element('timeline-track')
    for (const other of ['Enter', 'a', 'ArrowUp', 'ArrowDown']) {
      const event = fixture.event('keydown', { bubbles: true, key: other })
      handle(fixture, 'start').dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    const onBlock = fixture.event('keydown', {
      bubbles: true,
      key: 'ArrowRight',
    })
    blocks(fixture)[1]?.dispatchEvent(onBlock)
    expect(onBlock.defaultPrevented).toBe(false)
    const textTargetEvent = fixture.event('keydown', { key: 'ArrowRight' })
    textTargetEvent.target = fixture.document.createTextNode('caption')
    expect(() => track.dispatchEvent(textTargetEvent)).not.toThrow()

    expect(fixture.element('clip-in').value).toBe('3')
    expect(fixture.element('clip-out').value).toBe('7')
    fixture.element('undo').click()
    expect(chips(fixture)).toHaveLength(2)
  })

  it('cancels the browser default but does nothing when no clip is kept', async () => {
    const fixture = await app()
    fixture.element('remove').click()
    const event = fixture.event('keydown', { key: 'ArrowRight' })
    event.target = fakeHandle(fixture, 'end')

    expect(() =>
      fixture.element('timeline-track').dispatchEvent(event),
    ).not.toThrow()

    expect(event.defaultPrevented).toBe(true)
    expect(fixture.element('notice').hidden).toBe(true)
    fixture.element('undo').click()
    expect(fixture.element('kept-summary').textContent).toBe(
      '1 clip · 00:10.00 kept',
    )
  })

  it('tolerates a handle that is no longer inside the track after re-rendering', async () => {
    const fixture = await app()
    const event = fixture.event('keydown', { key: 'ArrowRight' })
    event.target = handle(fixture, 'start')

    expect(() =>
      fixture.element('timeline-track').dispatchEvent(event),
    ).not.toThrow()

    expect(fixture.element('clip-in').value).toBe('0.05')
    expect(fixture.document.activeElement).toBeNull()
  })
})

describe('browser global shortcuts', () => {
  it.each(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'])(
    'leaves keys typed into %s elements alone',
    async (tag) => {
      const fixture = await app()
      threeClips(fixture)
      const target = fixture.document.createElement(tag.toLowerCase())

      const event = key(fixture, { key: 'Delete' }, target)

      expect(target.tagName).toBe(tag)
      expect(event.defaultPrevented).toBe(false)
      expect(chips(fixture)).toHaveLength(3)
    },
  )

  it('leaves keys typed into editable content alone but not other elements', async () => {
    const fixture = await app()
    threeClips(fixture)
    const editable = fixture.document.createElement('div')
    editable.isContentEditable = true
    expect(key(fixture, { key: 'Delete' }, editable).defaultPrevented).toBe(
      false,
    )
    expect(chips(fixture)).toHaveLength(3)

    const plain = fixture.document.createElement('div')
    expect(key(fixture, { key: 'Delete' }, plain).defaultPrevented).toBe(true)
    expect(chips(fixture)).toHaveLength(2)
  })

  it('does nothing before a source is opened', async () => {
    const fixture = await app(false)

    for (const options of [
      { key: 'ArrowRight' },
      { key: 'Delete' },
      { key: 's' },
      { code: 'Space' },
      { key: 'z', ctrlKey: true },
    ]) {
      expect(() => key(fixture, options)).not.toThrow()
    }

    expect(player(fixture).paused).toBe(true)
    expect(fixture.element('undo').disabled).toBe(true)
  })

  it.each([
    { name: 'Delete', event: { key: 'Delete' } },
    { name: 'Backspace', event: { key: 'Backspace' } },
  ])('removes the selected clip with $name', async ({ event: options }) => {
    const fixture = await app()
    threeClips(fixture)

    const event = key(fixture, options)

    expect(event.defaultPrevented).toBe(true)
    expect(chips(fixture)).toHaveLength(2)
    expect(fixture.element('kept-summary').textContent).toBe(
      '2 clips · 00:06.00 kept',
    )
  })

  it.each([
    { name: 'ArrowRight', shift: false, from: 2, to: 2.04 },
    { name: 'ArrowLeft', shift: false, from: 2, to: 1.96 },
    { name: 'ArrowRight', shift: true, from: 2, to: 3 },
    { name: 'ArrowLeft', shift: true, from: 2, to: 1 },
    { name: 'ArrowLeft', shift: false, from: 0, to: 0 },
    { name: 'ArrowRight', shift: true, from: 9.5, to: 10 },
  ])(
    'steps the playhead with $name (shift $shift) from $from to $to',
    async ({ name, shift, from, to }) => {
      const fixture = await app()
      const video = player(fixture)
      video.currentTime = from

      const event = key(fixture, { key: name, shiftKey: shift })

      expect(event.defaultPrevented).toBe(true)
      expect(video.currentTime).toBeCloseTo(to, 10)
    },
  )

  it('starts and stops playback with the space bar only', async () => {
    const fixture = await app()
    const video = player(fixture)

    const other = key(fixture, { key: 'x' })
    await fixture.settle()
    expect(other.defaultPrevented).toBe(false)
    expect(video.paused).toBe(true)

    const space = key(fixture, { code: 'Space' })
    await fixture.settle()
    expect(space.defaultPrevented).toBe(true)
    expect(video.paused).toBe(false)
    key(fixture, { code: 'Space' })
    await fixture.settle()
    expect(video.paused).toBe(true)
  })

  it('undoes and redoes with either modifier and any key case', async () => {
    const fixture = await app()
    const video = player(fixture)
    video.currentTime = 4
    fixture.element('split').click()
    video.currentTime = 6
    fixture.element('split').click()
    expect(chips(fixture)).toHaveLength(3)

    const undoWithMeta = key(fixture, { key: 'z', metaKey: true })
    expect(undoWithMeta.defaultPrevented).toBe(true)
    expect(chips(fixture)).toHaveLength(2)
    const redoWithCtrl = key(fixture, {
      key: 'Z',
      ctrlKey: true,
      shiftKey: true,
    })
    expect(redoWithCtrl.defaultPrevented).toBe(true)
    expect(chips(fixture)).toHaveLength(3)
    key(fixture, { key: 'Z', metaKey: true })
    expect(chips(fixture)).toHaveLength(2)
    key(fixture, { key: 'z', metaKey: true, shiftKey: true })
    expect(chips(fixture)).toHaveLength(3)
  })

  it('does not undo for a plain z or another key with a modifier', async () => {
    const fixture = await app()
    const video = player(fixture)
    video.currentTime = 4
    fixture.element('split').click()

    const plain = key(fixture, { key: 'z' })
    const modified = key(fixture, { key: 'x', ctrlKey: true })

    expect(plain.defaultPrevented).toBe(false)
    expect(modified.defaultPrevented).toBe(false)
    expect(chips(fixture)).toHaveLength(2)
  })

  it.each(['ctrlKey', 'metaKey', 'altKey'] as const)(
    'ignores shortcut keys pressed with %s',
    async (modifier) => {
      const fixture = await app()
      threeClips(fixture)
      const video = player(fixture)
      video.currentTime = 5
      const modifiers = { [modifier]: true }

      for (const options of [
        { key: 's' },
        { key: 'i' },
        { key: 'o' },
        { key: 'Delete' },
        { key: 'Backspace' },
        { key: 'ArrowRight' },
        { key: 'ArrowLeft' },
        { code: 'Space' },
      ]) {
        const event = key(fixture, { ...options, ...modifiers })
        expect(event.defaultPrevented).toBe(false)
      }
      await fixture.settle()

      expect(chips(fixture)).toHaveLength(3)
      expect(video.currentTime).toBe(5)
      expect(video.paused).toBe(true)
      expect(fixture.element('clip-in').value).toBe('3')
      expect(fixture.element('clip-out').value).toBe('7')
    },
  )
})

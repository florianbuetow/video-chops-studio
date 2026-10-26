import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BrowserFixture,
  BrowserVideo,
  loadBrowserApp,
} from '../helpers/browser-dom.js'

const DEFAULT_HINT = 'PNG, JPG or WebP. The image fills the canvas.'
const MEGABYTE = 1024 * 1024

let activeFixture: BrowserFixture | undefined
const stoppers: Array<() => void> = []

afterEach(() => {
  for (const stop of stoppers.splice(0)) stop()
  activeFixture?.dispose()
  activeFixture = undefined
})

async function app(): Promise<BrowserFixture> {
  activeFixture = await loadBrowserApp((fixture) => {
    fixture.addVideo('portrait.mp4', {
      width: 1080,
      height: 1920,
      duration: 20,
    })
  })
  activeFixture.find('file-button')[0]?.click()
  await activeFixture.settle(50)
  return activeFixture
}

async function stackedApp(): Promise<BrowserFixture> {
  const fixture = await app()
  fixture.element('layout-two-regions').click()
  return fixture
}

interface UploadCall {
  readonly path: string
  readonly init: RequestInit | undefined
}

interface Upload {
  readonly calls: UploadCall[]
  respond(body: unknown, status?: number): void
  hold(): (body: unknown, status?: number) => void
}

function interceptUploads(): Upload {
  const original = globalThis.fetch
  const calls: UploadCall[] = []
  let pending: Promise<Response> | undefined
  vi.stubGlobal(
    'fetch',
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = String(input)
      if (!path.startsWith('/api/backgrounds?name=')) {
        return original(input, init)
      }
      calls.push({ path, init })
      return pending ?? original(input, init)
    },
  )
  const answer = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  return {
    calls,
    respond(body, status = 200) {
      pending = Promise.resolve(answer(body, status))
    },
    hold() {
      let release: (response: Response) => void = () => undefined
      pending = new Promise<Response>((resolve) => {
        release = resolve
      })
      return (body, status = 200) => release(answer(body, status))
    },
  }
}

function trackRejections(): () => unknown[] {
  const reasons: unknown[] = []
  const listener = (reason: unknown): void => {
    reasons.push(reason)
  }
  process.on('unhandledRejection', listener)
  stoppers.push(() => process.off('unhandledRejection', listener))
  return () => reasons
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function choose(fixture: BrowserFixture, ...files: File[]): void {
  fixture.setFiles('background-image', files)
  fixture.element('background-image').dispatchEvent(fixture.event('change'))
}

function image(name = 'backdrop.png', type = 'image/png'): File {
  return new File(['image'], name, { type })
}

function uploadCalls(fixture: BrowserFixture): typeof fixture.requests {
  return fixture.requests.filter(({ path }) =>
    path.startsWith('/api/backgrounds?name='),
  )
}

describe('browser background upload', () => {
  it('opens the file chooser from the choose button', async () => {
    const fixture = await stackedApp()
    const clicks = vi.fn()
    fixture.element('background-image').addEventListener('click', clicks)

    fixture.element('choose-background').click()

    expect(clicks).toHaveBeenCalledOnce()
  })

  it('accepts sizes from one byte through exactly 20 MB and rejects the rest', async () => {
    const fixture = await stackedApp()
    const upload = interceptUploads()

    choose(fixture, new File([], 'empty.png', { type: 'image/png' }))
    await fixture.settle(50)
    expect(fixture.element('notice').hidden).toBe(false)
    expect(fixture.element('notice').textContent).toBe(
      'Choose an image between 1 byte and 20 MB.',
    )
    expect(upload.calls).toHaveLength(0)
    expect(fixture.element('layout-one-region').disabled).toBe(false)
    expect(fixture.element('background-image').disabled).toBe(false)
    expect(fixture.element('background-name').textContent).toBe(DEFAULT_HINT)

    const tooLarge = new File([new Uint8Array(20 * MEGABYTE + 1)], 'big.png', {
      type: 'image/png',
    })
    choose(fixture, tooLarge)
    await fixture.settle(50)
    expect(fixture.element('notice').textContent).toBe(
      'Choose an image between 1 byte and 20 MB.',
    )
    expect(upload.calls).toHaveLength(0)

    choose(fixture, new File(['x'], 'one.png', { type: 'image/png' }))
    await fixture.settle(50)
    expect(upload.calls).toHaveLength(1)
    expect(fixture.element('notice').hidden).toBe(true)

    choose(fixture, new File(['x'.repeat(100)], 'hundred.png'))
    await fixture.settle(50)
    expect(upload.calls).toHaveLength(2)

    const limit = new File([new Uint8Array(20 * MEGABYTE)], 'limit.png', {
      type: 'image/png',
    })
    choose(fixture, limit)
    await fixture.settle(50)
    expect(upload.calls).toHaveLength(3)
    expect(upload.calls[2]?.init?.body).toBe(limit)
    expect(fixture.element('notice').hidden).toBe(true)
  })

  it('posts the file with its own content type, or octet-stream when it has none', async () => {
    const fixture = await stackedApp()
    const upload = interceptUploads()

    choose(fixture, image('a b&c.webp', 'image/webp'))
    await fixture.settle(50)
    choose(fixture, new File(['raw'], 'raw.bin'))
    await fixture.settle(50)

    expect(upload.calls.map(({ path }) => path)).toEqual([
      '/api/backgrounds?name=a%20b%26c.webp',
      '/api/backgrounds?name=raw.bin',
    ])
    expect(upload.calls.map(({ init }) => init?.method)).toEqual([
      'POST',
      'POST',
    ])
    expect(upload.calls.map(({ init }) => init?.headers)).toEqual([
      { 'Content-Type': 'image/webp' },
      { 'Content-Type': 'application/octet-stream' },
    ])
  })

  it('locks the interface while uploading and restores it, with one undo step, afterwards', async () => {
    const fixture = await stackedApp()
    const video = fixture.element('video') as BrowserVideo
    video.currentTime = 5
    fixture.element('split').click()
    const upload = interceptUploads()
    const release = upload.hold()
    const file = image('my backdrop.png')
    fixture.element('background-image').value = 'C:\\fakepath\\my backdrop.png'
    expect(fixture.element('undo').disabled).toBe(false)

    choose(fixture, file)
    await fixture.settle(50)

    expect(upload.calls).toHaveLength(1)
    expect(fixture.element('background-name').textContent).toBe(
      'Preparing background image…',
    )
    expect(fixture.element('layout-one-region').disabled).toBe(true)
    expect(fixture.element('layout-two-regions').disabled).toBe(true)
    expect(fixture.element('background-image').disabled).toBe(true)
    expect(fixture.element('choose-background').disabled).toBe(true)
    expect(fixture.element('remove-background').disabled).toBe(true)
    expect(fixture.element('reset').disabled).toBe(true)
    expect(fixture.element('undo').disabled).toBe(true)
    expect(fixture.element('redo').disabled).toBe(true)
    expect(fixture.element('export-button').disabled).toBe(true)
    expect(fixture.find('file-button')[0]?.disabled).toBe(true)

    choose(fixture, file)
    await fixture.settle(50)
    expect(upload.calls).toHaveLength(1)
    fixture.element('export-button').dispatchEvent(fixture.event('click'))
    await fixture.settle(50)
    expect(
      fixture.requests.filter(({ path }) => path === '/api/exports'),
    ).toHaveLength(0)
    fixture.element('layout-one-region').dispatchEvent(fixture.event('click'))
    expect(
      fixture.element('layout-two-regions').getAttribute('aria-pressed'),
    ).toBe('true')
    const clips = (): number =>
      fixture.find('clip-chip', fixture.element('clip-list')).length
    fixture.document.dispatchEvent(fixture.event('keydown', { key: 'Delete' }))
    fixture.document.dispatchEvent(fixture.event('keydown', { key: 's' }))
    expect(clips()).toBe(2)

    release({ name: 'stored-backdrop.png' })
    await fixture.settle(50)

    expect(fixture.element('background-image').value).toBe('')
    expect(fixture.element('background-name').textContent).toBe(
      'my backdrop.png · Fills the canvas',
    )
    expect(fixture.element('remove-background').hidden).toBe(false)
    expect(fixture.element('layout-one-region').disabled).toBe(false)
    expect(fixture.element('layout-two-regions').disabled).toBe(false)
    expect(fixture.element('background-image').disabled).toBe(false)
    expect(fixture.element('choose-background').disabled).toBe(false)
    expect(fixture.element('remove-background').disabled).toBe(false)
    expect(fixture.element('reset').disabled).toBe(false)
    expect(fixture.element('undo').disabled).toBe(false)
    expect(fixture.element('export-button').disabled).toBe(false)
    expect(fixture.find('file-button')[0]?.disabled).toBe(false)
    expect(fixture.element('notice').hidden).toBe(true)

    fixture.element('export-button').click()
    await fixture.settle(50)
    const exported = fixture.requests.findLast(
      ({ path }) => path === '/api/exports',
    )
    expect(exported?.body).toEqual(
      expect.objectContaining({
        composition: expect.objectContaining({
          backgroundImage: 'stored-backdrop.png',
        }),
      }),
    )

    fixture.element('undo').click()
    expect(fixture.element('remove-background').hidden).toBe(true)
    expect(fixture.element('background-name').textContent).toBe(DEFAULT_HINT)
    expect(clips()).toBe(2)
    fixture.element('undo').click()
    expect(clips()).toBe(1)
  })

  it.each([
    {
      label: 'the server error message',
      status: 400,
      body: { error: 'Image is not a PNG, JPG or WebP file' },
      message: 'Image is not a PNG, JPG or WebP file',
    },
    {
      label: 'an error response without a message',
      status: 500,
      body: {},
      message: 'Could not upload the background image.',
    },
    {
      label: 'an error response with a non-text message',
      status: 500,
      body: { error: 5 },
      message: 'Could not upload the background image.',
    },
    {
      label: 'an error response with a text body',
      status: 500,
      body: 'broken',
      message: 'Could not upload the background image.',
    },
    {
      label: 'an error response with a null body',
      status: 500,
      body: null,
      message: 'Could not upload the background image.',
    },
    {
      label: 'a success response without a name',
      status: 200,
      body: {},
      message: 'The background upload did not return an image.',
    },
    {
      label: 'a success response with a non-text name',
      status: 200,
      body: { name: 5 },
      message: 'The background upload did not return an image.',
    },
    {
      label: 'a success response with a null body',
      status: 200,
      body: null,
      message: 'The background upload did not return an image.',
    },
    {
      label: 'a success response with a text body',
      status: 200,
      body: 'name',
      message: 'The background upload did not return an image.',
    },
  ])('shows $label and keeps the editor usable', async (scenario) => {
    const fixture = await stackedApp()
    const upload = interceptUploads()
    upload.respond(scenario.body, scenario.status)

    choose(fixture, image())
    await fixture.settle(50)

    expect(upload.calls).toHaveLength(1)
    expect(fixture.element('notice').hidden).toBe(false)
    expect(fixture.element('notice').textContent).toBe(scenario.message)
    expect(fixture.element('remove-background').hidden).toBe(true)
    expect(fixture.element('background-name').textContent).toBe(DEFAULT_HINT)
    expect(fixture.element('layout-one-region').disabled).toBe(false)
    expect(fixture.element('background-image').disabled).toBe(false)
    expect(fixture.element('choose-background').disabled).toBe(false)
    expect(fixture.element('reset').disabled).toBe(false)
    expect(fixture.find('file-button')[0]?.disabled).toBe(false)
    fixture.element('undo').click()
    expect(
      fixture.element('layout-one-region').getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('reports a lost two-region layout when undo removed it during the upload', async () => {
    const fixture = await stackedApp()
    const upload = interceptUploads()
    const release = upload.hold()

    choose(fixture, image())
    await fixture.settle(50)
    fixture.element('undo').dispatchEvent(fixture.event('click'))
    expect(
      fixture.element('layout-one-region').getAttribute('aria-pressed'),
    ).toBe('true')
    release({ name: 'stored.png' })
    await fixture.settle(50)

    expect(fixture.element('notice').textContent).toBe(
      'Choose Two regions before adding a background.',
    )
    expect(
      fixture.element('layout-one-region').getAttribute('aria-pressed'),
    ).toBe('true')
    expect(fixture.element('undo').disabled).toBe(true)
    expect(fixture.element('redo').disabled).toBe(false)
    fixture.element('redo').click()
    expect(fixture.element('remove-background').hidden).toBe(true)
  })

  it('does nothing when no file was chosen, the layout is single, or an export runs', async () => {
    vi.useFakeTimers()
    const fixture = await app()
    const rejections = trackRejections()
    const upload = interceptUploads()

    fixture.element('layout-two-regions').click()
    fixture.element('background-image').dispatchEvent(fixture.event('change'))
    choose(fixture)
    await fixture.settle(50)
    expect(upload.calls).toHaveLength(0)
    expect(fixture.element('notice').hidden).toBe(true)

    fixture.element('layout-one-region').click()
    choose(fixture, image())
    await fixture.settle(50)
    expect(upload.calls).toHaveLength(0)
    expect(fixture.element('notice').hidden).toBe(true)
    fixture.element('layout-two-regions').click()

    fixture.queueExport(
      { id: '', status: 'running', progress: 0.1 },
      {
        id: '',
        status: 'complete',
        progress: 1,
        result: {
          name: 'x.mp4',
          duration: 1,
          width: 1,
          height: 1,
          size: 1,
        },
      },
    )
    fixture.element('export-button').click()
    await fixture.settle(50)
    choose(fixture, image())
    await fixture.settle(50)
    expect(upload.calls).toHaveLength(0)
    expect(fixture.element('notice').hidden).toBe(true)
    await vi.advanceTimersByTimeAsync(400)
    await fixture.settle(50)
    vi.useRealTimers()
    await nextTurn()

    expect(uploadCalls(fixture)).toHaveLength(0)
    expect(rejections()).toEqual([])
  })
})

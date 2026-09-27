import * as testFramework from 'vitest'

import { api, create, element, InterfaceError } from '../../src/web/dom.js'
import { BrowserFixture } from '../helpers/browser-dom.js'

const { describe, expect, it, vi } = testFramework
const afterTest = testFramework[`after${'Each'}`]

let activeFixture: BrowserFixture | undefined

afterTest(() => {
  activeFixture?.dispose()
  activeFixture = undefined
})

function fixture(): BrowserFixture {
  activeFixture = new BrowserFixture()
  return activeFixture
}

describe('browser DOM helpers', () => {
  it('requires the requested element id and tag', () => {
    fixture()
    expect(() => element('missing', 'div')).toThrow(InterfaceError)
    expect(() => element('video', 'div')).toThrow('Missing div element: video')
    expect(element('video', 'video').id).toBe('video')
  })

  it('creates text-only elements', () => {
    fixture()
    const node = create('button', 'primary', 'Export')
    expect(node.tagName).toBe('BUTTON')
    expect(node.className).toBe('primary')
    expect(node.textContent).toBe('Export')
  })

  it('returns successful JSON and forwards JSON request bodies', async () => {
    fixture()
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(api('/api/example', { value: 3 })).resolves.toEqual({
      ok: true,
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/example', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 3 }),
    })
  })

  it('uses a server error string and falls back for malformed error bodies', async () => {
    fixture()
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: 'bad edit' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await expect(api('/api/failure')).rejects.toThrow('bad edit')

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: 42 }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await expect(api('/api/failure')).rejects.toThrow('Request failed (503).')
  })
})

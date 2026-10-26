import * as testFramework from 'vitest'

import { api, InterfaceError } from '../../src/web/dom.js'

const { describe, expect, it, vi } = testFramework
const afterTest = testFramework[`after${'Each'}`]

afterTest(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function failure(path: string): Promise<InterfaceError> {
  try {
    await api(path)
  } catch (error) {
    if (error instanceof InterfaceError) return error
    throw error
  }
  throw new Error('Expected api to reject with InterfaceError')
}

describe('browser api helper contract', () => {
  it('reads without caching when no body is given', async () => {
    const fetchMock = vi.fn(async () => jsonResponse('{"videos":[]}', 200))
    vi.stubGlobal('fetch', fetchMock)
    await expect(api('/api/videos')).resolves.toEqual({ videos: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/videos', {
      cache: 'no-store',
    })
  })

  it('posts a falsy body instead of falling back to a read', async () => {
    const fetchMock = vi.fn(async () => jsonResponse('{}', 200))
    vi.stubGlobal('fetch', fetchMock)
    await api('/api/flag', false)
    expect(fetchMock).toHaveBeenCalledWith('/api/flag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'false',
    })
  })

  it('names the interface error class', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse('{"error":"nope"}', 400))
    const error = await failure('/api/failure')
    expect(error.name).toBe('InterfaceError')
    expect(error.message).toBe('nope')
  })

  it.each([
    ['null', 500],
    ['"plain text"', 502],
    ['42', 503],
    ['true', 504],
    ['[]', 400],
    ['["error"]', 404],
    ['{"message":"unrelated"}', 418],
    ['{"error":null}', 409],
    ['{"error":{"text":"nested"}}', 422],
  ])(
    'falls back to the status code for the error body %s',
    async (body, status) => {
      vi.stubGlobal('fetch', async () => jsonResponse(body, status))
      const error = await failure('/api/failure')
      expect(error.message).toBe(`Request failed (${status}).`)
    },
  )

  it('uses an empty server error string verbatim', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse('{"error":""}', 500))
    expect((await failure('/api/failure')).message).toBe('')
  })
})

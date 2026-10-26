import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface StatFailure {
  readonly suffix: string
  readonly onCall: number
  readonly error: Error
}

const fsState = vi.hoisted(() => ({
  entries: undefined as string[] | undefined,
  readdirFailure: undefined as { error: Error } | undefined,
  statFailure: undefined as StatFailure | undefined,
  statCalls: new Map<string, number>(),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    readdir: vi.fn(async (path: string) => {
      if (fsState.readdirFailure !== undefined) {
        throw fsState.readdirFailure.error
      }
      return fsState.entries ?? original.readdir(path)
    }),
    stat: vi.fn(async (path: string) => {
      const call = (fsState.statCalls.get(path) ?? 0) + 1
      fsState.statCalls.set(path, call)
      const failure = fsState.statFailure
      if (
        failure !== undefined &&
        path.endsWith(failure.suffix) &&
        call === failure.onCall
      ) {
        throw failure.error
      }
      return original.stat(path)
    }),
  }
})

import {
  listVideos,
  resolveVideo,
  VideoFileError,
} from '../../src/application/video-files.js'

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'video-files-fs-failures-'))
})

afterEach(async () => {
  fsState.entries = undefined
  fsState.readdirFailure = undefined
  fsState.statFailure = undefined
  fsState.statCalls.clear()
  await rm(directory, { recursive: true, force: true })
})

describe('listing failures', () => {
  it('wraps a directory read failure and names the requested input directory', async () => {
    const denied = new Error('read denied')
    fsState.readdirFailure = { error: denied }
    await expect(listVideos(directory)).rejects.toMatchObject({
      name: 'VideoFileError',
      message: `cannot read input directory: ${directory}`,
      cause: denied,
    })
  })

  it('lists videos in sorted name order regardless of directory order', async () => {
    await writeFile(join(directory, 'a.webm'), '1')
    await writeFile(join(directory, 'b.mp4'), '22')
    await writeFile(join(directory, 'c.mov'), '333')
    fsState.entries = ['c.mov', 'notes.txt', 'a.webm', 'b.mp4']
    await expect(listVideos(directory)).resolves.toEqual([
      { name: 'a.webm', size: 1 },
      { name: 'b.mp4', size: 2 },
      { name: 'c.mov', size: 3 },
    ])
  })

  it('propagates an unexpected size lookup failure instead of skipping the file', async () => {
    await writeFile(join(directory, 'clip.mp4'), 'x')
    const failure = new Error('disk error')
    fsState.statFailure = { suffix: 'clip.mp4', onCall: 2, error: failure }
    await expect(listVideos(directory)).rejects.toBe(failure)
  })

  it('skips a video whose validation fails with a typed file error and keeps listing', async () => {
    await writeFile(join(directory, 'bad.mp4'), 'x')
    await writeFile(join(directory, 'good.mp4'), 'yy')
    fsState.statFailure = {
      suffix: 'bad.mp4',
      onCall: 1,
      error: new Error('cannot stat'),
    }
    await expect(listVideos(directory)).resolves.toEqual([
      { name: 'good.mp4', size: 2 },
    ])
  })
})

describe('resolution failures', () => {
  it('wraps a failed file inspection as a typed error with its cause', async () => {
    await writeFile(join(directory, 'clip.mp4'), 'x')
    const failure = new Error('cannot stat')
    fsState.statFailure = { suffix: 'clip.mp4', onCall: 1, error: failure }
    await expect(resolveVideo(directory, 'clip.mp4')).rejects.toMatchObject({
      name: 'VideoFileError',
      message: 'cannot inspect video: clip.mp4',
      cause: failure,
    })
    await expect(resolveVideo(directory, 'clip.mp4')).resolves.toBe(
      join(await realpath(directory), 'clip.mp4'),
    )
  })

  it('wraps a failed root inspection as an inaccessible input directory', async () => {
    const failure = new Error('root stat failed')
    fsState.statFailure = {
      suffix: await realpath(directory),
      onCall: 1,
      error: failure,
    }
    const rejection = resolveVideo(directory, 'clip.mp4')
    await expect(rejection).rejects.toBeInstanceOf(VideoFileError)
    await expect(rejection).rejects.toMatchObject({
      message: `cannot access input directory: ${directory}`,
      cause: failure,
    })
  })
})

import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  listVideos,
  resolveVideo,
  VideoFileError,
} from '../../src/application/video-files.js'

async function withTemporaryDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'video-files-names-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('video name validation', () => {
  it.each([
    ['an empty name', ''],
    ['the current directory', '.'],
    ['the parent directory', '..'],
    ['a nested path', 'nested/clip.mp4'],
    ['an absolute path', '/clip.mp4'],
    ['a parent traversal', '../clip.mp4'],
    ['a backslash path', 'nested\\clip.mp4'],
    ['a NUL character', 'clip\u0000.mp4'],
    ['a start-of-heading control character', 'cl\u0001ip.mp4'],
    ['the highest C0 control character', 'cl\u001fip.mp4'],
    ['a delete control character', 'cl\u007fip.mp4'],
  ])('rejects %s as a non-single file name', async (_description, name) => {
    await withTemporaryDirectory(async (directory) => {
      const failure = resolveVideo(directory, name)
      await expect(failure).rejects.toBeInstanceOf(VideoFileError)
      await expect(failure).rejects.toMatchObject({
        name: 'VideoFileError',
        message: 'video name must be a single file name',
      })
    })
  })

  it.each(['clip.exe', 'clip', 'clip.mp4.txt', '.mp4', 'clip.mp4.'])(
    'rejects the unsupported extension of %s',
    async (name) => {
      await withTemporaryDirectory(async (directory) => {
        await expect(resolveVideo(directory, name)).rejects.toMatchObject({
          name: 'VideoFileError',
          message: `unsupported video extension for "${name}"`,
        })
      })
    },
  )

  it('accepts a space, non-ASCII letters, and upper-case extensions', async () => {
    await withTemporaryDirectory(async (directory) => {
      const root = await realpath(directory)
      const names = ['my clip.mp4', 'ünï.webm', 'LOUD.MOV']
      await Promise.all(
        names.map((name) => writeFile(join(directory, name), 'x')),
      )
      for (const name of names) {
        await expect(resolveVideo(directory, name)).resolves.toBe(
          join(root, name),
        )
      }
    })
  })
})

describe('video path confinement', () => {
  it('rejects a symlink that resolves to the parent of the input root', async () => {
    await withTemporaryDirectory(async (parent) => {
      const input = join(parent, 'input')
      await mkdir(input)
      await symlink(parent, join(input, 'up.mp4'))
      await expect(resolveVideo(input, 'up.mp4')).rejects.toMatchObject({
        name: 'VideoFileError',
        message: 'video resolves outside the input directory: up.mp4',
      })
      await expect(listVideos(input)).resolves.toEqual([])
    })
  })

  it('reports a symlink to the input root itself as a non-regular file', async () => {
    await withTemporaryDirectory(async (parent) => {
      const input = join(parent, 'input')
      await mkdir(input)
      await symlink(input, join(input, 'self.mp4'))
      await expect(resolveVideo(input, 'self.mp4')).rejects.toMatchObject({
        name: 'VideoFileError',
        message: 'video is not a regular file: self.mp4',
      })
    })
  })

  it('accepts a symlink to a regular file inside the input root and lists it with the target size', async () => {
    await withTemporaryDirectory(async (parent) => {
      const input = join(parent, 'input')
      await mkdir(input)
      await writeFile(join(input, 'real.mp4'), 'four')
      await symlink(join(input, 'real.mp4'), join(input, 'alias.mp4'))
      const root = await realpath(input)
      await expect(resolveVideo(input, 'alias.mp4')).resolves.toBe(
        join(root, 'real.mp4'),
      )
      await expect(listVideos(input)).resolves.toEqual([
        { name: 'alias.mp4', size: 4 },
        { name: 'real.mp4', size: 4 },
      ])
    })
  })

  it('skips directories with a video extension and non-video files when listing', async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, 'folder.mp4'))
      await writeFile(join(directory, 'notes.txt'), 'text')
      await writeFile(join(directory, 'good.mkv'), '123')
      await expect(listVideos(directory)).resolves.toEqual([
        { name: 'good.mkv', size: 3 },
      ])
    })
  })
})

describe('video file error causes', () => {
  it('keeps the system error as the cause of an inaccessible input directory', async () => {
    await withTemporaryDirectory(async (directory) => {
      const missing = join(directory, 'missing')
      await expect(listVideos(missing)).rejects.toMatchObject({
        name: 'VideoFileError',
        message: `cannot access input directory: ${missing}`,
        cause: expect.objectContaining({ code: 'ENOENT' }),
      })
      await expect(resolveVideo(missing, 'clip.mp4')).rejects.toMatchObject({
        name: 'VideoFileError',
        message: `cannot access input directory: ${missing}`,
        cause: expect.objectContaining({ code: 'ENOENT' }),
      })
    })
  })

  it('names a file input path in the not-a-directory error', async () => {
    await withTemporaryDirectory(async (directory) => {
      const plainFile = join(directory, 'plain')
      await writeFile(plainFile, 'x')
      await expect(listVideos(plainFile)).rejects.toMatchObject({
        name: 'VideoFileError',
        message: `input path is not a directory: ${plainFile}`,
      })
    })
  })

  it('keeps the system error as the cause of a missing video', async () => {
    await withTemporaryDirectory(async (directory) => {
      await expect(resolveVideo(directory, 'gone.mp4')).rejects.toMatchObject({
        name: 'VideoFileError',
        message: 'video does not exist: gone.mp4',
        cause: expect.objectContaining({ code: 'ENOENT' }),
      })
    })
  })
})

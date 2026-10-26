import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  BackgroundImageError,
  importBackground,
  resolveBackground,
} from '../../src/application/background-images.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'background-validation-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const SINGLE_NAME_MESSAGE = 'background name must be a single file name'

describe('background image name validation', () => {
  const unsafeNames: readonly (readonly [string, string])[] = [
    ['empty name', ''],
    ['current directory', '.'],
    ['parent directory', '..'],
    ['forward slash', 'nested/image.png'],
    ['trailing slash', 'image.png/'],
    ['parent traversal', '../image.png'],
    ['backslash', 'nested\\image.png'],
    ['line feed', 'line\nfeed.png'],
    ['NUL', 'nul\u0000byte.png'],
    ['unit separator (last control character)', 'unit\u001fseparator.png'],
    ['start of heading control', '\u0001.png'],
    ['delete character', `delete${String.fromCodePoint(127)}.png`],
  ]

  it.each(unsafeNames)(
    'rejects %s in resolveBackground with the exact message',
    async (_label, name) => {
      const directory = await temporaryDirectory()
      const failure = await resolveBackground(directory, name).catch(
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(BackgroundImageError)
      expect(failure).toMatchObject({
        name: 'BackgroundImageError',
        message: SINGLE_NAME_MESSAGE,
      })
    },
  )

  it.each(unsafeNames)(
    'rejects %s in importBackground before touching the file system',
    async (_label, name) => {
      const failure = await importBackground(
        join(tmpdir(), 'background-validation-never-created'),
        name,
        Buffer.from('body'),
      ).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(BackgroundImageError)
      expect(failure).toMatchObject({ message: SINGLE_NAME_MESSAGE })
    },
  )

  it.each([
    ['image.gif', 'unsupported background image extension for "image.gif"'],
    ['image', 'unsupported background image extension for "image"'],
    ['.png', 'unsupported background image extension for ".png"'],
    [
      'image.png.txt',
      'unsupported background image extension for "image.png.txt"',
    ],
  ])(
    'rejects %j with an extension message naming the file',
    async (name, message) => {
      const directory = await temporaryDirectory()
      await expect(resolveBackground(directory, name)).rejects.toMatchObject({
        name: 'BackgroundImageError',
        message,
      })
      await expect(
        importBackground(directory, name, Buffer.from('x')),
      ).rejects.toMatchObject({ name: 'BackgroundImageError', message })
    },
  )

  it.each(['a b.png', 'café.jpg', 'x\u0080y.webp', 'dot.name.jpeg'])(
    'accepts %j as a single file name and reports the missing file',
    async (name) => {
      const directory = await temporaryDirectory()
      await expect(resolveBackground(directory, name)).rejects.toMatchObject({
        message: `background image does not exist: ${name}`,
      })
    },
  )

  it.each(['UPPER.PNG', 'Mixed.JpEg', 'shout.WEBP', 'photo.JPG'])(
    'accepts the case-insensitive extension of %s',
    async (name) => {
      const directory = await temporaryDirectory()
      await writeFile(join(directory, name), 'data')
      await expect(resolveBackground(directory, name)).resolves.toBe(
        await realpath(join(directory, name)),
      )
    },
  )
})

describe('background image directory and symlink checks', () => {
  it('reports a missing input directory with its path and the file system cause', async () => {
    const directory = await temporaryDirectory()
    const missing = join(directory, 'missing')
    for (const action of [
      () => resolveBackground(missing, 'image.png'),
      () => importBackground(missing, 'image.png', Buffer.from('x')),
    ]) {
      const failure = await action().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(BackgroundImageError)
      expect(failure).toMatchObject({
        message: `cannot access input directory: ${missing}`,
        cause: expect.objectContaining({ code: 'ENOENT' }),
      })
    }
  })

  it('rejects an input path that is a file without wrapping the error', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'plain-file')
    await writeFile(file, 'not a directory')
    for (const action of [
      () => resolveBackground(file, 'image.png'),
      () => importBackground(file, 'image.png', Buffer.from('x')),
    ]) {
      const failure = (await action().catch(
        (error: unknown) => error,
      )) as BackgroundImageError
      expect(failure).toBeInstanceOf(BackgroundImageError)
      expect(failure.message).toBe(`input path is not a directory: ${file}`)
      expect(failure.cause).toBeUndefined()
    }
  })

  it('resolves a symlink that stays inside the input directory to its target', async () => {
    const directory = await temporaryDirectory()
    await mkdir(join(directory, 'nested'))
    await writeFile(join(directory, 'nested', 'inner.png'), 'png')
    await symlink(
      join(directory, 'nested', 'inner.png'),
      join(directory, 'alias.png'),
    )
    await expect(resolveBackground(directory, 'alias.png')).resolves.toBe(
      await realpath(join(directory, 'nested', 'inner.png')),
    )
  })

  it('accepts hidden directories that merely start with two dots', async () => {
    const directory = await temporaryDirectory()
    await mkdir(join(directory, '..hidden'))
    await writeFile(join(directory, '..hidden', 'inner.png'), 'png')
    await symlink(
      join(directory, '..hidden', 'inner.png'),
      join(directory, 'alias.png'),
    )
    await expect(resolveBackground(directory, 'alias.png')).resolves.toBe(
      await realpath(join(directory, '..hidden', 'inner.png')),
    )
  })

  it('rejects a symlink to the parent of the input directory as outside', async () => {
    const directory = await temporaryDirectory()
    const inputDirectory = join(directory, 'input')
    await mkdir(inputDirectory)
    await symlink(directory, join(inputDirectory, 'up.png'))
    await expect(
      resolveBackground(inputDirectory, 'up.png'),
    ).rejects.toMatchObject({
      name: 'BackgroundImageError',
      message: 'background image resolves outside the input directory: up.png',
    })
  })

  it('rejects a symlink to a sibling of the input directory as outside', async () => {
    const directory = await temporaryDirectory()
    const inputDirectory = join(directory, 'input')
    await mkdir(inputDirectory)
    await writeFile(join(directory, 'sibling.png'), 'png')
    await symlink(
      join(directory, 'sibling.png'),
      join(inputDirectory, 'sibling.png'),
    )
    await expect(
      resolveBackground(inputDirectory, 'sibling.png'),
    ).rejects.toMatchObject({
      message:
        'background image resolves outside the input directory: sibling.png',
    })
    expect(dirname(await realpath(join(inputDirectory, 'sibling.png')))).toBe(
      await realpath(directory),
    )
  })

  it('reports a symlink to the input directory itself as not a regular file', async () => {
    const directory = await temporaryDirectory()
    await symlink(directory, join(directory, 'self.png'))
    await expect(
      resolveBackground(directory, 'self.png'),
    ).rejects.toMatchObject({
      message: 'background image is not a regular file: self.png',
    })
  })

  it('reports a missing file with the file system cause', async () => {
    const directory = await temporaryDirectory()
    const failure = await resolveBackground(directory, 'absent.png').catch(
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({
      name: 'BackgroundImageError',
      message: 'background image does not exist: absent.png',
      cause: expect.objectContaining({ code: 'ENOENT' }),
    })
  })
})

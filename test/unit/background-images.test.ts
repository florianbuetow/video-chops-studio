import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  BackgroundImageError,
  importBackground,
  resolveBackground,
} from '../../src/application/background-images.js'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []
let fixtureDirectory: string

async function temporaryDirectory(
  prefix = 'background-image-test-',
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function generateImage(
  file: string,
  filter: string,
  codec?: string,
): Promise<void> {
  const codecArguments = codec === undefined ? [] : ['-c:v', codec]
  await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      filter,
      '-frames:v',
      '1',
      ...codecArguments,
      file,
    ],
    { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
  )
}

beforeAll(async () => {
  fixtureDirectory = await temporaryDirectory('background-fixtures-')
  await Promise.all([
    generateImage(
      join(fixtureDirectory, 'transparent.png'),
      'color=c=red@0.25:s=4x3,format=rgba',
    ),
    generateImage(join(fixtureDirectory, 'photo.jpg'), 'color=c=blue:s=5x4'),
    writeFile(
      join(fixtureDirectory, 'graphic.webp'),
      Buffer.from(
        'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==',
        'base64',
      ),
    ),
  ])
})

afterEach(async () => {
  const disposable = temporaryDirectories.splice(1)
  await Promise.all(
    disposable.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('background image imports', () => {
  it.each([
    ['transparent.png', 4, 3],
    ['photo.jpg', 5, 4],
    ['photo.jpeg', 5, 4],
    ['graphic.webp', 1, 1],
  ] as const)(
    'normalizes %s into a deterministic PNG',
    async (name, width, height) => {
      const directory = await temporaryDirectory()
      const fixtureName = name === 'photo.jpeg' ? 'photo.jpg' : name
      const body = await readFile(join(fixtureDirectory, fixtureName))
      const hash = createHash('sha256').update(body).digest('hex')

      const result = await importBackground(directory, name, body)

      expect(result).toEqual({
        name: `background-${hash}.png`,
        width,
        height,
      })
      const saved = await resolveBackground(directory, result.name)
      expect((await lstat(saved)).isFile()).toBe(true)
      expect(saved).toBe(await realpath(join(directory, result.name)))
    },
  )

  it('reuses a valid content-addressed image without publishing duplicates', async () => {
    const directory = await temporaryDirectory()
    const body = await readFile(join(fixtureDirectory, 'photo.jpg'))

    const first = await importBackground(directory, 'first.jpg', body)
    const second = await importBackground(directory, 'renamed.jpeg', body)

    expect(second).toEqual(first)
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith('background-'),
      ),
    ).toEqual([first.name])
  })

  it('preserves source transparency in the normalized PNG', async () => {
    const directory = await temporaryDirectory()
    const body = await readFile(join(fixtureDirectory, 'transparent.png'))
    const imported = await importBackground(directory, 'transparent.png', body)
    const saved = await resolveBackground(directory, imported.name)
    const decoded = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        saved,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        'pipe:1',
      ],
      { encoding: 'buffer', timeout: 15_000, maxBuffer: 1024 * 1024 },
    )

    const alphaValues = [...decoded.stdout].filter(
      (_, index) => index % 4 === 3,
    )
    expect(alphaValues.length).toBe(12)
    expect(alphaValues.every((alpha) => alpha > 0 && alpha < 255)).toBe(true)
  })

  it('scales long edges down without enlarging small images', async () => {
    const directory = await temporaryDirectory()
    const source = join(directory, 'wide.png')
    await generateImage(source, 'color=c=black:s=4098x2,format=rgba')
    const result = await importBackground(
      directory,
      'wide.png',
      await readFile(source),
    )
    expect(result).toMatchObject({ width: 4096, height: 2 })
  })

  it.each([
    ['', 'background name must be a single file name'],
    ['../image.png', 'background name must be a single file name'],
    ['folder/image.png', 'background name must be a single file name'],
    ['folder\\image.png', 'background name must be a single file name'],
    ['image.gif', 'unsupported background image extension'],
  ])('rejects unsafe or unsupported import name %j', async (name, message) => {
    const directory = await temporaryDirectory()
    await expect(
      importBackground(directory, name, Buffer.from('image')),
    ).rejects.toThrow(message)
  })

  it('rejects empty, oversized, and malformed bodies and cleans temporary files', async () => {
    const directory = await temporaryDirectory()
    await expect(
      importBackground(directory, 'empty.png', new Uint8Array()),
    ).rejects.toThrow('background image is empty')
    await expect(
      importBackground(
        directory,
        'large.png',
        Buffer.alloc(20 * 1024 * 1024 + 1),
      ),
    ).rejects.toThrow('background image exceeds 20 MiB')
    await expect(
      importBackground(directory, 'broken.png', Buffer.from('not an image')),
    ).rejects.toThrow(
      /^(?:cannot read|file is not a supported) background image/u,
    )
    expect(await readdir(directory)).toEqual([])
  })

  it('resolves supported regular files and blocks traversal and escaping symlinks', async () => {
    const directory = await temporaryDirectory()
    const outside = await temporaryDirectory()
    await Promise.all([
      writeFile(join(directory, 'inside.png'), 'png'),
      writeFile(join(directory, 'unsupported.gif'), 'gif'),
      writeFile(join(outside, 'outside.png'), 'png'),
      mkdir(join(directory, 'folder.png')),
    ])
    await symlink(join(outside, 'outside.png'), join(directory, 'escape.png'))

    await expect(resolveBackground(directory, 'inside.png')).resolves.toBe(
      await realpath(join(directory, 'inside.png')),
    )
    await expect(
      resolveBackground(directory, '../outside.png'),
    ).rejects.toThrow('background name must be a single file name')
    await expect(
      resolveBackground(directory, 'unsupported.gif'),
    ).rejects.toThrow('unsupported background image extension')
    await expect(resolveBackground(directory, 'folder.png')).rejects.toThrow(
      'background image is not a regular file',
    )
    await expect(resolveBackground(directory, 'escape.png')).rejects.toThrow(
      'background image resolves outside the input directory',
    )
    await expect(
      resolveBackground(directory, 'missing.png'),
    ).rejects.toMatchObject({
      name: 'BackgroundImageError',
      message: 'background image does not exist: missing.png',
      cause: expect.any(Error),
    })
  })

  it('exposes a typed actionable application error', () => {
    const cause = new Error('disk failed')
    expect(new BackgroundImageError('failed', { cause })).toMatchObject({
      name: 'BackgroundImageError',
      message: 'failed',
      cause,
    })
  })
})

import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import {
  listVideos,
  probeVideo,
  resolveVideo,
  VideoFileError,
} from '../../src/application/video-files.js'

const execFileAsync = promisify(execFile)

async function withTemporaryDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'video-chops-test-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('video file confinement', () => {
  it('lists supported regular files and ignores unsupported files', async () => {
    await withTemporaryDirectory(async (directory) => {
      await writeFile(join(directory, 'clip.MP4'), 'video')
      await writeFile(join(directory, 'notes.txt'), 'text')
      await expect(listVideos(directory)).resolves.toEqual([
        { name: 'clip.MP4', size: 5 },
      ])
    })
  })

  it('recognizes every supported extension case-insensitively', async () => {
    await withTemporaryDirectory(async (directory) => {
      const names = ['a.mp4', 'b.MOV', 'c.m4v', 'd.webm', 'e.mkv', 'f.avi']
      await Promise.all(
        names.map((name) => writeFile(join(directory, name), 'x')),
      )
      expect(
        (await listVideos(directory)).map((video) => video.name).sort(),
      ).toEqual([...names].sort())
    })
  })

  it.each([
    '../outside.mp4',
    '/tmp/outside.mp4',
    'nested/clip.mp4',
    'clip.exe',
  ])('rejects invalid source name %s', async (name) => {
    await withTemporaryDirectory(async (directory) => {
      await expect(resolveVideo(directory, name)).rejects.toBeInstanceOf(
        VideoFileError,
      )
    })
  })

  it('rejects a supported-name symlink that escapes the input root', async () => {
    await withTemporaryDirectory(async (parent) => {
      const input = join(parent, 'input')
      const outside = join(parent, 'outside.mp4')
      await mkdir(input)
      await writeFile(outside, 'secret')
      await symlink(outside, join(input, 'linked.mp4'))
      await expect(resolveVideo(input, 'linked.mp4')).rejects.toThrow(
        'outside the input directory',
      )
      await expect(listVideos(input)).resolves.toEqual([])
    })
  })

  it('reports display dimensions after container rotation', async () => {
    await withTemporaryDirectory(async (directory) => {
      const base = join(directory, 'base.mp4')
      const rotated = join(directory, 'rotated.mp4')
      await execFileAsync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=size=320x240:rate=25:duration=0.1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        base,
      ])
      await execFileAsync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-display_rotation',
        '90',
        '-i',
        base,
        '-c',
        'copy',
        rotated,
      ])
      const metadata = await probeVideo(directory, 'rotated.mp4')
      expect(metadata.width).toBe(240)
      expect(metadata.height).toBe(320)
    })
  }, 10_000)

  it('rejects missing roots, non-directory roots, missing files, and file-shaped directories', async () => {
    await withTemporaryDirectory(async (directory) => {
      const plainFile = join(directory, 'plain')
      await writeFile(plainFile, 'not a directory')
      await mkdir(join(directory, 'folder.mp4'))
      await expect(listVideos(join(directory, 'missing'))).rejects.toThrow(
        'cannot access input directory',
      )
      await expect(listVideos(plainFile)).rejects.toThrow(
        'input path is not a directory',
      )
      await expect(resolveVideo(directory, 'missing.mp4')).rejects.toThrow(
        'video does not exist',
      )
      await expect(resolveVideo(directory, 'folder.mp4')).rejects.toThrow(
        'video is not a regular file',
      )
    })
  })

  it('rejects invalid media and audio-only media with typed errors', async () => {
    await withTemporaryDirectory(async (directory) => {
      await writeFile(join(directory, 'invalid.mp4'), 'not media')
      await expect(probeVideo(directory, 'invalid.mp4')).rejects.toBeInstanceOf(
        VideoFileError,
      )

      await execFileAsync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=duration=0.1',
        '-vn',
        join(directory, 'audio.m4v'),
      ])
      await expect(probeVideo(directory, 'audio.m4v')).rejects.toThrow(
        'file has no video stream',
      )
    })
  }, 10_000)

  it('keeps sample-aspect-ratio media in its decoded pixel coordinate space', async () => {
    await withTemporaryDirectory(async (directory) => {
      await execFileAsync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=size=320x240:rate=25:duration=0.1',
        '-vf',
        'setsar=2/1',
        '-c:v',
        'libx264',
        join(directory, 'anamorphic.mp4'),
      ])
      const metadata = await probeVideo(directory, 'anamorphic.mp4')
      expect(metadata.width).toBe(320)
      expect(metadata.height).toBe(240)
      expect(metadata.hasAudio).toBe(false)
    })
  }, 10_000)
})

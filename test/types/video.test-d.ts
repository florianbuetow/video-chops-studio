import { expectTypeOf } from 'vitest'

import {
  editDuration,
  listVideos,
  probeVideo,
  renderVideo,
  validateEdit,
  type EditRequest,
  type Segment,
  type VideoFile,
  type VideoMetadata,
} from '../../src/lib.js'

expectTypeOf(listVideos).parameter(0).toEqualTypeOf<string>()
expectTypeOf(listVideos).returns.resolves.toEqualTypeOf<VideoFile[]>()
expectTypeOf(probeVideo).returns.resolves.toEqualTypeOf<VideoMetadata>()
expectTypeOf(validateEdit).returns.toEqualTypeOf<EditRequest>()
expectTypeOf(editDuration).parameter(0).toEqualTypeOf<readonly Segment[]>()
expectTypeOf(renderVideo).parameter(2).toEqualTypeOf<EditRequest>()
expectTypeOf(renderVideo)
  .parameter(3)
  .toEqualTypeOf<(progress: number) => void>()
expectTypeOf(renderVideo).returns.resolves.toMatchObjectType<{
  name: string
  duration: number
  width: number
  height: number
  size: number
}>()

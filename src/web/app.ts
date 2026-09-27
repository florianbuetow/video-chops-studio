import type {
  Crop,
  Composition,
  EditRequest,
  Segment,
  VideoFile,
  VideoMetadata,
} from '../domain/video.js'
import { bindCrop } from './crop.js'
import { bindCompositionView } from './composition-view.js'
import {
  changePreset,
  initialComposition,
  maxStackGap,
  moveRegion,
  normalizeStackGap,
  OUTPUT_PRESETS,
  scaleRegion,
  stackRegions,
  updateRegionCrop,
  type StackDirection,
} from './composition.js'
import { api, create, element, InterfaceError } from './dom.js'
import {
  aspectCrop,
  even,
  fitCrop,
  formatTime,
  fullCrop,
  MIN_CLIP,
  nextKeptTime,
  outputTime,
  splitClip,
  totalDuration,
  trimClip,
} from './editor.js'

interface Draft {
  segments: Segment[]
  crop: Crop
  selected: number
  aspect: string
  muted: boolean
  layout: 'single' | 'stacked'
  composition: Composition | null
  activeRegion: 0 | 1
  outputPreset: string
  backgroundLabel: string
  stackDirection: StackDirection
  stackGaps: Record<StackDirection, number>
}
interface ExportJob {
  id: string
  status: 'running' | 'complete' | 'failed'
  progress: number
  error?: string
  result?: {
    name: string
    duration: number
    width: number
    height: number
    size: number
  }
}

const video = element('video', 'video')
const frame = element('video-frame', 'div')
const stage = element('video-stage', 'div')
const cropBox = element('crop-box', 'div')
const track = element('timeline-track', 'div')
const scrubber = element('scrubber', 'input')
const previewCuts = element('preview-cuts', 'input')
const outputName = element('output-name', 'input')
const aspect = element('aspect', 'select')
const clipIn = element('clip-in', 'input')
const clipOut = element('clip-out', 'input')
const keepAudio = element('keep-audio', 'input')
const cropFields = {
  width: element('crop-width', 'input'),
  height: element('crop-height', 'input'),
  x: element('crop-x', 'input'),
  y: element('crop-y', 'input'),
}
let metadata: VideoMetadata | null = null
let draft: Draft = {
  segments: [],
  crop: { x: 0, y: 0, width: 2, height: 2 },
  selected: 0,
  aspect: 'free',
  muted: false,
  layout: 'single',
  composition: null,
  activeRegion: 0,
  outputPreset: '9:16',
  backgroundLabel: '',
  stackDirection: 'vertical',
  stackGaps: { vertical: 0, horizontal: 0 },
}
let undo: Draft[] = []
let redo: Draft[] = []
let files: VideoFile[] = []
let showingResult = false
let previewReady = false
let exporting = false
let uploadingBackground = false
let sourceVersion = 0
let previewSource = ''
const saved = new Map<
  string,
  { draft: Draft; undo: Draft[]; redo: Draft[]; output: string }
>()
let renderedLayout: Draft['layout'] = 'single'
const layoutOne = element('layout-one-region', 'button')
const layoutTwo = element('layout-two-regions', 'button')
const stackGap = element('stack-gap', 'input')
const stackGapSlider = element('stack-gap-slider', 'input')
const outputAspect = element('output-aspect', 'select')
const regionScale = element('region-scale', 'input')
const regionScaleSlider = element('region-scale-slider', 'input')
const regionOutputX = element('region-output-x', 'input')
const regionOutputY = element('region-output-y', 'input')
const backgroundColor = element('background-color', 'input')
const backgroundImageInput = element('background-image', 'input')
const frameTarget = element('frame-target', 'select')
const frameColor = element('frame-color', 'input')
const frameWidth = element('frame-width', 'input')
for (const preset of OUTPUT_PRESETS) {
  const option = create('option', '', preset.label)
  option.value = preset.id
  outputAspect.append(option)
}
const compositionView = bindCompositionView({
  video,
  sourceFrame: frame,
  metadata: () => metadata,
  value: currentComposition,
  selected: () => draft.activeRegion,
  canEdit: () => !exporting && previewReady && currentComposition() !== null,
  ready: () => previewReady,
  remember,
  update: (value) => {
    draft.composition = value
    renderCrop()
  },
  select: (index) => {
    draft.activeRegion = index
    renderCrop()
  },
  onError: message,
})

function currentComposition(): Composition | null {
  return draft.layout === 'stacked' ? draft.composition : null
}

function setLayoutDisabled(disabled: boolean): void {
  layoutOne.disabled = disabled
  layoutTwo.disabled = disabled
}

function aspectRatioLabel(width: number, height: number): string {
  const preset = OUTPUT_PRESETS.find(
    (candidate) => candidate.width * height === candidate.height * width,
  )
  if (preset !== undefined) return preset.id
  let divisor = width
  let remainder = height
  while (remainder !== 0) {
    const next = divisor % remainder
    divisor = remainder
    remainder = next
  }
  const numerator = width / divisor
  const denominator = height / divisor
  if (numerator <= 50 && denominator <= 50) return `${numerator}:${denominator}`
  return width >= height
    ? `${(width / height).toFixed(2)}:1`
    : `1:${(height / width).toFixed(2)}`
}

function selectedCrop(): Crop {
  const composition = currentComposition()
  return composition === null
    ? draft.crop
    : composition.regions[draft.activeRegion].crop
}

function setSelectedCrop(crop: Crop): void {
  const composition = currentComposition()
  if (composition === null) draft.crop = crop
  else
    draft.composition = updateRegionCrop(composition, draft.activeRegion, crop)
}

function renderCompositionControls(): void {
  const composition = currentComposition()
  const active = composition !== null
  element('preview-pair', 'div').className = active
    ? 'preview-pair has-composition'
    : 'preview-pair'
  element('workspace', 'div').className = active
    ? 'workspace composition-mode'
    : 'workspace'
  element('output-panel', 'section').hidden = !active
  element('composition-settings', 'section').hidden = !active
  element('composition-appearance', 'details').hidden = !active
  element('single-preview-controls', 'div').hidden = active
  element('single-crop-options', 'div').hidden = active
  element('region-draw-actions', 'div').hidden = !active
  element('region-selector', 'div').hidden = !active
  element('source-bounds-label', 'summary').hidden = !active
  element('crop-heading', 'h2').textContent = active ? 'Source regions' : 'Crop'
  element('preview-heading', 'h2').textContent = active ? 'Source' : 'Preview'
  element('reset-crop', 'button').textContent = active
    ? 'Reset region'
    : 'Reset crop'
  layoutOne.setAttribute('aria-pressed', String(draft.layout === 'single'))
  layoutTwo.setAttribute('aria-pressed', String(draft.layout === 'stacked'))
  if (renderedLayout !== draft.layout) {
    element('source-bounds', 'details').open = !active
    renderedLayout = draft.layout
    compositionView.cancelDrawing()
  }
  if (composition !== null) {
    const region = composition.regions[draft.activeRegion]
    outputAspect.value = draft.outputPreset
    element('output-aspect-label', 'span').textContent = draft.outputPreset
    element('output-aspect-label', 'span').title =
      `${composition.width} × ${composition.height}`
    element('stack-vertical', 'button').setAttribute(
      'aria-pressed',
      String(draft.stackDirection === 'vertical'),
    )
    element('stack-horizontal', 'button').setAttribute(
      'aria-pressed',
      String(draft.stackDirection === 'horizontal'),
    )
    element('stack-gap-label', 'label').textContent =
      draft.stackDirection === 'vertical' ? 'Vertical gap' : 'Horizontal gap'
    stackGap.max = String(maxStackGap(composition, draft.stackDirection))
    stackGapSlider.max = stackGap.max
    stackGap.value = String(
      normalizeStackGap(
        composition,
        draft.stackDirection,
        draft.stackGaps[draft.stackDirection],
      ),
    )
    stackGapSlider.value = stackGap.value
    regionScale.value = String(Number((region.scale * 100).toFixed(2)))
    regionScaleSlider.value = regionScale.value
    regionOutputX.value = String(region.x)
    regionOutputY.value = String(region.y)
    backgroundColor.value = composition.background
    element('background-color-label', 'span').textContent =
      composition.background
    element('remove-background', 'button').hidden =
      composition.backgroundImage === undefined
    if (!uploadingBackground)
      element('background-name', 'p').textContent =
        composition.backgroundImage === undefined
          ? 'PNG, JPG or WebP. The image fills the canvas.'
          : `${draft.backgroundLabel || 'Background image'} · Fills the canvas`
    frameTarget.value = composition.frame?.target ?? 'none'
    frameColor.value = composition.frame?.color ?? '#ffffff'
    frameWidth.value = String(composition.frame?.width ?? 8)
    element('frame-options', 'div').hidden = composition.frame === undefined
    for (const index of [0, 1] as const) {
      element(`select-region-${index + 1}`, 'button').setAttribute(
        'aria-pressed',
        String(draft.activeRegion === index),
      )
    }
  }
}

function message(error: unknown): void {
  const notice = element('notice', 'div')
  notice.textContent = error instanceof Error ? error.message : String(error)
  notice.hidden = false
}
function clearMessage(): void {
  element('notice', 'div').hidden = true
}
function attempt(action: () => void): void {
  try {
    clearMessage()
    action()
  } catch (error: unknown) {
    message(error)
  }
}
function remember(): void {
  undo.push(structuredClone(draft))
  if (undo.length > 100) undo.shift()
  redo = []
  element('export-result', 'div').hidden = true
  renderHistory()
}
function renderHistory(): void {
  element('undo', 'button').disabled =
    exporting || uploadingBackground || undo.length === 0
  element('redo', 'button').disabled =
    exporting || uploadingBackground || redo.length === 0
}
function restoreHistory(from: Draft[], to: Draft[]): void {
  const previous = from.pop()
  if (previous === undefined) return
  to.push(structuredClone(draft))
  draft = previous
  element('export-result', 'div').hidden = true
  render()
}
function sizeLabel(bytes: number): string {
  return bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
    : `${(bytes / 1_000_000).toFixed(1)} MB`
}
function renderFiles(): void {
  const list = element('file-list', 'ul')
  list.replaceChildren()
  for (const file of files) {
    const item = create('li', '', '')
    const button = create('button', 'file-button', '')
    button.setAttribute('aria-current', String(metadata?.name === file.name))
    button.title = file.name
    button.disabled = exporting || uploadingBackground
    const icon = create('span', 'file-icon', '▶')
    icon.setAttribute('aria-hidden', 'true')
    const info = create('span', 'file-info', '')
    info.append(
      create('span', 'file-name', file.name),
      create('span', 'file-size', sizeLabel(file.size)),
    )
    button.append(icon, info)
    button.addEventListener('click', () => {
      void selectVideo(file.name).catch(message)
    })
    item.append(button)
    list.append(item)
  }
  element('file-count', 'span').textContent = String(files.length)
  element('files-empty', 'div').hidden = files.length !== 0
}
async function refreshFiles(): Promise<void> {
  const button = element('refresh', 'button')
  button.disabled = true
  clearMessage()
  try {
    const response = await api<{ videos: VideoFile[] }>('/api/videos')
    files = response.videos
    renderFiles()
  } finally {
    button.disabled = false
    element('files-loading', 'div').hidden = true
  }
}
async function shutDown(): Promise<void> {
  const button = element('shutdown', 'button')
  const label = element('shutdown-label', 'span')
  button.disabled = true
  label.textContent = 'Shutting down…'
  clearMessage()
  try {
    await api('/api/shutdown', {})
  } catch (error: unknown) {
    button.disabled = false
    label.textContent = 'Shut down studio'
    throw error
  }
  label.textContent = 'Studio stopped'
  setTimeout(() => window.location.reload(), 2_000)
}
async function selectVideo(name: string): Promise<void> {
  if (exporting || uploadingBackground) return
  const version = ++sourceVersion
  clearMessage()
  if (name === metadata?.name && previewReady) {
    render()
    return
  }
  video.pause()
  element('workspace-status', 'span').textContent = `Opening ${name}…`
  let next: VideoMetadata
  try {
    next = await api<VideoMetadata>(
      `/api/video?name=${encodeURIComponent(name)}`,
    )
  } catch (error: unknown) {
    if (version !== sourceVersion) return
    render()
    throw error
  }
  if (version !== sourceVersion) return
  if (metadata !== null)
    saved.set(metadata.name, {
      draft: structuredClone(draft),
      undo,
      redo,
      output: outputName.value,
    })
  previewReady = false
  element('play', 'button').disabled = true
  metadata = next
  const previous = saved.get(name)
  draft =
    previous === undefined
      ? {
          segments: [{ start: 0, end: metadata.duration }],
          crop: fullCrop(metadata),
          selected: 0,
          aspect: 'free',
          muted: false,
          layout: 'single',
          composition: null,
          activeRegion: 0,
          outputPreset: '9:16',
          backgroundLabel: '',
          stackDirection: 'vertical',
          stackGaps: { vertical: 0, horizontal: 0 },
        }
      : structuredClone(previous.draft)
  undo = previous === undefined ? [] : previous.undo
  redo = previous === undefined ? [] : previous.redo
  outputName.value =
    previous === undefined
      ? `${name.replace(/\.[^.]+$/, '')}-edited.mp4`
      : previous.output
  showingResult = false
  element('empty-workspace', 'div').hidden = true
  element('workspace', 'div').hidden = false
  element('preview-loading', 'div').hidden = false
  element('preview-loading', 'div').replaceChildren(
    document.createTextNode('Preparing a browser preview…'),
    create('small', '', 'Large videos may take a moment.'),
  )
  element('export-result', 'div').hidden = true
  scrubber.max = String(metadata.duration)
  scrubber.value = '0'
  const canvas = element('filmstrip', 'canvas')
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  previewSource = new URL(
    `/api/preview?name=${encodeURIComponent(name)}`,
    window.location.href,
  ).href
  video.src = previewSource
  renderFiles()
  render()
  renderTime()
}
function ratio(): number | null {
  if (
    currentComposition() !== null ||
    draft.aspect === 'free' ||
    metadata === null
  )
    return null
  return draft.aspect === 'original'
    ? metadata.width / metadata.height
    : Number(draft.aspect)
}
function renderFrame(): void {
  if (metadata === null) return
  const cropped = showingResult && currentComposition() === null
  const width = cropped ? draft.crop.width : metadata.width
  const height = cropped ? draft.crop.height : metadata.height
  element('source-aspect-label', 'span').textContent = aspectRatioLabel(
    width,
    height,
  )
  element('source-aspect-label', 'span').title = `${width} × ${height}`
  const scale = Math.min(
    (stage.clientWidth - 32) / width,
    (stage.clientHeight - 32) / height,
  )
  frame.style.width = `${width * scale}px`
  frame.style.height = `${height * scale}px`
  video.style.width = `${metadata.width * scale}px`
  video.style.height = `${metadata.height * scale}px`
  video.style.left = `${cropped ? -draft.crop.x * scale : 0}px`
  video.style.top = `${cropped ? -draft.crop.y * scale : 0}px`
  cropBox.hidden = cropped || currentComposition() !== null
  cropBox.style.left = `${draft.crop.x * scale}px`
  cropBox.style.top = `${draft.crop.y * scale}px`
  cropBox.style.width = `${draft.crop.width * scale}px`
  cropBox.style.height = `${draft.crop.height * scale}px`
  element('crop-size', 'span').textContent =
    `${draft.crop.width} × ${draft.crop.height}`
  element('view-source', 'button').setAttribute(
    'aria-pressed',
    String(!showingResult),
  )
  element('view-result', 'button').setAttribute(
    'aria-pressed',
    String(showingResult),
  )
  compositionView.render()
}
function renderCrop(): void {
  const crop = selectedCrop()
  for (const key of ['x', 'y', 'width', 'height'] as const)
    cropFields[key].value = String(crop[key])
  aspect.value = draft.aspect
  const output = currentComposition() ?? draft.crop
  element('output-resolution', 'dd').textContent =
    `${output.width} × ${output.height}`
  renderCompositionControls()
  renderFrame()
}
function renderTime(): void {
  element('current-time', 'span').textContent = formatTime(video.currentTime)
  element('output-current-time', 'span').textContent = formatTime(
    outputTime(draft.segments, video.currentTime),
  )
  scrubber.value = String(video.currentTime)
  if (metadata !== null)
    element('playhead', 'div').style.left =
      `${(100 * video.currentTime) / metadata.duration}%`
  compositionView.drawOutput()
}
function seek(time: number): void {
  if (metadata === null || !previewReady) return
  video.currentTime = Math.max(0, Math.min(metadata.duration, time))
  renderTime()
}
function selectClip(index: number, movePlayhead: boolean): void {
  draft.selected = index
  const segment = draft.segments[index]
  if (segment !== undefined && movePlayhead) seek(segment.start)
  renderTimeline()
}
function renderTimeline(): void {
  if (metadata === null) return
  const duration = metadata.duration
  const clips = element('clips', 'div')
  const list = element('clip-list', 'div')
  clips.replaceChildren()
  list.replaceChildren()
  draft.segments.forEach((segment, index) => {
    const selected = index === draft.selected
    const block = create(
      'div',
      `timeline-clip${selected ? ' selected' : ''}`,
      '',
    )
    block.style.left = `${(segment.start / duration) * 100}%`
    block.style.width = `${((segment.end - segment.start) / duration) * 100}%`
    block.dataset['index'] = String(index)
    block.append(create('span', '', String(index + 1).padStart(2, '0')))
    if (selected) {
      for (const edge of ['start', 'end'] as const) {
        const handle = create('button', `trim-handle ${edge}`, '')
        handle.dataset['edge'] = edge
        handle.dataset['index'] = String(index)
        handle.setAttribute('aria-label', `Trim clip ${index + 1} ${edge}`)
        handle.title = 'Drag to trim; use arrow keys for fine adjustments'
        block.append(handle)
      }
    }
    clips.append(block)
    const chip = create(
      'button',
      'clip-chip',
      `${String(index + 1).padStart(2, '0')}  ${formatTime(segment.start)} – ${formatTime(segment.end)}`,
    )
    chip.setAttribute('aria-pressed', String(selected))
    chip.addEventListener('click', () => selectClip(index, true))
    list.append(chip)
  })
  const selected = draft.segments[draft.selected]
  clipIn.disabled = selected === undefined
  clipOut.disabled = selected === undefined
  clipIn.value =
    selected === undefined ? '' : String(Number(selected.start.toFixed(3)))
  clipOut.value =
    selected === undefined ? '' : String(Number(selected.end.toFixed(3)))
  clipIn.max = String(duration)
  clipOut.max = String(duration)
  element('selected-label', 'span').textContent =
    selected === undefined ? 'No clips kept' : `Clip ${draft.selected + 1}`
  element('remove', 'button').disabled = selected === undefined
  element('set-in', 'button').disabled = selected === undefined || !previewReady
  element('set-out', 'button').disabled =
    selected === undefined || !previewReady
  element('split', 'button').disabled =
    draft.segments.length === 0 || !previewReady || draft.segments.length >= 128
  const total = totalDuration(draft.segments)
  element('kept-summary', 'span').textContent =
    `${draft.segments.length} ${draft.segments.length === 1 ? 'clip' : 'clips'} · ${formatTime(total)} kept`
  element('output-duration', 'dd').textContent = formatTime(total)
  element('output-preview-duration', 'span').textContent = formatTime(total)
  element('output-play', 'button').disabled =
    !previewReady || exporting || draft.segments.length === 0
  element('timeline-ruler', 'div').replaceChildren(
    ...Array.from({ length: 5 }, (_, index) =>
      create('span', '', formatTime((duration * index) / 4)),
    ),
  )
  element('export-button', 'button').disabled =
    exporting || uploadingBackground || draft.segments.length === 0
  renderTime()
}
function render(): void {
  if (metadata === null) return
  renderHistory()
  renderCrop()
  renderTimeline()
  element('reset', 'button').disabled = exporting || uploadingBackground
  keepAudio.checked = metadata.hasAudio && !draft.muted
  keepAudio.disabled = exporting || !metadata.hasAudio
  video.muted = draft.muted || !metadata.hasAudio
  element('audio-encoding', 'span').hidden = draft.muted || !metadata.hasAudio
  element('source-duration', 'span').textContent = formatTime(metadata.duration)
  element('workspace-status', 'span').textContent = previewReady
    ? 'All changes are local · Source file preserved'
    : 'Preparing preview…'
}
function split(): void {
  if (!previewReady || draft.segments.length >= 128) return
  const next = splitClip(draft.segments, video.currentTime)
  remember()
  draft.segments = next
  draft.selected = next.findIndex(
    (segment) => segment.start === video.currentTime,
  )
  render()
}
function removeClip(): void {
  if (draft.segments[draft.selected] === undefined) return
  remember()
  draft.segments.splice(draft.selected, 1)
  draft.selected = Math.max(
    0,
    Math.min(draft.selected, draft.segments.length - 1),
  )
  if (draft.segments.length === 0) video.pause()
  render()
}
function trim(start: number, end: number): void {
  if (metadata === null) return
  const next = trimClip(
    draft.segments,
    draft.selected,
    start,
    end,
    metadata.duration,
  )
  remember()
  draft.segments = next
  render()
}
async function togglePlay(): Promise<void> {
  if (!previewReady) return
  if (!video.paused) {
    video.pause()
    return
  }
  if (previewCuts.checked) {
    let next = nextKeptTime(draft.segments, video.currentTime)
    if (next === null) {
      const first = draft.segments[0]
      if (first === undefined)
        throw new InterfaceError('Keep at least one clip to preview your edit.')
      next = first.start
    }
    seek(next)
  }
  await video.play()
}
function playbackTick(): void {
  if (!video.paused && previewCuts.checked) {
    const next = nextKeptTime(draft.segments, video.currentTime)
    if (next === null) video.pause()
    else if (Math.abs(next - video.currentTime) > 0.02) video.currentTime = next
  }
  renderTime()
  if (!video.paused) requestAnimationFrame(playbackTick)
}

async function waitForVideo(
  target: HTMLVideoElement,
  event: 'loadeddata' | 'seeked',
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new InterfaceError('Timeline preview took too long to load.'))
    }, 30_000)
    const cleanup = (): void => {
      clearTimeout(timer)
      target.removeEventListener(event, done)
      target.removeEventListener('error', failed)
    }
    const done = (): void => {
      cleanup()
      resolve()
    }
    const failed = (): void => {
      cleanup()
      reject(new InterfaceError('Timeline preview could not be loaded.'))
    }
    target.addEventListener(event, done, { once: true })
    target.addEventListener('error', failed, { once: true })
  })
}
async function drawFilmstrip(version: number): Promise<void> {
  if (metadata === null) return
  const duration = metadata.duration
  const source = document.createElement('video')
  source.muted = true
  source.preload = 'auto'
  const loaded = waitForVideo(source, 'loadeddata')
  source.src = video.src
  const canvas = element('filmstrip', 'canvas')
  const context = canvas.getContext('2d')
  if (context === null)
    throw new InterfaceError('Canvas previews are unavailable in this browser.')
  try {
    await loaded
    canvas.width = 1000
    canvas.height = 100
    for (let index = 0; index < 10; index += 1) {
      if (version !== sourceVersion) return
      const sought = waitForVideo(source, 'seeked')
      source.currentTime = (duration * (index + 0.5)) / 10
      await sought
      if (version !== sourceVersion) return
      const cropWidth = Math.min(source.videoWidth, source.videoHeight)
      context.drawImage(
        source,
        (source.videoWidth - cropWidth) / 2,
        (source.videoHeight - cropWidth) / 2,
        cropWidth,
        cropWidth,
        index * 100,
        0,
        100,
        100,
      )
    }
  } finally {
    source.removeAttribute('src')
    source.load()
  }
}

async function exportVideo(): Promise<void> {
  if (
    metadata === null ||
    exporting ||
    uploadingBackground ||
    draft.segments.length === 0
  )
    return
  clearMessage()
  exporting = true
  ++sourceVersion
  video.pause()
  lockExport(true)
  element('export-result', 'div').hidden = true
  element('export-progress', 'div').hidden = false
  element('export-status', 'span').textContent = 'Exporting video…'
  element('progress-bar', 'progress').value = 0
  element('progress-label', 'span').textContent = '0%'
  const composition = currentComposition()
  const edit: EditRequest = {
    source: metadata.name,
    segments: structuredClone(draft.segments),
    crop: { ...draft.crop },
    outputName: outputName.value.trim(),
    muted: draft.muted,
    ...(composition === null
      ? {}
      : { composition: structuredClone(composition) }),
  }
  renderTimeline()
  try {
    const started = await api<{ id: string }>('/api/exports', edit)
    let job = await api<ExportJob>(`/api/exports/${started.id}`)
    while (job.status === 'running') {
      element('progress-bar', 'progress').value = job.progress
      element('progress-label', 'span').textContent =
        `${Math.round(job.progress * 100)}%`
      await new Promise<void>((resolve) => setTimeout(resolve, 400))
      job = await api<ExportJob>(`/api/exports/${started.id}`)
    }
    if (job.status === 'failed' || job.result === undefined) {
      throw new InterfaceError(
        job.error === undefined ? 'Export did not produce a video.' : job.error,
      )
    }
    element('export-progress', 'div').hidden = true
    element('export-file', 'span').textContent =
      `${job.result.name} · ${sizeLabel(job.result.size)}`
    const download = element('download', 'a')
    download.href = `/api/output?name=${encodeURIComponent(job.result.name)}`
    download.download = job.result.name
    element('export-result', 'div').hidden = false
    element('workspace-status', 'span').textContent =
      `Saved to data/output/${job.result.name}`
  } catch (error: unknown) {
    element('export-status', 'span').textContent = 'Export failed'
    message(error)
  } finally {
    exporting = false
    lockExport(false)
    renderTimeline()
  }
}

function lockExport(locked: boolean): void {
  element('editing-column', 'div').inert = locked
  element('crop-settings', 'section').inert = locked
  element('composition-settings', 'section').inert = locked
  element('composition-appearance', 'details').inert = locked
  setLayoutDisabled(locked || uploadingBackground)
  backgroundImageInput.disabled = locked || uploadingBackground
  outputName.disabled = locked
  keepAudio.disabled = locked || metadata?.hasAudio !== true
  element('reset', 'button').disabled = locked
  element('shutdown', 'button').disabled = locked
  renderHistory()
  renderFiles()
}

function changeComposition(change: (value: Composition) => Composition): void {
  const value = currentComposition()
  if (value === null || exporting) return
  const next = change(value)
  remember()
  draft.composition = next
  renderCrop()
}

async function uploadBackground(): Promise<void> {
  const file = backgroundImageInput.files?.[0]
  if (
    file === undefined ||
    currentComposition() === null ||
    exporting ||
    uploadingBackground
  )
    return
  clearMessage()
  if (file.size === 0 || file.size > 20 * 1024 * 1024) {
    message(new InterfaceError('Choose an image between 1 byte and 20 MB.'))
    return
  }
  uploadingBackground = true
  setLayoutDisabled(true)
  backgroundImageInput.disabled = true
  element('choose-background', 'button').disabled = true
  element('remove-background', 'button').disabled = true
  element('reset', 'button').disabled = true
  element('background-name', 'p').textContent = 'Preparing background image…'
  renderHistory()
  renderFiles()
  renderTimeline()
  try {
    const response = await fetch(
      `/api/backgrounds?name=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      },
    )
    const result: unknown = await response.json()
    if (!response.ok) {
      throw new InterfaceError(
        typeof result === 'object' &&
          result !== null &&
          'error' in result &&
          typeof result.error === 'string'
          ? result.error
          : 'Could not upload the background image.',
      )
    }
    if (
      typeof result !== 'object' ||
      result === null ||
      !('name' in result) ||
      typeof result.name !== 'string'
    ) {
      throw new InterfaceError('The background upload did not return an image.')
    }
    const value = currentComposition()
    if (value === null)
      throw new InterfaceError('Choose Two regions before adding a background.')
    remember()
    draft.composition = { ...value, backgroundImage: result.name }
    draft.backgroundLabel = file.name
  } catch (error: unknown) {
    message(error)
  } finally {
    uploadingBackground = false
    setLayoutDisabled(exporting)
    backgroundImageInput.disabled = exporting
    backgroundImageInput.value = ''
    element('choose-background', 'button').disabled = exporting
    element('remove-background', 'button').disabled = exporting
    renderFiles()
    render()
  }
}

function chooseLayout(layout: Draft['layout']): void {
  attempt(() => {
    if (metadata === null || exporting || uploadingBackground) return
    if (draft.layout === layout) return
    remember()
    draft.layout = layout
    if (draft.layout === 'stacked' && draft.composition === null)
      draft.composition = initialComposition(metadata, draft.outputPreset)
    showingResult = false
    render()
  })
}
layoutOne.addEventListener('click', () => chooseLayout('single'))
layoutTwo.addEventListener('click', () => chooseLayout('stacked'))
outputAspect.addEventListener('change', () =>
  attempt(() => {
    const value = currentComposition()
    if (value === null) return
    const next = changePreset(
      value,
      outputAspect.value,
      draft.stackDirection,
      draft.stackGaps[draft.stackDirection],
    )
    remember()
    draft.outputPreset = outputAspect.value
    draft.composition = next
    draft.stackGaps = {
      vertical: normalizeStackGap(next, 'vertical', draft.stackGaps.vertical),
      horizontal: normalizeStackGap(
        next,
        'horizontal',
        draft.stackGaps.horizontal,
      ),
    }
    renderCrop()
  }),
)
element('stack-regions', 'button').addEventListener('click', () =>
  attempt(() =>
    arrangeRegions(
      draft.stackDirection,
      draft.stackGaps[draft.stackDirection],
      true,
    ),
  ),
)
function arrangeRegions(
  direction: StackDirection,
  requestedGap: number,
  record: boolean,
): void {
  const value = currentComposition()
  if (value === null || exporting) return
  const gap = normalizeStackGap(value, direction, requestedGap)
  const next = stackRegions(value, direction, gap)
  if (record) remember()
  draft.stackDirection = direction
  draft.stackGaps[direction] = gap
  draft.composition = next
  renderCrop()
}
for (const direction of ['vertical', 'horizontal'] as const) {
  element(`stack-${direction}`, 'button').addEventListener('click', () =>
    attempt(() => arrangeRegions(direction, draft.stackGaps[direction], true)),
  )
}
stackGap.addEventListener('change', () =>
  attempt(() => {
    try {
      arrangeRegions(draft.stackDirection, stackGap.valueAsNumber, true)
    } finally {
      renderCrop()
    }
  }),
)
let gapGesture = false
stackGapSlider.addEventListener('pointerdown', () => {
  if (currentComposition() === null || exporting) return
  remember()
  gapGesture = true
})
stackGapSlider.addEventListener('input', () =>
  attempt(() =>
    arrangeRegions(
      draft.stackDirection,
      stackGapSlider.valueAsNumber,
      !gapGesture,
    ),
  ),
)
for (const event of ['pointerup', 'pointercancel', 'blur']) {
  stackGapSlider.addEventListener(event, () => {
    gapGesture = false
  })
}
for (const index of [0, 1] as const)
  element(`select-region-${index + 1}`, 'button').addEventListener(
    'click',
    () => {
      draft.activeRegion = index
      renderCrop()
    },
  )
regionScale.addEventListener('change', () =>
  attempt(() => {
    changeComposition((value) =>
      scaleRegion(value, draft.activeRegion, regionScale.valueAsNumber / 100),
    )
  }),
)
let scaleGesture = false
regionScaleSlider.addEventListener('pointerdown', () => {
  if (currentComposition() === null || exporting) return
  scaleGesture = true
  remember()
})
regionScaleSlider.addEventListener('input', () =>
  attempt(() => {
    const value = currentComposition()
    if (value === null || exporting) return
    const next = scaleRegion(
      value,
      draft.activeRegion,
      regionScaleSlider.valueAsNumber / 100,
    )
    if (!scaleGesture) remember()
    draft.composition = next
    renderCrop()
  }),
)
for (const event of ['pointerup', 'pointercancel', 'blur'])
  regionScaleSlider.addEventListener(event, () => {
    scaleGesture = false
  })
for (const input of [regionOutputX, regionOutputY])
  input.addEventListener('change', () =>
    attempt(() => {
      changeComposition((value) =>
        moveRegion(
          value,
          draft.activeRegion,
          regionOutputX.valueAsNumber,
          regionOutputY.valueAsNumber,
        ),
      )
    }),
  )
backgroundColor.addEventListener('change', () =>
  attempt(() =>
    changeComposition((value) => ({
      ...value,
      background: backgroundColor.value,
    })),
  ),
)
element('choose-background', 'button').addEventListener('click', () =>
  backgroundImageInput.click(),
)
backgroundImageInput.addEventListener('change', () => {
  void uploadBackground()
})
element('remove-background', 'button').addEventListener('click', () => {
  changeComposition((value) => {
    const next = { ...value }
    delete next.backgroundImage
    return next
  })
  draft.backgroundLabel = ''
  renderCrop()
})
function changeFrame(): void {
  const target = frameTarget.value
  if (target !== 'none' && target !== 'regions' && target !== 'canvas')
    throw new InterfaceError('Choose a supported frame style.')
  const width = frameWidth.valueAsNumber
  if (target !== 'none' && !Number.isFinite(width))
    throw new InterfaceError('Enter a frame thickness from 1 to 64 pixels.')
  changeComposition((value) => {
    const next = { ...value }
    if (target === 'none') delete next.frame
    else
      next.frame = {
        target,
        color: frameColor.value,
        width: Math.max(1, Math.min(64, Math.round(width))),
      }
    return next
  })
}
for (const input of [frameTarget, frameColor, frameWidth])
  input.addEventListener('change', () => attempt(changeFrame))

element('refresh', 'button').addEventListener('click', () => {
  void refreshFiles().catch(message)
})
element('shutdown', 'button').addEventListener('click', () => {
  void shutDown().catch(message)
})
element('undo', 'button').addEventListener('click', () =>
  restoreHistory(undo, redo),
)
element('redo', 'button').addEventListener('click', () =>
  restoreHistory(redo, undo),
)
element('split', 'button').addEventListener('click', () => attempt(split))
element('remove', 'button').addEventListener('click', removeClip)
element('play', 'button').addEventListener('click', () => {
  void togglePlay().catch(message)
})
element('output-play', 'button').addEventListener('click', () => {
  previewCuts.checked = true
  void togglePlay().catch(message)
})
element('export-button', 'button').addEventListener('click', () => {
  void exportVideo()
})
element('reset', 'button').addEventListener('click', () => {
  if (metadata === null) return
  remember()
  draft = {
    segments: [{ start: 0, end: metadata.duration }],
    crop: fullCrop(metadata),
    selected: 0,
    aspect: 'free',
    muted: false,
    layout: draft.layout,
    composition:
      draft.layout === 'stacked'
        ? initialComposition(metadata, draft.outputPreset)
        : null,
    activeRegion: 0,
    outputPreset: draft.outputPreset,
    backgroundLabel: '',
    stackDirection: 'vertical',
    stackGaps: { vertical: 0, horizontal: 0 },
  }
  render()
})
element('reset-crop', 'button').addEventListener('click', () => {
  if (metadata === null) return
  remember()
  if (currentComposition() !== null) {
    const initial = initialComposition(metadata, draft.outputPreset)
    setSelectedCrop(initial.regions[draft.activeRegion].crop)
  } else {
    draft.crop = fullCrop(metadata)
    draft.aspect = 'free'
  }
  renderCrop()
})
element('view-source', 'button').addEventListener('click', () => {
  showingResult = false
  renderFrame()
})
element('view-result', 'button').addEventListener('click', () => {
  showingResult = true
  renderFrame()
})
element('speed', 'select').addEventListener('change', (event) => {
  if (event.target instanceof HTMLSelectElement)
    video.playbackRate = Number(event.target.value)
})
aspect.addEventListener('change', () => {
  if (metadata === null) return
  remember()
  draft.aspect = aspect.value
  const selectedRatio = ratio()
  if (selectedRatio !== null) draft.crop = aspectCrop(metadata, selectedRatio)
  renderCrop()
})
for (const key of ['x', 'y', 'width', 'height'] as const) {
  cropFields[key].addEventListener('change', () =>
    attempt(() => {
      if (metadata === null) return
      const value = cropFields[key].valueAsNumber
      if (!Number.isFinite(value)) {
        renderCrop()
        throw new InterfaceError('Enter a crop size or position in pixels.')
      }
      const crop = { ...selectedCrop(), [key]: value }
      const selectedRatio = ratio()
      if (selectedRatio !== null && key === 'width')
        crop.height = even(value / selectedRatio)
      if (selectedRatio !== null && key === 'height')
        crop.width = even(value * selectedRatio)
      remember()
      setSelectedCrop(fitCrop(crop, metadata, selectedRatio))
      renderCrop()
    }),
  )
}
keepAudio.addEventListener('change', () => {
  remember()
  draft.muted = !keepAudio.checked
  render()
})
for (const input of [clipIn, clipOut])
  input.addEventListener('change', () =>
    attempt(() => trim(clipIn.valueAsNumber, clipOut.valueAsNumber)),
  )
element('set-in', 'button').addEventListener('click', () =>
  attempt(() => trim(video.currentTime, clipOut.valueAsNumber)),
)
element('set-out', 'button').addEventListener('click', () =>
  attempt(() => trim(clipIn.valueAsNumber, video.currentTime)),
)
scrubber.addEventListener('input', () => seek(scrubber.valueAsNumber))
video.addEventListener('loadeddata', () => {
  if (video.currentSrc !== previewSource || video.readyState < 2) return
  previewReady = true
  element('preview-loading', 'div').hidden = true
  element('play', 'button').disabled = false
  render()
  const version = sourceVersion
  void drawFilmstrip(version).catch((error: unknown) => {
    if (version === sourceVersion) message(error)
  })
})
video.addEventListener('error', () => {
  if (video.currentSrc !== previewSource) return
  previewReady = false
  element('play', 'button').disabled = true
  element('output-play', 'button').disabled = true
  const loading = element('preview-loading', 'div')
  loading.hidden = false
  loading.textContent =
    'Could not prepare this video. Refresh the page to retry, or choose another source.'
  message(
    'Video preview failed. Check that the source is a readable video and FFmpeg is still available.',
  )
})
video.addEventListener('timeupdate', renderTime)
video.addEventListener('play', () => {
  element('play', 'button').setAttribute('aria-label', 'Pause video')
  document.getElementById('play-icon')?.setAttribute('d', 'M8 5v14M16 5v14')
  element('output-play-label', 'span').textContent = 'Pause output'
  document
    .getElementById('output-play-icon')
    ?.setAttribute('d', 'M8 5v14M16 5v14')
  requestAnimationFrame(playbackTick)
})
video.addEventListener('pause', () => {
  element('play', 'button').setAttribute('aria-label', 'Play video')
  document.getElementById('play-icon')?.setAttribute('d', 'm8 5 11 7-11 7z')
  element('output-play-label', 'span').textContent = 'Play output'
  document
    .getElementById('output-play-icon')
    ?.setAttribute('d', 'm8 5 11 7-11 7z')
})
bindCrop({
  box: cropBox,
  frame,
  metadata: () => (currentComposition() === null ? metadata : null),
  crop: () => draft.crop,
  ratio,
  remember,
  update: (crop) => {
    draft.crop = crop
    renderCrop()
  },
})
new ResizeObserver(renderFrame).observe(stage)

track.addEventListener('pointerdown', (event) => {
  if (
    metadata === null ||
    event.button !== 0 ||
    !(event.target instanceof HTMLElement)
  )
    return
  const target = event.target
  const clip = target.closest<HTMLElement>('[data-index]')
  const bounds = track.getBoundingClientRect()
  const duration = metadata.duration
  if (clip !== null) draft.selected = Number(clip.dataset['index'])
  const edge = target.dataset['edge']
  if (edge !== 'start' && edge !== 'end') {
    seek(((event.clientX - bounds.left) / bounds.width) * duration)
    renderTimeline()
    return
  }
  event.preventDefault()
  const selected = draft.segments[draft.selected]
  if (selected === undefined) return
  const initial = structuredClone(draft.segments)
  const initialX = event.clientX
  const index = draft.selected
  const previous = initial[index - 1]
  const next = initial[index + 1]
  remember()
  const move = (current: PointerEvent): void => {
    const delta = ((current.clientX - initialX) / bounds.width) * duration
    const start =
      edge === 'start'
        ? Math.max(
            previous === undefined ? 0 : previous.end,
            Math.min(selected.end - MIN_CLIP - 0.001, selected.start + delta),
          )
        : selected.start
    const end =
      edge === 'end'
        ? Math.min(
            next === undefined ? duration : next.start,
            Math.max(selected.start + MIN_CLIP + 0.001, selected.end + delta),
          )
        : selected.end
    draft.segments = trimClip(initial, index, start, end, duration)
    seek(edge === 'start' ? start : end)
    renderTimeline()
  }
  const stop = (): void => {
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
  document.addEventListener('pointercancel', stop)
})
track.addEventListener('keydown', (event) => {
  if (
    !(event.target instanceof HTMLElement) ||
    (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
  )
    return
  const edge = event.target.dataset['edge']
  if (edge === undefined) return
  event.preventDefault()
  const segment = draft.segments[draft.selected]
  if (segment === undefined) return
  const delta =
    (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.05)
  attempt(() =>
    trim(
      segment.start + (edge === 'start' ? delta : 0),
      segment.end + (edge === 'end' ? delta : 0),
    ),
  )
  track.querySelector<HTMLButtonElement>(`[data-edge='${edge}']`)?.focus()
})
document.addEventListener('keydown', (event) => {
  if (
    event.target instanceof HTMLElement &&
    (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'].includes(
      event.target.tagName,
    ) ||
      event.target.isContentEditable)
  )
    return
  if (metadata === null || exporting || uploadingBackground) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) restoreHistory(redo, undo)
    else restoreHistory(undo, redo)
    return
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (event.code === 'Space') {
    event.preventDefault()
    void togglePlay().catch(message)
  }
  if (event.key.toLowerCase() === 's') attempt(split)
  if (event.key.toLowerCase() === 'i')
    attempt(() => trim(video.currentTime, clipOut.valueAsNumber))
  if (event.key.toLowerCase() === 'o')
    attempt(() => trim(clipIn.valueAsNumber, video.currentTime))
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    removeClip()
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    seek(
      video.currentTime +
        (event.key === 'ArrowRight' ? 1 : -1) *
          (event.shiftKey ? 1 : 1 / metadata.fps),
    )
  }
})
window.addEventListener('beforeunload', (event) => {
  if (exporting) event.preventDefault()
})
void refreshFiles().catch(message)

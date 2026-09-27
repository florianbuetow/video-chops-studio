import { readFileSync } from 'node:fs'

import { vi } from 'vitest'

type Listener = (event: BrowserEvent) => void

export class BrowserEvent {
  readonly type: string
  readonly bubbles: boolean
  readonly button: number
  readonly pointerId: number
  readonly clientX: number
  readonly clientY: number
  readonly key: string
  readonly code: string
  readonly shiftKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  target: BrowserEventTarget | null = null
  currentTarget: BrowserEventTarget | null = null
  defaultPrevented = false
  propagationStopped = false

  constructor(
    type: string,
    options: Partial<
      Pick<
        BrowserEvent,
        | 'bubbles'
        | 'button'
        | 'pointerId'
        | 'clientX'
        | 'clientY'
        | 'key'
        | 'code'
        | 'shiftKey'
        | 'metaKey'
        | 'ctrlKey'
        | 'altKey'
      >
    > = {},
  ) {
    this.type = type
    this.bubbles = options.bubbles ?? false
    this.button = options.button ?? 0
    this.pointerId = options.pointerId ?? 1
    this.clientX = options.clientX ?? 0
    this.clientY = options.clientY ?? 0
    this.key = options.key ?? ''
    this.code = options.code ?? ''
    this.shiftKey = options.shiftKey ?? false
    this.metaKey = options.metaKey ?? false
    this.ctrlKey = options.ctrlKey ?? false
    this.altKey = options.altKey ?? false
  }

  preventDefault(): void {
    this.defaultPrevented = true
  }

  stopPropagation(): void {
    this.propagationStopped = true
  }
}

export class BrowserEventTarget {
  parentElement: BrowserElement | null = null
  private readonly listeners = new Map<
    string,
    Array<{ readonly listener: Listener; readonly once: boolean }>
  >()

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | Listener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const callback =
      typeof listener === 'function'
        ? (listener as Listener)
        : (event: BrowserEvent) =>
            listener.handleEvent(event as unknown as Event)
    const once = typeof options === 'object' && options.once === true
    const entries = this.listeners.get(type) ?? []
    entries.push({ listener: callback, once })
    this.listeners.set(type, entries)
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | Listener,
  ): void {
    const entries = this.listeners.get(type)
    if (entries === undefined) return
    this.listeners.set(
      type,
      entries.filter((entry) => entry.listener !== listener),
    )
  }

  dispatchEvent(event: Event | BrowserEvent): boolean {
    const browserEvent = event as BrowserEvent
    browserEvent.target ??= this
    browserEvent.currentTarget = this
    const entries = [...(this.listeners.get(browserEvent.type) ?? [])]
    for (const entry of entries) {
      entry.listener(browserEvent)
      if (entry.once) {
        const current = this.listeners.get(browserEvent.type) ?? []
        this.listeners.set(
          browserEvent.type,
          current.filter((candidate) => candidate !== entry),
        )
      }
    }
    if (
      browserEvent.bubbles &&
      !browserEvent.propagationStopped &&
      this.parentElement !== null
    ) {
      this.parentElement.dispatchEvent(browserEvent)
    }
    return !browserEvent.defaultPrevented
  }
}

class BrowserText extends BrowserEventTarget {
  constructor(readonly data: string) {
    super()
  }
}

export class BrowserElement extends BrowserEventTarget {
  readonly tagName: string
  readonly style: Record<string, string> = {}
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  children: Array<BrowserElement | BrowserText> = []
  id = ''
  className = ''
  hidden = false
  disabled = false
  checked = false
  inert = false
  isContentEditable = false
  title = ''
  value = ''
  min = ''
  max = ''
  step = ''
  href = ''
  download = ''
  clientWidth = 960
  clientHeight = 540
  private content = ''

  constructor(tagName: string) {
    super()
    this.tagName = tagName.toUpperCase()
  }

  get textContent(): string {
    return (
      this.content +
      this.children
        .map((child) =>
          child instanceof BrowserText ? child.data : child.textContent,
        )
        .join('')
    )
  }

  set textContent(value: string) {
    this.content = value
    this.children = []
  }

  get valueAsNumber(): number {
    return this.value === '' ? Number.NaN : Number(this.value)
  }

  append(...nodes: Array<BrowserElement | BrowserText | string>): void {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new BrowserText(node) : node
      child.parentElement = this
      this.children.push(child)
    }
  }

  replaceChildren(...nodes: Array<BrowserElement | BrowserText>): void {
    this.content = ''
    this.children = []
    this.append(...nodes)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
    if (name === 'class') this.className = value
    if (name === 'id') this.id = value
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5)] = value
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  click(): void {
    if (!this.disabled && !this.inert) {
      this.dispatchEvent(new BrowserEvent('click', { bubbles: true }))
    }
  }

  focus(): void {
    browserDocument.activeElement = this
  }

  setPointerCapture(_pointerId: number): void {}

  closest<T extends BrowserElement>(selector: string): T | null {
    if (selector === '[data-index]') {
      if (this.dataset['index'] !== undefined) return this as unknown as T
      return this.parentElement?.closest<T>(selector) ?? null
    }
    return null
  }

  querySelector<T extends BrowserElement>(selector: string): T | null {
    const edge = selector.match(/^\[data-edge='([^']+)'\]$/u)?.[1]
    const className = selector.startsWith('.') ? selector.slice(1) : undefined
    for (const child of this.children) {
      if (!(child instanceof BrowserElement)) continue
      if (edge !== undefined && child.dataset['edge'] === edge)
        return child as T
      if (
        className !== undefined &&
        child.className.split(' ').includes(className)
      ) {
        return child as T
      }
      const nested = child.querySelector<T>(selector)
      if (nested !== null) return nested
    }
    return null
  }

  getBoundingClientRect(): DOMRect {
    const styledWidth = Number.parseFloat(this.style['width'] ?? '')
    const styledHeight = Number.parseFloat(this.style['height'] ?? '')
    const width =
      this.id === 'timeline-track'
        ? 1000
        : Number.isFinite(styledWidth)
          ? styledWidth
          : this.clientWidth
    const height =
      this.id === 'timeline-track'
        ? 62
        : Number.isFinite(styledHeight)
          ? styledHeight
          : this.clientHeight
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }
  }
}

class BrowserInput extends BrowserElement {
  files: FileList | null = null

  constructor() {
    super('input')
  }
}

class BrowserSelect extends BrowserElement {
  constructor() {
    super('select')
  }
}

class BrowserCanvas extends BrowserElement {
  width = 300
  height = 150

  constructor(private readonly fixture: BrowserFixture) {
    super('canvas')
  }

  getContext(_kind: string): CanvasRenderingContext2D | null {
    if (!this.fixture.canvasAvailable) return null
    const context = {
      clearRect: this.fixture.canvasClear,
      drawImage: this.fixture.canvasDraw,
      fillRect: this.fixture.canvasFill,
    } as unknown as CanvasRenderingContext2D
    Object.defineProperties(context, {
      fillStyle: {
        get: () => this.fixture.canvasFillStyles.at(-1) ?? '#000000',
        set: (value: string) => this.fixture.canvasFillStyles.push(value),
      },
    })
    return context
  }
}

class BrowserImage extends BrowserElement {
  complete = false
  naturalWidth = 0
  naturalHeight = 0
  currentSrc = ''
  private source = ''

  constructor(private readonly fixture: BrowserFixture) {
    super('img')
  }

  get src(): string {
    return this.source
  }

  set src(value: string) {
    this.source = value
    this.currentSrc = new URL(value, this.fixture.location.href).href
    this.complete = false
    this.naturalWidth = 0
    this.naturalHeight = 0
    if (!this.fixture.autoLoadImages) return
    queueMicrotask(() => {
      if (this.source !== value) return
      this.complete = true
      if (this.fixture.failingImages.some((name) => value.includes(name))) {
        this.dispatchEvent(new BrowserEvent('error'))
        return
      }
      this.naturalWidth = this.fixture.imageWidth
      this.naturalHeight = this.fixture.imageHeight
      this.dispatchEvent(new BrowserEvent('load'))
    })
  }
}

export class BrowserVideo extends BrowserElement {
  muted = false
  paused = true
  playbackRate = 1
  preload = ''
  playsInline = true
  readyState = 0
  videoWidth = 640
  videoHeight = 360
  currentSrc = ''
  private source = ''
  private time = 0

  constructor(private readonly fixture: BrowserFixture) {
    super('video')
  }

  get src(): string {
    return this.source
  }

  set src(value: string) {
    this.source = value
    this.currentSrc = new URL(value, this.fixture.location.href).href
    this.readyState = 0
    if (!this.fixture.autoLoadMedia) return
    queueMicrotask(() => {
      if (this.source !== value) return
      if (
        this.fixture.failingMedia.some((name) => value.includes(name)) ||
        (this.id === '' && this.fixture.failFilmstrip)
      ) {
        this.dispatchEvent(new BrowserEvent('error'))
        return
      }
      this.readyState = 4
      this.dispatchEvent(new BrowserEvent('loadeddata'))
    })
  }

  get currentTime(): number {
    return this.time
  }

  set currentTime(value: number) {
    this.time = value
    queueMicrotask(() => {
      this.dispatchEvent(new BrowserEvent('seeked'))
      this.dispatchEvent(new BrowserEvent('timeupdate'))
    })
  }

  async play(): Promise<void> {
    this.paused = false
    this.dispatchEvent(new BrowserEvent('play'))
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    this.dispatchEvent(new BrowserEvent('pause'))
  }

  load(): void {}

  override removeAttribute(name: string): void {
    super.removeAttribute(name)
    if (name === 'src') {
      this.source = ''
      this.currentSrc = ''
    }
  }
}

class BrowserDocument extends BrowserEventTarget {
  readonly elements = new Map<string, BrowserElement>()
  activeElement: BrowserElement | null = null
  fixture: BrowserFixture | undefined

  getElementById(id: string): BrowserElement | null {
    return this.elements.get(id) ?? null
  }

  createElement(tag: string): BrowserElement {
    if (this.fixture === undefined)
      throw new Error('browser fixture is not ready')
    return makeElement(tag, this.fixture)
  }

  createTextNode(text: string): BrowserText {
    return new BrowserText(text)
  }
}

let browserDocument = new BrowserDocument()

interface VideoMetadata {
  readonly name: string
  readonly size: number
  readonly width: number
  readonly height: number
  readonly duration: number
  readonly fps: number
  readonly hasAudio: boolean
}

interface ExportState {
  readonly id: string
  readonly status: 'running' | 'complete' | 'failed'
  readonly progress: number
  readonly result?: {
    readonly name: string
    readonly duration: number
    readonly width: number
    readonly height: number
    readonly size: number
  }
  readonly error?: string
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined
  let rejectPromise: (error: Error) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeElement(tag: string, fixture: BrowserFixture): BrowserElement {
  if (tag === 'input') return new BrowserInput()
  if (tag === 'select') return new BrowserSelect()
  if (tag === 'video') return new BrowserVideo(fixture)
  if (tag === 'canvas') return new BrowserCanvas(fixture)
  if (tag === 'img') return new BrowserImage(fixture)
  return new BrowserElement(tag)
}

function applyAttributes(element: BrowserElement, attributes: string): void {
  for (const match of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/gu)) {
    const name = match[1]
    if (name === undefined) continue
    const value = match[2] ?? ''
    element.setAttribute(name, value)
    if (name === 'hidden') element.hidden = true
    if (name === 'disabled') element.disabled = true
    if (name === 'checked') element.checked = true
    if (name === 'value') element.value = value
    if (name === 'min') element.min = value
    if (name === 'max') element.max = value
    if (name === 'step') element.step = value
  }
}

function parseElements(fixture: BrowserFixture): void {
  const html = readFileSync('src/web/index.html', 'utf8')
  for (const match of html.matchAll(
    /<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gu,
  )) {
    const tag = match[1]
    const attributes = match[2]
    const id = match[3]
    if (tag === undefined || attributes === undefined || id === undefined)
      continue
    const element = makeElement(tag, fixture)
    applyAttributes(element, attributes)
    element.id = id
    browserDocument.elements.set(id, element)
  }
}

export interface RecordedRequest {
  readonly path: string
  readonly method: string
  readonly body: unknown
}

export class BrowserFixture {
  readonly document: BrowserDocument
  readonly window: BrowserEventTarget & {
    readonly location: { readonly href: string; reload(): void }
  }
  readonly location = { href: 'http://127.0.0.1:43123/', reload: vi.fn() }
  readonly requests: RecordedRequest[] = []
  readonly metadata = new Map<string, VideoMetadata>()
  readonly failingMedia: string[] = []
  readonly failingImages: string[] = []
  files: Array<{ readonly name: string; readonly size: number }> = []
  canvasAvailable = true
  autoLoadMedia = true
  autoLoadImages = true
  failFilmstrip = false
  imageWidth = 1200
  imageHeight = 800
  readonly canvasClear = vi.fn()
  readonly canvasDraw = vi.fn()
  readonly canvasFill = vi.fn()
  readonly canvasFillStyles: string[] = []
  refreshError: string | undefined
  shutdownError: string | undefined
  exportStartError: string | undefined
  backgroundUploadError: string | undefined
  backgroundUpload = {
    name: 'uploaded-background.png',
    width: 1200,
    height: 800,
    url: '/api/backgrounds?name=uploaded-background.png',
  }
  private readonly probeDelays = new Map<string, Deferred<Response>>()
  private readonly exportQueues: ExportState[][] = []
  private readonly jobs = new Map<string, ExportState[]>()
  private readonly animationFrames: FrameRequestCallback[] = []
  private nextJob = 1

  constructor() {
    browserDocument = new BrowserDocument()
    this.document = browserDocument
    this.document.fixture = this
    this.window = Object.assign(new BrowserEventTarget(), {
      location: this.location,
    })
    parseElements(this)
    this.installGlobals()
  }

  element(id: string): BrowserElement {
    const element = this.document.getElementById(id)
    if (element === null) throw new Error(`missing fixture element: ${id}`)
    return element
  }

  find(className: string, root = this.element('file-list')): BrowserElement[] {
    const found: BrowserElement[] = []
    const visit = (element: BrowserElement): void => {
      if (element.className.split(' ').includes(className)) found.push(element)
      for (const child of element.children) {
        if (child instanceof BrowserElement) visit(child)
      }
    }
    visit(root)
    return found
  }

  addVideo(name: string, overrides: Partial<VideoMetadata> = {}): void {
    const metadata: VideoMetadata = {
      name,
      size: 2_000_000,
      width: 640,
      height: 360,
      duration: 10,
      fps: 25,
      hasAudio: true,
      ...overrides,
    }
    this.metadata.set(name, metadata)
    this.files.push({ name, size: metadata.size })
  }

  deferProbe(name: string): Deferred<Response> {
    const pending = deferred<Response>()
    this.probeDelays.set(name, pending)
    return pending
  }

  setFiles(id: string, files: readonly File[]): void {
    const input = this.element(id)
    if (!(input instanceof BrowserInput)) {
      throw new Error(`fixture element is not a file input: ${id}`)
    }
    input.files = [...files] as unknown as FileList
  }

  queueExport(...states: ExportState[]): void {
    this.exportQueues.push(states)
  }

  runAnimationFrame(): void {
    const callbacks = this.animationFrames.splice(0)
    for (const callback of callbacks) callback(performance.now())
  }

  async settle(rounds = 30): Promise<void> {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve()
  }

  event(
    type: string,
    options: ConstructorParameters<typeof BrowserEvent>[1] = {},
  ): BrowserEvent {
    return new BrowserEvent(type, options)
  }

  dispose(): void {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }

  private installGlobals(): void {
    class FixtureResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        this.callback([], this as unknown as ResizeObserver)
        void target
      }
      disconnect(): void {}
      unobserve(_target: Element): void {}
    }
    vi.stubGlobal('document', this.document)
    vi.stubGlobal('window', this.window)
    vi.stubGlobal('HTMLElement', BrowserElement)
    vi.stubGlobal('HTMLInputElement', BrowserInput)
    vi.stubGlobal('HTMLSelectElement', BrowserSelect)
    vi.stubGlobal('HTMLVideoElement', BrowserVideo)
    vi.stubGlobal('HTMLCanvasElement', BrowserCanvas)
    vi.stubGlobal('HTMLImageElement', BrowserImage)
    vi.stubGlobal('Event', BrowserEvent)
    vi.stubGlobal('KeyboardEvent', BrowserEvent)
    vi.stubGlobal('PointerEvent', BrowserEvent)
    vi.stubGlobal('ResizeObserver', FixtureResizeObserver)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      this.animationFrames.push(callback)
      return this.animationFrames.length
    })
    vi.stubGlobal(
      'fetch',
      (input: string | URL | Request, init?: RequestInit) =>
        this.fetch(String(input), init),
    )
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET'
    const body =
      init?.body === undefined
        ? undefined
        : typeof init.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : init.body
    this.requests.push({ path, method, body })
    if (path === '/api/videos') {
      return this.refreshError === undefined
        ? json({ videos: this.files })
        : json({ error: this.refreshError }, 500)
    }
    if (path === '/api/shutdown' && method === 'POST') {
      return this.shutdownError === undefined
        ? json({ status: 'stopping' }, 202)
        : json({ error: this.shutdownError }, 403)
    }
    if (path.startsWith('/api/video?name=')) {
      const name = decodeURIComponent(path.slice('/api/video?name='.length))
      const delayed = this.probeDelays.get(name)
      if (delayed !== undefined) {
        this.probeDelays.delete(name)
        return delayed.promise
      }
      const metadata = this.metadata.get(name)
      return metadata === undefined
        ? json({ error: `video does not exist: ${name}` }, 404)
        : json(metadata)
    }
    if (path.startsWith('/api/backgrounds?name=') && method === 'POST') {
      return this.backgroundUploadError === undefined
        ? json(this.backgroundUpload)
        : json({ error: this.backgroundUploadError }, 400)
    }
    if (path === '/api/exports' && method === 'POST') {
      if (this.exportStartError !== undefined) {
        return json({ error: this.exportStartError }, 409)
      }
      const id = `job-${this.nextJob++}`
      const queued = this.exportQueues.shift() ?? [
        {
          id,
          status: 'complete',
          progress: 1,
          result: {
            name: 'output.mp4',
            duration: 10,
            width: 640,
            height: 360,
            size: 1_500_000,
          },
        },
      ]
      this.jobs.set(
        id,
        queued.map((state) => ({ ...state, id })),
      )
      return json({ id }, 202)
    }
    if (path.startsWith('/api/exports/')) {
      const id = path.slice('/api/exports/'.length)
      const states = this.jobs.get(id)
      if (states === undefined || states.length === 0) {
        return json({ error: 'Export not found' }, 404)
      }
      if (states.length === 1) return json(states[0])
      return json(states.shift())
    }
    return json({ error: `Unexpected request: ${path}` }, 500)
  }
}

export async function loadBrowserApp(
  configure?: (fixture: BrowserFixture) => void,
): Promise<BrowserFixture> {
  vi.resetModules()
  const fixture = new BrowserFixture()
  configure?.(fixture)
  await import('../../src/web/app.js')
  await fixture.settle()
  return fixture
}

export class InterfaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InterfaceError'
  }
}

export function element<K extends keyof HTMLElementTagNameMap>(
  id: string,
  tag: K,
): HTMLElementTagNameMap[K] {
  const node = document.getElementById(id)
  if (node === null || node.tagName.toLowerCase() !== tag) {
    throw new InterfaceError(`Missing ${tag} element: ${id}`)
  }
  return node as HTMLElementTagNameMap[K]
}

export function create<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  )
  const result: unknown = await response.json()
  if (!response.ok) {
    const message =
      typeof result === 'object' &&
      result !== null &&
      'error' in result &&
      typeof result.error === 'string'
        ? result.error
        : `Request failed (${response.status}).`
    throw new InterfaceError(message)
  }
  return result as T
}

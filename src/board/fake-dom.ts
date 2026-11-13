export interface FakeStyle {
  [property: string]: unknown
  setProperty(name: string, value: string): void
}

export interface FakeNode {
  tagName: string
  id: string
  title: string
  style: FakeStyle
  scrollTop: number
  parent: FakeNode | null
  children: FakeNode[]
  text: string
  attributes: Map<string, string>
  className: string
  dataset: Record<string, string>
  hidden: boolean
  disabled: boolean
  checked: boolean
  value: string
  type: string
  placeholder: string
  readOnly: boolean
  tabIndex: number
  inert: boolean
  listeners: Map<string, ((event: FakeEvent) => void)[]>
}

export interface FakeEvent {
  type: string
  key?: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  button?: number
  target?: FakeNode
  defaultPrevented: boolean
  propagationStopped: boolean
  preventDefault(): void
  stopPropagation(): void
}

interface FakeDocument {
  body: FakeElement
  activeElement: FakeNode | null
  createElement(tag: string): FakeElement
  createElementNS(namespace: string, tag: string): FakeElement
  createTextNode(text: string): FakeElement
  createDocumentFragment(): FakeElement
}

let active: FakeDocument | null = null

class FakeElement implements FakeNode {
  id = ''
  title = ''
  style = fakeStyle()
  scrollTop = 0
  parent: FakeElement | null = null
  children: FakeElement[] = []
  text = ''
  attributes = new Map<string, string>()
  className = ''
  dataset: Record<string, string> = {}
  hidden = false
  disabled = false
  checked = false
  value = ''
  type = ''
  placeholder = ''
  readOnly = false
  tabIndex = -1
  inert = false
  listeners = new Map<string, ((event: FakeEvent) => void)[]>()

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return textOf(this)
  }

  set textContent(value: string) {
    this.replaceChildren()
    this.text = value
  }

  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean)
    const add = (...tokens: string[]) => {
      this.className = [...new Set([...names(), ...tokens])].join(' ')
    }
    const remove = (...tokens: string[]) => {
      this.className = names().filter(name => !tokens.includes(name)).join(' ')
    }
    return {
      add,
      remove,
      contains: (token: string) => names().includes(token),
      toggle: (token: string, force?: boolean) => {
        const on = force ?? !names().includes(token)
        if (on) add(token)
        else remove(token)
        return on
      },
    }
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of this.adopt(nodes)) this.children.push(node)
  }

  prepend(...nodes: (FakeElement | string)[]): void {
    this.children = [...this.adopt(nodes), ...this.children]
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    for (const child of this.children) child.parent = null
    this.children = []
    this.text = ''
    this.append(...nodes)
  }

  remove(): void {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value))
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.attributes.has(name)
    if (on) this.attributes.set(name, '')
    else this.attributes.delete(name)
    return on
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  focus(): void {
    if (active) active.activeElement = this
  }

  private adopt(nodes: (FakeElement | string)[]): FakeElement[] {
    const adopted = nodes.flatMap(node => {
      if (typeof node === 'string') return [textNode(node)]
      if (node.tagName !== '#fragment') return [node]
      const moved = node.children
      node.children = []
      for (const child of moved) child.parent = null
      return moved
    })
    for (const node of adopted) {
      node.remove()
      node.parent = this
    }
    return adopted
  }
}

class FakeOption extends FakeElement {
  constructor(text = '', value = text) {
    super('option')
    this.text = text
    this.value = value
  }
}

function fakeStyle(): FakeStyle {
  const style: FakeStyle = {
    setProperty(name: string, value: string) {
      style[name] = value
    },
  }
  return style
}

function textNode(text: string): FakeElement {
  const node = new FakeElement('#text')
  node.text = text
  return node
}

function fakeDocument(): FakeDocument {
  const body = new FakeElement('body')
  return {
    body,
    activeElement: body,
    createElement: tag => new FakeElement(tag.toLowerCase()),
    createElementNS: (_namespace, tag) => new FakeElement(tag),
    createTextNode: textNode,
    createDocumentFragment: () => new FakeElement('#fragment'),
  }
}

export function withFakeDom<T>(run: () => T): T {
  const saved = { document: globalThis.document, Option: globalThis.Option }
  active = fakeDocument()
  Object.assign(globalThis, { document: active, Option: FakeOption })
  const restore = () => {
    Object.assign(globalThis, saved)
    active = null
  }
  let result: T
  try {
    result = run()
  } catch (error) {
    restore()
    throw error
  }
  if (result instanceof Promise) return result.finally(restore) as T
  restore()
  return result
}

export function fire(node: FakeNode, type: string, init: Partial<FakeEvent> = {}): FakeEvent {
  const event: FakeEvent = {
    target: node,
    ...init,
    type,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault: () => {
      event.defaultPrevented = true
    },
    stopPropagation: () => {
      event.propagationStopped = true
    },
  }
  for (let at: FakeNode | null = node; at && !event.propagationStopped; at = at.parent) {
    for (const listener of at.listeners.get(type) ?? []) listener(event)
  }
  return event
}

function* descendants(root: FakeNode): Generator<FakeNode> {
  const pending = [...root.children].reverse()
  for (let node = pending.pop(); node; node = pending.pop()) {
    yield node
    for (let k = node.children.length - 1; k >= 0; k--) pending.push(node.children[k])
  }
}

export function textOf(node: FakeNode): string {
  let text = node.text
  for (const child of descendants(node)) text += child.text
  return text
}

export function findAll(root: FakeNode, match: (node: FakeNode) => boolean): FakeNode[] {
  return [...descendants(root)].filter(match)
}

export function find(root: FakeNode, match: (node: FakeNode) => boolean): FakeNode | undefined {
  for (const node of descendants(root)) if (match(node)) return node
  return undefined
}

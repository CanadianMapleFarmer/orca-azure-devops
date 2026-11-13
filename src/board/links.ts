const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function safeHref(href: string): string | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null
}

export function linkTo(url: string, label: string | Node[], open: (url: string) => void, options: { className?: string; ariaLabel?: string } = {}): HTMLElement {
  const href = safeHref(url)
  const node: HTMLElement = document.createElement(href ? 'a' : 'span')
  if (options.className) node.className = options.className
  if (typeof label === 'string') node.append(document.createTextNode(label))
  else for (const child of label) node.append(child)
  if (!href) return node
  node.setAttribute('role', 'link')
  node.setAttribute('tabindex', '0')
  node.setAttribute('title', href)
  if (options.ariaLabel) node.setAttribute('aria-label', options.ariaLabel)
  node.addEventListener('click', event => {
    event.preventDefault()
    open(href)
  })
  node.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    open(href)
  })
  node.addEventListener('auxclick', event => event.preventDefault())
  return node
}

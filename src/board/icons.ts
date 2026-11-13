import { linkTo } from './links'

const SVG_NS = 'http://www.w3.org/2000/svg'
const ICONS = {
  refresh: ['M13.5 8a5.5 5.5 0 1 1-1.6-3.9', 'M13.5 2.5v3h-3'],
  open: ['M9 2.5h4.5V7', 'M13.5 2.5 7.5 8.5', 'M12 9.5v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H7'],
  close: ['M4 4l8 8M12 4l-8 8'],
  chevron: ['M3 4.5 6 7.5 9 4.5'],
}

export type IconName = keyof typeof ICONS

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', name === 'chevron' ? '0 0 12 12' : '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

export function openIcon(url: string, label: string, open: (url: string) => void): HTMLElement {
  return linkTo(url, [icon('open')], open, { className: 'icon-button', ariaLabel: label })
}

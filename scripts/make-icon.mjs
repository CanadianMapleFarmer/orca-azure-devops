import { mkdirSync, writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'

const SIZE = 256
const SAMPLES = 4
const BACKGROUND = { x: 0, y: 0, width: SIZE, height: SIZE, radius: 48, color: [0x2b, 0x59, 0xc3] }
const WHITE = [255, 255, 255]
const BAR_WIDTH = 36
const BAR_GAP = 20
const BAR_TOP = 60
const BAR_HEIGHTS = [136, 96, 116]
const BAR_LEFT = (SIZE - (BAR_HEIGHTS.length * BAR_WIDTH + (BAR_HEIGHTS.length - 1) * BAR_GAP)) / 2

const shapes = [
  BACKGROUND,
  ...BAR_HEIGHTS.map((height, index) => ({
    x: BAR_LEFT + index * (BAR_WIDTH + BAR_GAP),
    y: BAR_TOP,
    width: BAR_WIDTH,
    height,
    radius: 12,
    color: WHITE
  }))
]

function covers(shape, x, y) {
  const reachX = Math.max(shape.x + shape.radius - x, 0, x - (shape.x + shape.width - shape.radius))
  const reachY = Math.max(shape.y + shape.radius - y, 0, y - (shape.y + shape.height - shape.radius))
  const inside = x >= shape.x && x <= shape.x + shape.width && y >= shape.y && y <= shape.y + shape.height
  return inside && reachX * reachX + reachY * reachY <= shape.radius * shape.radius
}

function pixel(column, row) {
  const sum = [0, 0, 0]
  let covered = 0
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      const top = shapes.findLast(shape => covers(shape, column + (sx + 0.5) / SAMPLES, row + (sy + 0.5) / SAMPLES))
      if (!top) continue
      covered += 1
      for (let channel = 0; channel < 3; channel += 1) sum[channel] += top.color[channel]
    }
  }
  if (covered === 0) return [0, 0, 0, 0]
  return [...sum.map(channel => Math.round(channel / covered)), Math.round((covered * 255) / (SAMPLES * SAMPLES))]
}

function scanlines() {
  const rows = Buffer.alloc(SIZE * (1 + SIZE * 4))
  for (let row = 0; row < SIZE; row += 1) {
    const start = row * (1 + SIZE * 4)
    for (let column = 0; column < SIZE; column += 1) Buffer.from(pixel(column, row)).copy(rows, start + 1 + column * 4)
  }
  return rows
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const framed = Buffer.alloc(body.length + 8)
  framed.writeUInt32BE(data.length, 0)
  body.copy(framed, 4)
  framed.writeUInt32BE(crc32(body), body.length + 4)
  return framed
}

function png() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines(), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const target = new URL('../assets/icon.png', import.meta.url)
mkdirSync(new URL('./', target), { recursive: true })
writeFileSync(target, png())

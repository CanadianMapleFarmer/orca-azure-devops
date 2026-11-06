import * as fs from 'node:fs/promises'
import { assert, test } from 'orca/testing'

interface Screenshot {
  path: string
  alt?: string
}

interface ImageManifest {
  icon?: string
  screenshots?: Screenshot[]
}

interface Size {
  width: number
  height: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IHDR_AT = 8
const JPEG_START = Buffer.from([0xff, 0xd8])
const JPEG_FIRST_SOF = 0xc0
const JPEG_LAST_SOF = 0xc3
const JPEG_STANDALONE = new Set([0x01, 0xd8, ...Array.from({ length: 8 }, (_, index) => 0xd0 + index)])

const MIN_ICON_SIDE = 128
const MAX_ICON_BYTES = 256 * 1024
const MAX_SCREENSHOTS = 6
const MIN_SCREENSHOT = { width: 1280, height: 800 }
const MAX_SCREENSHOT_BYTES = 1536 * 1024
const MAX_IMAGE_BYTES_TOGETHER = 8 * 1024 * 1024

function pngSize(bytes: Buffer): Size {
  assert.equal(bytes.subarray(0, 8).compare(PNG_SIGNATURE), 0, 'a PNG starts with the PNG signature')
  assert.equal(bytes.toString('latin1', PNG_IHDR_AT + 4, PNG_IHDR_AT + 8), 'IHDR', 'the first PNG chunk is IHDR')
  return { width: bytes.readUInt32BE(PNG_IHDR_AT + 8), height: bytes.readUInt32BE(PNG_IHDR_AT + 12) }
}

function jpegSize(bytes: Buffer): Size {
  let at = 2
  while (at + 4 <= bytes.length) {
    assert.equal(bytes[at], 0xff, 'a JPEG segment starts with 0xFF')
    const marker = bytes[at + 1]
    if (marker >= JPEG_FIRST_SOF && marker <= JPEG_LAST_SOF) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) }
    at += JPEG_STANDALONE.has(marker) ? 2 : 2 + bytes.readUInt16BE(at + 2)
  }
  assert.fail('the JPEG has no frame header')
}

function imageSize(bytes: Buffer): Size {
  if (bytes.subarray(0, 8).compare(PNG_SIGNATURE) === 0) return pngSize(bytes)
  if (bytes.subarray(0, 2).compare(JPEG_START) === 0) return jpegSize(bytes)
  assert.fail('an image is a PNG or a JPEG')
}

async function manifestImages(): Promise<{ icon: Buffer | undefined; screenshots: { shot: Screenshot; bytes: Buffer }[] }> {
  const manifest: ImageManifest = JSON.parse(await fs.readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  const read = (path: string) => fs.readFile(new URL(`../${path}`, import.meta.url))
  return {
    icon: manifest.icon === undefined ? undefined : await read(manifest.icon),
    screenshots: await Promise.all((manifest.screenshots ?? []).map(async shot => ({ shot, bytes: await read(shot.path) })))
  }
}

test("the manifest icon and screenshots meet Orca's image rules", async () => {
  const { icon, screenshots } = await manifestImages()
  assert.ok(icon, 'the manifest names an icon')
  const { width, height } = imageSize(icon)
  assert.equal(width, height, 'the icon is square')
  assert.ok(width >= MIN_ICON_SIDE, `the icon is at least ${MIN_ICON_SIDE} px`)
  assert.ok(icon.length <= MAX_ICON_BYTES, `the icon is at most ${MAX_ICON_BYTES / 1024} KB`)
  assert.ok(screenshots.length <= MAX_SCREENSHOTS, `at most ${MAX_SCREENSHOTS} screenshots`)
  for (const { shot, bytes } of screenshots) {
    const size = imageSize(bytes)
    assert.ok(size.width >= MIN_SCREENSHOT.width && size.height >= MIN_SCREENSHOT.height, `${shot.path} is at least ${MIN_SCREENSHOT.width}x${MIN_SCREENSHOT.height}`)
    assert.ok(bytes.length <= MAX_SCREENSHOT_BYTES, `${shot.path} is at most ${MAX_SCREENSHOT_BYTES / 1024} KB`)
    assert.ok(shot.alt?.trim(), `${shot.path} has an alt text`)
  }
  const together = icon.length + screenshots.reduce((sum, { bytes }) => sum + bytes.length, 0)
  assert.ok(together <= MAX_IMAGE_BYTES_TOGETHER, 'all images together are at most 8 MB')
})

test('image headers are read for PNG and JPEG, and any other format is refused', () => {
  const png = Buffer.alloc(24)
  PNG_SIGNATURE.copy(png)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12, 'latin1')
  png.writeUInt32BE(1280, 16)
  png.writeUInt32BE(800, 20)
  assert.deepEqual(imageSize(png), { width: 1280, height: 800 })

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03])
  assert.deepEqual(imageSize(jpeg), { width: 1280, height: 800 })

  assert.throws(() => imageSize(Buffer.from('GIF89a......', 'latin1')), /PNG or a JPEG/)
  assert.throws(() => imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46])), /no frame header/)
})

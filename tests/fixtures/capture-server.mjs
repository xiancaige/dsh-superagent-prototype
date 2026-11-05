/**
 * Test-only MCP capture server (stdio). It is a real MCP server with fixed screenshot tools: the
 * screenshot tool renders a PNG from the requested scenario/state and returns it as image content,
 * writing the bytes to the frame path the caller supplies, exactly as an editor screenshot tool does.
 *
 * A frame reaches the product only through a real MCP call into this server. The product's default
 * endpoint (127.0.0.1:55255) needs the UE editor and is therefore reported as `unavailable` here,
 * never as a pass.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

let table
function crc32(bytes) {
  if (!table) {
    table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
/** PNG bytes of a frame with a marker checkerboard over a background, so a reader sees real pixels. */
function png(width, height, background, marker) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  // Every row starts with its PNG filter byte (0: none); skipping it corrupts the stream.
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const on = ((x >> 3) + (y >> 3)) % 2 === 0 && x > width / 4 && x < width * 3 / 4
      const colour = on ? marker : background
      const at = row + 1 + x * 3
      raw[at] = colour[0]
      raw[at + 1] = colour[1]
      raw[at + 2] = colour[2]
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const server = new McpServer({ name: 'visual-capture-double', version: '0.0.1' })
const MARKER_RED = { red: [255, 0, 0], green: [0, 255, 0], white: [255, 255, 255] }
server.registerTool('capture_screenshot', {
  description: 'Capture a screenshot of the current editor state into a file and return its image.',
  inputSchema: { path: z.string(), scenario: z.string().default('default'), blank: z.boolean().default(false),
    // A second real target of its own, so two captures of different widgets are different images.
    widget: z.string().default(''), size: z.number().int().positive().default(320) },
}, async ({ path, scenario, blank, widget, size }) => {
  const width = size, height = Math.round(size * 9 / 16)
  const marker = MARKER_RED[scenario] ?? [255, 255, 255]
  const bytes = blank ? png(64, 64, [0, 0, 0], [0, 0, 0]) : png(width, height, widget ? [10, 80, 60] : [20, 40, 80], marker)
  // A real screenshot tool creates the file at the path it is given; its directory may be new.
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return { content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
    { type: 'text', text: `captured ${widget || 'editor-window'} ${width}x${height} scenario=${scenario} to ${path}` }] }
})
server.registerTool('not_a_screenshot', { description: 'Returns text only.', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'no image here' }] }))
await server.connect(new StdioServerTransport())

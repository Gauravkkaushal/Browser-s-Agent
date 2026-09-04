import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const iconsDir = path.resolve(__dirname, '../public/icons')

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true })
}

// CRC32 table for PNG chunk checksums
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    if (c & 1) {
      c = 0xedb88320 ^ (c >>> 1)
    } else {
      c = c >>> 1
    }
  }
  crcTable[n] = c
}

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function createPngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)

  const toCrc = Buffer.concat([typeBuf, data])
  const crcVal = crc32(toCrc)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crcVal, 0)

  return Buffer.concat([lenBuf, toCrc, crcBuf])
}

function renderNetraShieldIcon(size) {
  const width = size
  const height = size
  const rawData = Buffer.alloc(height * (1 + width * 4))

  const cx = (width - 1) / 2
  const cy = (height - 1) / 2
  const maxR = size * 0.46

  let offset = 0
  for (let y = 0; y < height; y++) {
    rawData[offset++] = 0 // PNG Filter type: 0 (None)
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / maxR
      const dy = (y - cy) / maxR
      const dist = Math.sqrt(dx * dx + dy * dy)

      // Shield / Orb shape: squircle profile
      const squircle = Math.pow(Math.abs(dx), 2.2) + Math.pow(Math.abs(dy), 2.2)

      if (squircle <= 1.0) {
        // Inside icon shield
        const edgeDist = 1.0 - squircle
        const isBorder = edgeDist < 0.18

        if (isBorder) {
          // Vibrant cyan-indigo glowing rim
          const t = (x + y) / (width + height)
          const r = Math.round(56 + t * 40)   // ~0x38 to 0x60
          const g = Math.round(189 - t * 40)  // ~0xbd to 0x95
          const b = 254                       // electric cyan/blue
          const a = 255
          rawData[offset++] = r
          rawData[offset++] = g
          rawData[offset++] = b
          rawData[offset++] = a
        } else {
          // Dark cyber background with subtle gradient
          let r = 13 + Math.round((1 - dy) * 12)
          let g = 17 + Math.round((1 - dy) * 16)
          let b = 32 + Math.round((1 - dy) * 26)
          let a = 255

          // Stylized "N" or Shield Core Eye in the center
          const nx = (x - cx) / (size * 0.28)
          const ny = (y - cy) / (size * 0.32)

          const inLeftBar = nx >= -0.75 && nx <= -0.35 && Math.abs(ny) <= 0.85
          const inRightBar = nx >= 0.35 && nx <= 0.75 && Math.abs(ny) <= 0.85
          // Diagonal connecting bar
          const diagX = (ny + 0.85) / 1.7 * 1.1 - 0.55
          const inDiag = Math.abs(nx - diagX) <= 0.26 && Math.abs(ny) <= 0.85

          if (inLeftBar || inRightBar || inDiag) {
            // Glowing cyan emblem
            r = 169
            g = 210
            b = 255
          } else if (dist < 0.3) {
            // Subtle ambient central glow
            const glow = (1 - dist / 0.3) * 0.3
            r = Math.min(255, Math.round(r + 56 * glow))
            g = Math.min(255, Math.round(g + 189 * glow))
            b = Math.min(255, Math.round(b + 254 * glow))
          }

          rawData[offset++] = r
          rawData[offset++] = g
          rawData[offset++] = b
          rawData[offset++] = a
        }
      } else if (squircle <= 1.15) {
        // Anti-aliased outer edge
        const alphaFrac = (1.15 - squircle) / 0.15
        rawData[offset++] = 56
        rawData[offset++] = 189
        rawData[offset++] = 254
        rawData[offset++] = Math.round(alphaFrac * 180)
      } else {
        // Transparent outside
        rawData[offset++] = 0
        rawData[offset++] = 0
        rawData[offset++] = 0
        rawData[offset++] = 0
      }
    }
  }

  // Build PNG Buffer
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  // IHDR
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 6 // color type RGBA
  ihdrData[10] = 0 // compression
  ihdrData[11] = 0 // filter
  ihdrData[12] = 0 // interlace
  const ihdrChunk = createPngChunk('IHDR', ihdrData)

  // IDAT (Deflated)
  const compressed = zlib.deflateSync(rawData, { level: 9 })
  const idatChunk = createPngChunk('IDAT', compressed)

  // IEND
  const iendChunk = createPngChunk('IEND', Buffer.alloc(0))

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk])
}

const SIZES = [16, 32, 48, 128]
for (const size of SIZES) {
  const pngBuffer = renderNetraShieldIcon(size)
  const outPath = path.join(iconsDir, `icon-${size}.png`)
  fs.writeFileSync(outPath, pngBuffer)
  console.log(`Generated ${outPath} (${pngBuffer.length} bytes)`)
}
console.log('All NetraShield icons generated successfully.')

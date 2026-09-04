import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('NetraShield Manifest and Icons Verification', () => {
  const manifestPath = path.resolve(__dirname, '../../public/manifest.json')
  const iconsDir = path.resolve(__dirname, '../../public/icons')

  it('contains valid manifest.json with icons declared', () => {
    expect(fs.existsSync(manifestPath)).toBe(true)
    const raw = fs.readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(raw)

    expect(manifest.manifest_version).toBe(3)
    expect(manifest.icons).toBeDefined()
    expect(manifest.icons['16']).toBe('icons/icon-16.png')
    expect(manifest.icons['32']).toBe('icons/icon-32.png')
    expect(manifest.icons['48']).toBe('icons/icon-48.png')
    expect(manifest.icons['128']).toBe('icons/icon-128.png')

    expect(manifest.action.default_icon).toBeDefined()
    expect(manifest.action.default_icon['128']).toBe('icons/icon-128.png')
  })

  it('ensures all icon PNG files exist and are valid PNG binary images', () => {
    const sizes = [16, 32, 48, 128]
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    for (const size of sizes) {
      const iconPath = path.join(iconsDir, `icon-${size}.png`)
      expect(fs.existsSync(iconPath)).toBe(true)

      const buffer = fs.readFileSync(iconPath)
      expect(buffer.length).toBeGreaterThan(100)
      // Check PNG magic number
      expect(buffer.subarray(0, 8)).toEqual(pngSignature)

      // Check IHDR width and height
      const width = buffer.readUInt32BE(16)
      const height = buffer.readUInt32BE(20)
      expect(width).toBe(size)
      expect(height).toBe(size)
    }
  })
})

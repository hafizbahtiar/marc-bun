// Kenal pasti format + dimensi daripada BAIT (tiada decoder). GAGAL-TERTUTUP:
// null = tidak dapat diukur = ditolak. (marc_go: image.DecodeConfig tanpa
// decoder WebP dan `return nil` bila gagal - WebP & fail rosak lepas had
// dimensi. 00001 R9.)

export type ImageInfo = { format: 'jpeg' | 'png' | 'webp'; width: number; height: number }

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))

function jpeg(b: Uint8Array): ImageInfo | null {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]!
    if (marker === 0xff) {
      i++ // bait isian
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2 // penanda tanpa panjang
      continue
    }
    // SOF0-SOF15 kecuali DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { format: 'jpeg', height: u16be(b, i + 5), width: u16be(b, i + 7) }
    }
    if (marker === 0xd9 || marker === 0xda) return null // tamat / imbasan sebelum SOF
    i += 2 + u16be(b, i + 2)
  }
  return null
}

function webp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30) return null
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { format: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  }
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') return { format: 'webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
  return null
}

export function imageInfo(b: Uint8Array): ImageInfo | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpeg(b)
  if (b.length >= 24 && u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a && ascii(b, 12, 4) === 'IHDR') {
    return { format: 'png', width: u32be(b, 16), height: u32be(b, 20) }
  }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b)
  return null
}

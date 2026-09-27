import { describe, expect, test } from 'bun:test'
import { imageInfo } from './image'

// Pengepala minimum yang sah untuk setiap format (bait sebenar, bukan fail).
const png = (w: number, h: number) => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, w)
  new DataView(b.buffer).setUint32(20, h)
  return b
}
const jpeg = (w: number, h: number) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, ...new Array(20).fill(0)])
const riff = (chunk: string, payload: number[]) => {
  const b = new Uint8Array(40)
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)))
  b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8)
  b.set([...chunk].map((c) => c.charCodeAt(0)), 12)
  b.set(payload, 20)
  return b
}

describe('imageInfo (gagal-tertutup)', () => {
  test('PNG', () => expect(imageInfo(png(800, 600))).toEqual({ format: 'png', width: 800, height: 600 }))

  test('JPEG: melangkau segmen APP0 sebelum SOF0', () => expect(imageInfo(jpeg(5000, 10))).toEqual({ format: 'jpeg', width: 5000, height: 10 }))

  test('WebP lossy (VP8)', () => {
    expect(imageInfo(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x03, 0x58, 0x02]))).toEqual({ format: 'webp', width: 800, height: 600 })
  })

  test('WebP lossless (VP8L) & extended (VP8X)', () => {
    // lebar-1 = 1023, tinggi-1 = 511 dalam 14 bit berturutan
    const bits = 1023 | (511 << 14)
    expect(imageInfo(riff('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255]))).toEqual({ format: 'webp', width: 1024, height: 512 })
    expect(imageInfo(riff('VP8X', [0, 0, 0, 0, 0x9f, 0x0f, 0x00, 0x9f, 0x0f, 0x00]))).toEqual({ format: 'webp', width: 4000, height: 4000 })
  })

  test('tidak dapat diukur → null (ditolak, bukan dilepaskan)', () => {
    expect(imageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull() // JPEG tanpa SOF
    expect(imageInfo(riff('ABCD', []))).toBeNull()
    expect(imageInfo(new TextEncoder().encode('GIF89a......'))).toBeNull()
    expect(imageInfo(new Uint8Array())).toBeNull()
  })
})

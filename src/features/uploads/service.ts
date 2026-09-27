// R2: presign (klien memuat naik TERUS ke R2 - R10), pengesahan imej, URL
// baca bertandatangan (cache KV). Pariti marc_go internal/storage.
import { AwsClient } from 'aws4fetch'
import { getConfig, type Config } from '../../shared/config'
import { uuid } from '../../shared/db'
import { ApiError } from '../../shared/http'
import { imageInfo } from './image'
import * as repo from './repo'

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGE_DIMENSION = 4096
export const MAX_AVATAR_DIMENSION = 1024
export const MAX_IMAGES_PER_POST = 4
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

const PRESIGN_PUT_SECONDS = 5 * 60
const SIGNED_GET_SECONDS = 2 * 60 * 60
const SIGNED_GET_CACHE_SECONDS = 60 * 60 // < tempoh sah: URL cache sentiasa masih sah

export const r2Enabled = (c: Config) => !!(c.R2_ACCOUNT_ID && c.R2_ACCESS_KEY_ID && c.R2_SECRET_ACCESS_KEY && c.R2_BUCKET_NAME)

async function presign(c: Config, key: string, method: 'GET' | 'PUT', seconds: number, headers: Record<string, string> = {}) {
  const aws = new AwsClient({ accessKeyId: c.R2_ACCESS_KEY_ID, secretAccessKey: c.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' })
  const url = `https://${c.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${c.R2_BUCKET_NAME}/${key}?X-Amz-Expires=${seconds}`
  return (await aws.sign(url, { method, headers, aws: { signQuery: true } })).url
}

export async function presignUpload(env: CloudflareBindings, db: D1Database, userId: string, contentType: string, now: number) {
  const config = getConfig(env)
  if (!r2Enabled(config)) throw new ApiError(503, 'upload gambar belum tersedia')
  if (!ALLOWED_TYPES.includes(contentType)) throw new ApiError(400, 'jenis fail tidak disokong')
  const key = `posts/${uuid()}`
  let uploadUrl: string
  try {
    uploadUrl = await presign(config, key, 'PUT', PRESIGN_PUT_SECONDS, { 'Content-Type': contentType })
    // Jejak sisi-pelayan terakhir sebelum PUT terus peranti → R2.
    await repo.createPending(db, key, userId, now)
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'presign gagal', error: String(err) }))
    throw new ApiError(500, 'gagal jana upload URL')
  }
  return { upload_url: uploadUrl, r2_key: key }
}

// URL baca bertandatangan, dicache dalam KV. Tanpa cache, X-Amz-Date berubah
// setiap permintaan dan cache imej peranti (dikunci ikut URL) muat turun semula.
export async function signedUrl(env: CloudflareBindings, key: string | null): Promise<string | null> {
  if (!key) return null
  const config = getConfig(env)
  if (!r2Enabled(config)) return null
  const cacheKey = `signed:${key}`
  const cached = await env.KV.get(cacheKey).catch(() => null)
  if (cached) return cached
  try {
    const url = await presign(config, key, 'GET', SIGNED_GET_SECONDS)
    await env.KV.put(cacheKey, url, { expirationTtl: SIGNED_GET_CACHE_SECONDS }).catch(() => {})
    return url
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'presign GET gagal', r2_key: key, error: String(err) }))
    return null
  }
}

type Rejection = 'invalid' | 'too_large' | 'too_many_pixels'

// Baca objek (≤5 MB) melalui binding dan hurai pengepalanya. Gagal-tertutup.
async function inspect(env: CloudflareBindings, key: string, maxDimension: number): Promise<Rejection | null> {
  const obj = await env.BUCKET.get(key)
  if (!obj) return 'invalid'
  if (obj.size > MAX_IMAGE_BYTES) {
    await obj.body.cancel()
    return 'too_large'
  }
  const info = imageInfo(new Uint8Array(await obj.arrayBuffer()))
  if (!info) return 'invalid'
  return info.width > maxDimension || info.height > maxDimension ? 'too_many_pixels' : null
}

// Kunci datang dari klien: MESTI milik pemanggil (pending) dan imej sah.
// Ditolak = objek dipadam + baris pending dibuang (pariti marc_go).
export async function verifyUploadedImage(env: CloudflareBindings, userId: string, key: string, kind: 'post' | 'avatar'): Promise<void> {
  const db = env.DB
  const INVALID = 'gambar tidak sah atau belum diupload'
  if (!(await repo.ownsPending(db, key, userId))) throw new ApiError(400, INVALID)
  const max = kind === 'avatar' ? MAX_AVATAR_DIMENSION : MAX_IMAGE_DIMENSION
  const rejection = await inspect(env, key, max)
  if (!rejection) return
  await env.BUCKET.delete(key).catch(() => {})
  await repo.deletePendingStmt(db, key, userId).run()
  if (rejection === 'too_many_pixels') throw new ApiError(400, kind === 'avatar' ? `dimensi gambar profil melebihi ${max}px` : `dimensi gambar melebihi ${max}px`)
  if (rejection === 'too_large' && kind === 'post') throw new ApiError(400, 'gambar melebihi had 5MB')
  throw new ApiError(400, INVALID)
}

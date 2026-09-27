// API awam features/uploads (Fasa 3: minimum; presign/verify/reaper = Fasa 4).
export { enqueueDeleteStmt, enqueueUserObjectsStmt } from './repo'

// URL baca bertandatangan. Fasa 4: aws4fetch + cache KV (R10). Sehingga itu
// null = "tiada gambar" (pariti marc_go bila R2 belum dikonfigur).
export async function signedUrl(_env: CloudflareBindings, _key: string | null): Promise<string | null> {
  return null
}

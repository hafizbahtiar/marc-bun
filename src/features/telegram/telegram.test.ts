// "Ujian wajib" docs/modules/02-telegram.md.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { testApp } from '../../test/app'
import { MSG } from './service'

let h: Awaited<ReturnType<typeof testApp>>
const quiet = { log: console.log, error: console.error }
const SECRET = 'webhook-rahsia'
beforeAll(async () => {
  console.log = () => {}
  console.error = () => {}
  h = await testApp({ TELEGRAM_BOT_USERNAME: 'marc_bot', TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_WEBHOOK_SECRET: SECRET })
}, 60_000)
afterAll(async () => {
  Object.assign(console, quiet)
  await h.dispose()
})

let n = 0
async function member() {
  n++
  const res = await h.request('/auth/register', { method: 'POST', json: { email: `tg${n}@gmail.com`, password: 'rahsia123', phone: `01987${String(n).padStart(5, '0')}`, staff_id: `T${n}` } })
  const { access_token } = (await res.json()) as { access_token: string }
  const { id } = (await h.db.prepare('SELECT id FROM users WHERE email = ?').bind(`tg${n}@gmail.com`).first<{ id: string }>())!
  return { token: access_token, id }
}
async function deepLinkToken(token: string) {
  const res = await h.request('/me/telegram-link/token', { method: 'POST', token })
  expect(res.status).toBe(200)
  return new URL(((await res.json()) as { deep_link: string }).deep_link).searchParams.get('start')!
}
const webhook = (text: string, chatId: number, secret = SECRET, env = {}) =>
  h.request('/webhooks/telegram', { method: 'POST', json: { message: { text, chat: { id: chatId }, from: { username: 'ali' } } }, headers: { 'X-Telegram-Bot-Api-Secret-Token': secret } }, env)
const lastReply = () => h.sent.telegram.at(-1)

describe('telegram', () => {
  test('deep link: https://t.me/<bot>?start=<token>', async () => {
    const m = await member()
    const res = await h.request('/me/telegram-link/token', { method: 'POST', token: m.token })
    expect(((await res.json()) as { deep_link: string }).deep_link).toMatch(/^https:\/\/t\.me\/marc_bot\?start=[A-Za-z0-9_-]{43}$/)
  })

  test('bot username kosong → 503', async () => {
    const m = await member()
    const res = await h.request('/me/telegram-link/token', { method: 'POST', token: m.token }, { TELEGRAM_BOT_USERNAME: '' })
    expect([res.status, await h.body(res)]).toEqual([503, { error: 'binding Telegram belum tersedia' }])
  })

  test('/start <token> → terikat; token sekali-guna; /start tanpa token → sudah disambung', async () => {
    const m = await member()
    const token = await deepLinkToken(m.token)
    expect((await webhook(`/start ${token}`, 5001)).status).toBe(200)
    expect(lastReply()).toEqual({ chatId: 5001, text: MSG.linked })
    expect(await h.row('SELECT telegram_chat_id, telegram_username FROM profiles WHERE user_id = ?', m.id)).toEqual({ telegram_chat_id: 5001, telegram_username: 'ali' })

    await webhook(`/start ${token}`, 5001)
    expect(lastReply()!.text).toBe(MSG.invalid)
    await webhook('/start', 5001)
    expect(lastReply()!.text).toBe(MSG.alreadyLinked)
    await webhook('/start', 9999)
    expect(lastReply()!.text).toBe(MSG.greeting)
  })

  test('token luput → tidak sah', async () => {
    const m = await member()
    const token = await deepLinkToken(m.token)
    await h.db.prepare('UPDATE telegram_link_tokens SET expires_at = 1 WHERE user_id = ?').bind(m.id).run()
    await webhook(`/start ${token}`, 5002)
    expect(lastReply()!.text).toBe(MSG.invalid)
  })

  test('chat sudah terikat ke ahli lain → ditolak', async () => {
    const a = await member()
    const b = await member()
    await webhook(`/start ${await deepLinkToken(a.token)}`, 5003)
    await webhook(`/start ${await deepLinkToken(b.token)}`, 5003)
    expect(lastReply()!.text).toBe(MSG.taken)
    expect(await h.row('SELECT telegram_chat_id FROM profiles WHERE user_id = ?', b.id)).toEqual({ telegram_chat_id: null })
  })

  test('rahsia webhook salah → 401, tiada perubahan', async () => {
    const m = await member()
    const token = await deepLinkToken(m.token)
    expect((await webhook(`/start ${token}`, 5004, 'salah')).status).toBe(401)
    expect(await h.row('SELECT COUNT(*) n FROM telegram_link_tokens WHERE user_id = ?', m.id)).toEqual({ n: 1 })
  })

  test('bot tidak dikonfigur → laluan 404', async () => {
    const res = await webhook('/start', 1, SECRET, { TELEGRAM_BOT_TOKEN: '' })
    expect([res.status, await res.text()]).toEqual([404, '404 page not found'])
  })

  test('bukan /start / body rosak → 200 senyap', async () => {
    const before = h.sent.telegram.length
    expect((await webhook('hello', 1)).status).toBe(200)
    expect((await h.request('/webhooks/telegram', { method: 'POST', body: '{', headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET } })).status).toBe(200)
    expect(h.sent.telegram.length).toBe(before)
  })

  test('DELETE /me/telegram-link idempoten', async () => {
    const m = await member()
    await webhook(`/start ${await deepLinkToken(m.token)}`, 5005)
    expect((await h.request('/me/telegram-link', { method: 'DELETE', token: m.token })).status).toBe(204)
    expect((await h.request('/me/telegram-link', { method: 'DELETE', token: m.token })).status).toBe(204)
    expect(await h.row('SELECT telegram_chat_id FROM profiles WHERE user_id = ?', m.id)).toEqual({ telegram_chat_id: null })
  })
})

// Pariti marc_go handlers/telegram.go.
import { clearTelegram, setTelegram, userIdByTelegramChat } from '../profile'
import type { Config } from '../../shared/config'
import { opaqueToken, sha256Hex } from '../../shared/crypto'
import { uuid } from '../../shared/db'
import { ApiError } from '../../shared/http'
import { claimLinkToken, replaceLinkToken } from './repo'

// Bot API melalui fetch - satu kaedah sahaja, tiada SDK.
export type SendTelegram = (config: Config, chatId: number, text: string) => Promise<void>

export const telegramSend: SendTelegram = async (config, chatId, text) => {
  const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`telegram ${res.status}`)
}

// 10 minit, bukan 1 jam: deep-link dibuka serta-merta, bukan tunggu emel.
const LINK_TTL = 10 * 60 * 1000

export async function requestLinkToken(db: D1Database, config: Config, userId: string, now: number): Promise<string> {
  if (!config.TELEGRAM_BOT_USERNAME) throw new ApiError(503, 'binding Telegram belum tersedia')
  const token = opaqueToken()
  await replaceLinkToken(db, { id: uuid(), userId, hash: await sha256Hex(token), expiresAt: now + LINK_TTL }).catch(() => {
    throw new ApiError(500, 'gagal jana pautan')
  })
  return `https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${token}`
}

export async function deleteLink(db: D1Database, userId: string): Promise<void> {
  await clearTelegram(db, userId).catch(() => {
    throw new ApiError(500, 'gagal nyahikat')
  })
}

export const MSG = {
  greeting:
    'Selamat datang ke bot MARC! Muat turun app di https://play.google.com/store/apps/details?id=com.hafizbahtiar.marc untuk sambungkan akaun anda.',
  invalid: 'Pautan tidak sah atau sudah luput. Cuba jana pautan baharu dari app.',
  taken: 'Akaun Telegram ini sudah disambungkan ke akaun MARC lain. Guna akaun Telegram yang berbeza.',
  alreadyLinked: 'Akaun kamu dah disambungkan ke MARC.',
  linked: 'Akaun MARC anda berjaya disambungkan!',
  error: 'Ralat dalaman. Cuba lagi dari app.',
} as const

// Logik /start - pulang teks balasan bot. Tiada rangkaian Telegram di sini.
export async function resolveStart(db: D1Database, chatId: number, username: string, token: string, now: number): Promise<string> {
  if (!token) return (await userIdByTelegramChat(db, chatId)) ? MSG.alreadyLinked : MSG.greeting

  const claimed = await claimLinkToken(db, await sha256Hex(token))
  if (!claimed || claimed.expires_at <= now) return MSG.invalid

  const existing = await userIdByTelegramChat(db, chatId)
  if (existing && existing !== claimed.user_id) return MSG.taken
  try {
    await setTelegram(db, claimed.user_id, chatId, username || null, now)
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'telegram: simpan binding gagal', error: String(err) }))
    return MSG.error
  }
  return MSG.linked
}

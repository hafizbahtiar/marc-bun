import { Hono } from 'hono'
import { getConfig } from '../../shared/config'
import { safeEqual } from '../../shared/crypto'
import { notFound } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import { rateLimit } from '../../shared/middleware/rate-limit'
import type { AppEnv } from '../../shared/types'
import { deleteLink, requestLinkToken, resolveStart, type SendTelegram } from './service'

export type TelegramDeps = { sendTelegram: SendTelegram }

type Update = { message?: { text?: string; chat?: { id?: number }; from?: { username?: string } } }

export function telegramRoutes(deps: TelegramDeps) {
  const r = new Hono<AppEnv>()

  r.post('/me/telegram-link/token', requireAuth, rateLimit('RL_TELEGRAM_LINK'), async (c) =>
    c.json({ deep_link: await requestLinkToken(c.env.DB, getConfig(c.env), userId(c), Date.now()) }),
  )

  // Idempoten: 204 sentiasa.
  r.delete('/me/telegram-link', requireAuth, async (c) => {
    await deleteLink(c.env.DB, userId(c))
    return c.body(null, 204)
  })

  // Dipanggil Telegram, bukan app. Bot tidak dikonfigur = laluan "tidak wujud"
  // (marc_go tidak mendaftarkannya langsung). Ralat kepada pengguna = mesej
  // bot; HTTP sentiasa 200 supaya Telegram tidak mencuba semula.
  r.post('/webhooks/telegram', async (c) => {
    const config = getConfig(c.env)
    if (!config.TELEGRAM_BOT_TOKEN) return notFound(c)
    if (config.TELEGRAM_WEBHOOK_SECRET && !safeEqual(c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '', config.TELEGRAM_WEBHOOK_SECRET)) {
      return c.body(null, 401)
    }

    const update = (await c.req.json().catch(() => ({}))) as Update
    const text = update.message?.text?.trim() ?? ''
    const chatId = update.message?.chat?.id
    if (!text.startsWith('/start') || typeof chatId !== 'number') return c.body(null, 200)

    const reply = await resolveStart(c.env.DB, chatId, update.message?.from?.username ?? '', text.slice('/start'.length).trim(), Date.now())
    await deps.sendTelegram(config, chatId, reply).catch((err) => console.error(JSON.stringify({ level: 'error', msg: 'telegram: hantar balasan gagal', error: String(err) })))
    return c.body(null, 200)
  })

  return r
}

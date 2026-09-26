# 02 - telegram

**Tujuan.** Ikat akaun ahli kepada chat Telegram melalui deep-link bot.

**Sumber `marc_go`**: `handlers/telegram.go`, `router.go` (pendaftaran
bersyarat), `queries/telegram_link_tokens.sql`.

## Laluan

| Method | Path | Lapisan | Had kadar |
|---|---|---|---|
| POST | `/me/telegram-link/token` | protected | `telegram-link` |
| DELETE | `/me/telegram-link` | protected | - |
| POST | `/webhooks/telegram` | awam (Telegram) | - |

## Data

- **Milik**: `telegram_link_tokens`.
- **Melalui pemilik**: `profile.setTelegram()` / `profile.clearTelegram()` /
  `profile.findByTelegramChat()` (lajur `telegram_*` pada `profiles`).

## Peraturan

- `TELEGRAM_BOT_USERNAME` kosong → laluan token **503** (ciri mati).
- `TELEGRAM_BOT_TOKEN` kosong → laluan webhook **tidak didaftar** langsung
  (404), bukan 503 runtime.
- Token deep-link: legap, SHA-256, TTL 10 minit, sekali-guna
  (`DELETE … RETURNING`).
- Webhook sentiasa **200**. Ralat kepada pengguna = mesej bot, bukan status
  HTTP (Telegram akan retry kalau bukan 200).
- Header `X-Telegram-Bot-Api-Secret-Token` mesti padan
  `TELEGRAM_WEBHOOK_SECRET` (perbandingan masa-tetap) sebelum apa-apa kerja.
- `resolveStart(chatId, username, token)` kekal fungsi **tulen** tanpa
  rangkaian - diuji terus; pengendali webhook cuma bungkus nipis.
- `DELETE /me/telegram-link` idempoten: 204 sentiasa.

## Cloudflare

- Tiada SDK bot; Bot API melalui `fetch` (`sendMessage` sahaja).
- Webhook di luar `/api` tidak relevan di sini (laluan `marc_go` tiada
  prefix), tetapi ia **tidak boleh** berada di belakang CORS/CSRF gate.

## Ujian wajib

- `resolveStart`: token sah, tamat, digunakan semula, tidak wujud.
- Rahsia webhook salah → tiada perubahan DB.
- Bot tidak dikonfigur → `/webhooks/telegram` 404.

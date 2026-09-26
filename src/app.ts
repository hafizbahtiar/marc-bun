import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requestId } from 'hono/request-id'
import { INVALID_DATA, notFound, onError } from './shared/http'
import { logger } from './shared/middleware/logger'
import type { AppEnv } from './shared/types'

export const app = new Hono<AppEnv>()

app.use(requestId({ headerName: 'X-Request-ID' }))
app.use(logger)
// 1 MB seperti marc_go. Gin melaporkan body terlalu besar sebagai ralat bind,
// jadi pariti = 400 `Data tidak sah`, bukan 413.
app.use(bodyLimit({ maxSize: 1 << 20, onError: (c) => c.json({ error: INVALID_DATA }, 400) }))

app.get('/healthz', (c) => c.json({ status: 'ok' }))

// Feature dipasang di sini: app.route('/', auth.routes) - satu baris setiap feature.

app.onError(onError)
app.notFound(notFound)

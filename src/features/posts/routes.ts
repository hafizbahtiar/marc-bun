// Semua lapisan `verified` (auth + approved + emel disahkan).
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { requireApproved, requireVerified } from '../profile'
import { actorOf } from '../../shared/audit'
import { ApiError, parseBody, uuidParam } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import { rateLimit } from '../../shared/middleware/rate-limit'
import type { AppEnv } from '../../shared/types'
import * as service from './service'
import type { PostsCtx, PostsDeps } from './service'

const runes = (max: number) => (s: string) => [...s].length <= max
const content = (max: number) => z.string({ error: 'Kandungan diperlukan' }).min(1, 'Kandungan diperlukan').refine(runes(max))
const updatedAt = z.string().min(1)

const createPost = z.object({ type: z.string().default(''), content: content(10000), r2_keys: z.array(z.string()).default([]) })
const editPost = z.object({ content: content(10000), updated_at: updatedAt })
const createComment = z.object({ content: content(2000), parent_comment_id: z.string().nullish() })
const editComment = z.object({ content: content(2000), updated_at: updatedAt })
const del = z.object({ updated_at: updatedAt })

export function postsRoutes(deps: PostsDeps) {
  const r = new Hono<AppEnv>()
  const ctx = (c: Context<AppEnv>): PostsCtx => ({ env: c.env, deps, now: Date.now(), actor: actorOf(c), userId: userId(c), waitUntil: (p) => c.executionCtx.waitUntil(p) })
  const noContent = (c: Context<AppEnv>) => c.body(null, 204)
  // `id post tidak sah` untuk laluan komen di bawah post (mesej marc_go).
  const postIdParam = (c: Context<AppEnv>) => {
    try {
      return uuidParam(c, 'id')
    } catch {
      throw new ApiError(400, 'id post tidak sah')
    }
  }
  for (const path of ['/posts', '/posts/*', '/comments/*']) r.use(path, requireAuth, requireApproved, requireVerified)

  r.get('/posts', async (c) => c.json(await service.list(ctx(c), c.req.query('limit'), c.req.query('cursor'))))
  r.post('/posts', rateLimit('RL_POST_CREATE'), async (c) => c.json(await service.create(ctx(c), await parseBody(c, createPost)), 201))
  r.get('/posts/:id', async (c) => c.json(await service.get(ctx(c), uuidParam(c, 'id'))))
  r.patch('/posts/:id', async (c) => {
    const id = uuidParam(c, 'id')
    return c.json(await service.update(ctx(c), id, await parseBody(c, editPost)))
  })
  r.delete('/posts/:id', async (c) => {
    const id = uuidParam(c, 'id')
    await service.remove(ctx(c), id, (await parseBody(c, del)).updated_at)
    return noContent(c)
  })
  r.post('/posts/:id/like', async (c) => {
    await service.like(ctx(c), uuidParam(c, 'id'))
    return noContent(c)
  })
  r.delete('/posts/:id/like', async (c) => {
    await service.unlike(ctx(c), uuidParam(c, 'id'))
    return noContent(c)
  })

  r.get('/posts/:id/comments', async (c) => c.json(await service.listComments(ctx(c), postIdParam(c))))
  r.post('/posts/:id/comments', rateLimit('RL_COMMENT_CREATE'), async (c) => {
    const id = postIdParam(c)
    return c.json(await service.createComment(ctx(c), id, await parseBody(c, createComment)), 201)
  })
  r.patch('/comments/:id', async (c) => {
    const id = uuidParam(c, 'id')
    return c.json(await service.updateComment(ctx(c), id, await parseBody(c, editComment)))
  })
  r.delete('/comments/:id', async (c) => {
    const id = uuidParam(c, 'id')
    await service.removeComment(ctx(c), id, (await parseBody(c, del)).updated_at)
    return noContent(c)
  })
  r.post('/comments/:id/like', async (c) => {
    await service.likeComment(ctx(c), uuidParam(c, 'id'))
    return noContent(c)
  })
  r.delete('/comments/:id/like', async (c) => {
    await service.unlikeComment(ctx(c), uuidParam(c, 'id'))
    return noContent(c)
  })

  return r
}

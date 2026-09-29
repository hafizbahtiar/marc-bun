// Suapan: post, komen (2 tahap), like - pariti marc_go handlers/posts.go,
// comments.go, posts_common.go. Susunan semakan & mesej = marc_go.
import { isManagement } from '../profile'
import { deletePendingStmt, enqueuePostImagesStmt, MAX_IMAGES_PER_POST, signedUrl, verifyUploadedImage } from '../uploads'
import { auditStmt, type Actor } from '../../shared/audit'
import { expectedUpdatedAt, staleWrite } from '../../shared/concurrency'
import { uuid } from '../../shared/db'
import { ApiError } from '../../shared/http'
import type { Enqueue, NotificationKind } from '../../shared/jobs'
import { decodeCursor, encodeCursor, pageLimit } from '../../shared/cursor'
import { commentDto, postDto } from './dto'
import * as repo from './repo'
import type { CommentRow, PostCore } from './repo'

export type PostsDeps = { enqueue: Enqueue }

export type PostsCtx = { env: CloudflareBindings; deps: PostsDeps; now: number; actor: Actor; userId: string; waitUntil(p: Promise<unknown>): void }

// Notifikasi kepada pemilik kandungan - bukan diri sendiri; selepas komit,
// best-effort (kegagalan tidak membatalkan like/komen yang sudah berjaya).
function notifyOwner(ctx: PostsCtx, recipientId: string, kind: NotificationKind, refs: { postId?: string; commentId?: string }, push: { title: string; message: string }) {
  if (recipientId === ctx.userId) return
  ctx.waitUntil(
    ctx.deps
      .enqueue(ctx.env, { type: 'notify', kind, actorId: ctx.userId, recipientIds: [recipientId], ...refs, push })
      .catch((err) => console.error(JSON.stringify({ level: 'error', msg: 'notify gagal', kind, error: String(err) }))),
  )
}

// Pemilik ATAU pengurusan (padam sahaja; sunting = pemilik sahaja).
const canModify = async (ctx: PostsCtx, authorId: string) => authorId === ctx.userId || (await isManagement(ctx.env.DB, ctx.userId))

// ---- bina respons (berkelompok, tiada N+1) ----

async function buildPosts(ctx: PostsCtx, posts: PostCore[]) {
  if (!posts.length) return []
  const db = ctx.env.DB
  const x = await repo.enrichPosts(db, posts.map((p) => p.id), ctx.userId)
  const previewLikes = await repo.commentLikeState(db, x.previews.map((c) => c.id), ctx.userId)
  const url = (key: string | null) => signedUrl(ctx.env, key)

  const previewsByPost = new Map<string, ReturnType<typeof commentDto>[]>()
  for (const c of x.previews) {
    const list = previewsByPost.get(c.post_id) ?? []
    list.push(commentDto(c, await url(c.author_avatar_r2_key), previewLikes.counts.get(c.id) ?? 0, previewLikes.liked.has(c.id)))
    previewsByPost.set(c.post_id, list)
  }
  // Gambar yang gagal ditandatangani ditinggalkan (pariti marc_go).
  const imagesByPost = new Map<string, string[]>()
  for (const img of x.images) {
    const signed = await url(img.r2_key)
    if (signed) imagesByPost.set(img.post_id, [...(imagesByPost.get(img.post_id) ?? []), signed])
  }
  return Promise.all(
    posts.map(async (p) =>
      postDto(p, {
        avatarUrl: await url(p.author_avatar_r2_key),
        images: imagesByPost.get(p.id) ?? [],
        likeCount: x.likeCounts.get(p.id) ?? 0,
        commentCount: x.commentCounts.get(p.id) ?? 0,
        previews: previewsByPost.get(p.id) ?? [],
        likedByMe: x.liked.has(p.id),
      }),
    ),
  )
}

async function reload(ctx: PostsCtx, id: string, failure: string) {
  const post = await repo.getPost(ctx.env.DB, id)
  if (!post) throw new ApiError(500, failure)
  return (await buildPosts(ctx, [post]))[0]!
}

// ---- post ----

export async function list(ctx: PostsCtx, rawLimit: string | undefined, cursor: string | undefined) {
  const limit = pageLimit(rawLimit)
  const after = cursor ? decodeCursor(cursor) : null
  if (cursor && !after) throw new ApiError(400, 'cursor tidak sah')
  const posts = await repo.listPosts(ctx.env.DB, limit, after)
  const last = posts.at(-1)
  return { posts: await buildPosts(ctx, posts), next_cursor: posts.length === limit && last ? encodeCursor(last.created_at, last.id) : null }
}

export async function get(ctx: PostsCtx, id: string) {
  const post = await repo.getPost(ctx.env.DB, id)
  if (!post) throw new ApiError(404, 'post tidak dijumpai')
  return (await buildPosts(ctx, [post]))[0]
}

export async function create(ctx: PostsCtx, input: { type: string; content: string; r2_keys: string[] }) {
  const type = input.type || 'normal'
  if (type !== 'normal' && type !== 'announcement') throw new ApiError(400, 'jenis post tidak sah')
  if (input.r2_keys.length > MAX_IMAGES_PER_POST) throw new ApiError(400, `maksimum ${MAX_IMAGES_PER_POST} gambar setiap post`)
  if (type === 'announcement' && !(await isManagement(ctx.env.DB, ctx.userId))) throw new ApiError(403, 'cuma management boleh buat pengumuman')
  for (const key of input.r2_keys) await verifyUploadedImage(ctx.env, ctx.userId, key, 'post')

  // Post + gambar + keluarkan kunci dari pending: SATU batch.
  const db = ctx.env.DB
  const id = uuid()
  await db.batch([
    repo.createPostStmt(db, { id, authorId: ctx.userId, type, content: input.content, now: ctx.now }),
    ...input.r2_keys.flatMap((key, i) => [repo.createImageStmt(db, id, key, i), deletePendingStmt(db, key, ctx.userId)]),
  ])
  return reload(ctx, id, 'post dicipta tapi gagal muat semula')
}

export async function update(ctx: PostsCtx, id: string, input: { content: string; updated_at: string }) {
  const db = ctx.env.DB
  const before = await repo.getPost(db, id)
  if (!before) throw new ApiError(404, 'post tidak dijumpai')
  if (before.author_id !== ctx.userId) throw new ApiError(403, 'cuma pemilik boleh edit post')
  const expected = expectedUpdatedAt(input.updated_at)
  const audit = auditStmt(
    db,
    { entityType: 'post', entityId: id, action: 'update', actor: ctx.actor, old: { content: before.content }, new: { content: input.content } },
    { sql: 'EXISTS (SELECT 1 FROM posts WHERE id = ? AND updated_at = ?)', params: [id, ctx.now] },
  )
  const [res] = await db.batch(audit ? [repo.updatePostStmt(db, id, input.content, expected, ctx.now), audit] : [repo.updatePostStmt(db, id, input.content, expected, ctx.now)])
  if (!res?.results.length) throw staleWrite('post telah berubah. Muat semula sebelum menyunting lagi.')
  return reload(ctx, id, 'gagal muat semula post')
}

export async function remove(ctx: PostsCtx, id: string, rawUpdatedAt: string) {
  const expected = expectedUpdatedAt(rawUpdatedAt)
  const db = ctx.env.DB
  const before = await repo.getPost(db, id)
  if (!before) throw new ApiError(404, 'post tidak dijumpai')
  if (!(await canModify(ctx, before.author_id))) throw new ApiError(403, 'tidak dibenarkan padam post ini')
  // Padam lembut + gilir gambar + audit, satu batch; gilir & audit hanya bila padam berlaku.
  const deleted = { sql: 'EXISTS (SELECT 1 FROM posts WHERE id = ? AND deleted_at = ?)', params: [id, ctx.now] }
  const [res] = await db.batch([
    repo.softDeletePostStmt(db, id, expected, ctx.now),
    enqueuePostImagesStmt(db, id, deleted),
    auditStmt(db, { entityType: 'post', entityId: id, action: 'delete', actor: ctx.actor, old: { content: before.content, type: before.type, author_id: before.author_id } }, deleted)!,
  ])
  if (!res?.results.length) throw staleWrite('post telah berubah. Muat semula sebelum memadam lagi.')
}


export async function like(ctx: PostsCtx, id: string) {
  const created = await repo.likePost(ctx.env.DB, id, ctx.userId, ctx.now)
  const post = await repo.getPost(ctx.env.DB, id)
  if (!post) throw new ApiError(404, 'post tidak dijumpai') // tidak wujud / dipadam
  if (created) notifyOwner(ctx, post.author_id, 'post_like', { postId: id }, { title: 'Post anda disukai', message: 'Seseorang menyukai post anda' })
}

export const unlike = (ctx: PostsCtx, id: string) => repo.unlikePost(ctx.env.DB, id, ctx.userId)

// ---- komen ----

async function commentResponse(ctx: PostsCtx, c: CommentRow) {
  const state = await repo.commentLikeState(ctx.env.DB, [c.id], ctx.userId)
  return commentDto(c, await signedUrl(ctx.env, c.author_avatar_r2_key), state.counts.get(c.id) ?? 0, state.liked.has(c.id))
}

export async function listComments(ctx: PostsCtx, postId: string) {
  const rows = await repo.listComments(ctx.env.DB, postId)
  const state = await repo.commentLikeState(ctx.env.DB, rows.map((r) => r.id), ctx.userId)
  return { comments: await Promise.all(rows.map(async (r) => commentDto(r, await signedUrl(ctx.env, r.author_avatar_r2_key), state.counts.get(r.id) ?? 0, state.liked.has(r.id)))) }
}

// Kedalaman maks 2: balasan kepada komen tahap-2 dilekatkan pada induk tahap-1nya.
export async function createComment(ctx: PostsCtx, postId: string, input: { content: string; parent_comment_id?: string | null }) {
  const db = ctx.env.DB
  let parentId: string | null = null
  if (input.parent_comment_id != null) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.parent_comment_id)) throw new ApiError(400, 'parent_comment_id tidak sah')
    const parent = await repo.getComment(db, input.parent_comment_id.toLowerCase())
    if (!parent || parent.post_id !== postId) throw new ApiError(400, 'comment induk tidak dijumpai')
    parentId = parent.parent_comment_id ?? parent.id
  }
  const id = uuid()
  const row = await repo.createCommentStmt(db, { id, postId, parentId, authorId: ctx.userId, content: input.content, now: ctx.now }).first()
  if (!row) throw new ApiError(404, 'post tidak dijumpai')

  const post = await repo.getPost(db, postId)
  if (post) notifyOwner(ctx, post.author_id, 'post_comment', { postId, commentId: id }, { title: 'Comment baru', message: 'Seseorang comment pada post anda' })
  return commentResponse(ctx, (await repo.getComment(db, id))!)
}

export async function updateComment(ctx: PostsCtx, id: string, input: { content: string; updated_at: string }) {
  const db = ctx.env.DB
  const existing = await repo.getComment(db, id)
  if (!existing) throw new ApiError(404, 'comment tidak dijumpai')
  if (existing.author_id !== ctx.userId) throw new ApiError(403, 'cuma pemilik boleh edit comment')
  const expected = expectedUpdatedAt(input.updated_at)
  const audit = auditStmt(
    db,
    { entityType: 'comment', entityId: id, action: 'update', actor: ctx.actor, old: { content: existing.content }, new: { content: input.content } },
    { sql: 'EXISTS (SELECT 1 FROM comments WHERE id = ? AND updated_at = ?)', params: [id, ctx.now] },
  )
  const stmt = repo.updateCommentStmt(db, id, input.content, expected, ctx.now)
  const [res] = await db.batch(audit ? [stmt, audit] : [stmt])
  if (!res?.results.length) throw staleWrite('comment telah berubah. Muat semula sebelum menyunting lagi.')
  return commentResponse(ctx, (await repo.getComment(db, id))!)
}

export async function removeComment(ctx: PostsCtx, id: string, rawUpdatedAt: string) {
  const expected = expectedUpdatedAt(rawUpdatedAt)
  const db = ctx.env.DB
  const existing = await repo.getComment(db, id)
  if (!existing) throw new ApiError(404, 'comment tidak dijumpai')
  if (!(await canModify(ctx, existing.author_id))) throw new ApiError(403, 'tidak dibenarkan padam comment ini')
  const [res] = await db.batch([
    repo.softDeleteCommentStmt(db, id, expected, ctx.now),
    auditStmt(
      db,
      { entityType: 'comment', entityId: id, action: 'delete', actor: ctx.actor, old: { content: existing.content, author_id: existing.author_id, post_id: existing.post_id } },
      { sql: 'EXISTS (SELECT 1 FROM comments WHERE id = ? AND deleted_at = ?)', params: [id, ctx.now] },
    )!,
  ])
  if (!res?.results.length) throw staleWrite('comment telah berubah. Muat semula sebelum memadam lagi.')
}

export async function likeComment(ctx: PostsCtx, id: string) {
  const created = await repo.likeComment(ctx.env.DB, id, ctx.userId, ctx.now)
  const comment = await repo.getComment(ctx.env.DB, id)
  if (!comment) throw new ApiError(404, 'comment tidak dijumpai') // tidak wujud / dipadam
  if (created) notifyOwner(ctx, comment.author_id, 'comment_like', { postId: comment.post_id, commentId: id }, { title: 'Komen anda disukai', message: 'Seseorang menyukai komen anda' })
}

export const unlikeComment = (ctx: PostsCtx, id: string) => repo.unlikeComment(ctx.env.DB, id, ctx.userId)

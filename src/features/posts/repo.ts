// SQL milik features/posts: posts, post_images, post_likes, comments, comment_likes.
// Senarai id dihantar sebagai SATU parameter JSON (json_each) - tidak pernah
// melanggar had 100 parameter D1 walau limit=100 + id penonton.

export type PostCore = {
  id: string
  author_id: string
  type: string
  content: string
  created_at: number
  updated_at: number
  edited_at: number | null
  author_member_id: string | null
  author_display_name: string | null
  author_avatar_r2_key: string | null
}

export type CommentRow = {
  id: string
  post_id: string
  parent_comment_id: string | null
  author_id: string
  content: string
  created_at: number
  updated_at: number
  edited_at: number | null
  author_member_id: string | null
  author_display_name: string | null
  author_avatar_r2_key: string | null
}

// cross-read: profiles (blok pengarang melalui FK author_id)
const POST_SELECT = `SELECT p.id, p.author_id, p.type, p.content, p.created_at, p.updated_at, p.edited_at,
  pr.member_id AS author_member_id, pr.display_name AS author_display_name, pr.avatar_r2_key AS author_avatar_r2_key
FROM posts p JOIN profiles pr ON pr.user_id = p.author_id`

const COMMENT_SELECT = `SELECT c.id, c.post_id, c.parent_comment_id, c.author_id, c.content, c.created_at, c.updated_at, c.edited_at,
  pr.member_id AS author_member_id, pr.display_name AS author_display_name, pr.avatar_r2_key AS author_avatar_r2_key
FROM comments c JOIN profiles pr ON pr.user_id = c.author_id`

const ids = (list: string[]) => JSON.stringify(list)
const IN = 'IN (SELECT value FROM json_each(?))'

// ---- post ----

export const getPost = (db: D1Database, id: string) => db.prepare(`${POST_SELECT} WHERE p.id = ? AND p.deleted_at IS NULL`).bind(id).first<PostCore>()

// Keyset (created_at, id) menurun.
export async function listPosts(db: D1Database, limit: number, after: { createdAt: number; id: string } | null): Promise<PostCore[]> {
  const where = after ? 'AND (p.created_at, p.id) < (?, ?)' : ''
  const params = after ? [after.createdAt, after.id, limit] : [limit]
  const { results } = await db.prepare(`${POST_SELECT} WHERE p.deleted_at IS NULL ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`).bind(...params).all<PostCore>()
  return results
}

export const createPostStmt = (db: D1Database, p: { id: string; authorId: string; type: string; content: string; now: number }) =>
  db.prepare('INSERT INTO posts (id, author_id, type, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(p.id, p.authorId, p.type, p.content, p.now, p.now)

export const createImageStmt = (db: D1Database, postId: string, key: string, position: number) =>
  db.prepare('INSERT INTO post_images (id, post_id, r2_key, position) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), postId, key, position)

// CAS updated_at.
export const updatePostStmt = (db: D1Database, id: string, content: string, expected: number, now: number) =>
  db.prepare('UPDATE posts SET content = ?, edited_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND updated_at = ? RETURNING id').bind(content, now, now, id, expected)

export const softDeletePostStmt = (db: D1Database, id: string, expected: number, now: number) =>
  db.prepare('UPDATE posts SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND updated_at = ? RETURNING id').bind(now, now, id, expected)

// ---- pengayaan senarai (satu batch, tiada N+1) ----

export async function enrichPosts(db: D1Database, postIds: string[], viewerId: string) {
  const p = ids(postIds)
  const [likes, comments, liked, images, previews] = await db.batch([
    db.prepare(`SELECT post_id, COUNT(*) AS n FROM post_likes WHERE post_id ${IN} GROUP BY post_id`).bind(p),
    db.prepare(`SELECT post_id, COUNT(*) AS n FROM comments WHERE post_id ${IN} AND deleted_at IS NULL GROUP BY post_id`).bind(p),
    db.prepare(`SELECT post_id FROM post_likes WHERE user_id = ? AND post_id ${IN}`).bind(viewerId, p),
    db.prepare(`SELECT post_id, r2_key FROM post_images WHERE post_id ${IN} ORDER BY post_id, position`).bind(p),
    // 3 komen tahap-1 TERBARU setiap post, dipaparkan menaik.
    db.prepare(
      `SELECT * FROM (
         ${COMMENT_SELECT.replace('SELECT c.id', 'SELECT ROW_NUMBER() OVER (PARTITION BY c.post_id ORDER BY c.created_at DESC) AS rank, c.id')}
         WHERE c.post_id ${IN} AND c.parent_comment_id IS NULL AND c.deleted_at IS NULL
       ) WHERE rank <= 3 ORDER BY post_id, created_at ASC`,
    ).bind(p),
  ])
  return {
    likeCounts: new Map((likes!.results as { post_id: string; n: number }[]).map((r) => [r.post_id, r.n])),
    commentCounts: new Map((comments!.results as { post_id: string; n: number }[]).map((r) => [r.post_id, r.n])),
    liked: new Set((liked!.results as { post_id: string }[]).map((r) => r.post_id)),
    images: images!.results as { post_id: string; r2_key: string }[],
    previews: previews!.results as CommentRow[],
  }
}

export async function commentLikeState(db: D1Database, commentIds: string[], viewerId: string) {
  if (!commentIds.length) return { counts: new Map<string, number>(), liked: new Set<string>() }
  const c = ids(commentIds)
  const [counts, liked] = await db.batch([
    db.prepare(`SELECT comment_id, COUNT(*) AS n FROM comment_likes WHERE comment_id ${IN} GROUP BY comment_id`).bind(c),
    db.prepare(`SELECT comment_id FROM comment_likes WHERE user_id = ? AND comment_id ${IN}`).bind(viewerId, c),
  ])
  return {
    counts: new Map((counts!.results as { comment_id: string; n: number }[]).map((r) => [r.comment_id, r.n])),
    liked: new Set((liked!.results as { comment_id: string }[]).map((r) => r.comment_id)),
  }
}

// ---- like (ON CONFLICT DO NOTHING RETURNING = baris baharu sahaja → notifikasi sekali) ----

export async function likePost(db: D1Database, postId: string, userId: string, now: number): Promise<boolean> {
  // Hanya post yang belum dipadam (marc_go: FK sahaja - post dipadam lembut diterima).
  const row = await db
    .prepare('INSERT INTO post_likes (post_id, user_id, created_at) SELECT id, ?, ? FROM posts WHERE id = ? AND deleted_at IS NULL ON CONFLICT DO NOTHING RETURNING post_id')
    .bind(userId, now, postId)
    .first()
  return row !== null
}

export async function unlikePost(db: D1Database, postId: string, userId: string): Promise<void> {
  await db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').bind(postId, userId).run()
}

export async function likeComment(db: D1Database, commentId: string, userId: string, now: number): Promise<boolean> {
  const row = await db
    .prepare('INSERT INTO comment_likes (comment_id, user_id, created_at) SELECT id, ?, ? FROM comments WHERE id = ? AND deleted_at IS NULL ON CONFLICT DO NOTHING RETURNING comment_id')
    .bind(userId, now, commentId)
    .first()
  return row !== null
}

export async function unlikeComment(db: D1Database, commentId: string, userId: string): Promise<void> {
  await db.prepare('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?').bind(commentId, userId).run()
}

// ---- komen ----

export const getComment = (db: D1Database, id: string) => db.prepare(`${COMMENT_SELECT} WHERE c.id = ? AND c.deleted_at IS NULL`).bind(id).first<CommentRow>()

export async function listComments(db: D1Database, postId: string): Promise<CommentRow[]> {
  const { results } = await db.prepare(`${COMMENT_SELECT} WHERE c.post_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at ASC`).bind(postId).all<CommentRow>()
  return results
}

// Hanya pada post yang wujud & belum dipadam (marc_go menerima komen pada post
// yang dipadam lembut kerana hanya bergantung pada FK).
export const createCommentStmt = (db: D1Database, c: { id: string; postId: string; parentId: string | null; authorId: string; content: string; now: number }) =>
  db
    .prepare(
      `INSERT INTO comments (id, post_id, parent_comment_id, author_id, content, created_at, updated_at)
       SELECT ?, id, ?, ?, ?, ?, ? FROM posts WHERE id = ? AND deleted_at IS NULL RETURNING id`,
    )
    .bind(c.id, c.parentId, c.authorId, c.content, c.now, c.now, c.postId)

export const updateCommentStmt = (db: D1Database, id: string, content: string, expected: number, now: number) =>
  db.prepare('UPDATE comments SET content = ?, edited_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND updated_at = ? RETURNING id').bind(content, now, now, id, expected)

export const softDeleteCommentStmt = (db: D1Database, id: string, expected: number, now: number) =>
  db.prepare('UPDATE comments SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND updated_at = ? RETURNING id').bind(now, now, id, expected)

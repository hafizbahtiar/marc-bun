// Pariti bentuk postResponse / commentResponse marc_go (posts_common.go).
import { toJson, toJsonNullable } from '../../shared/time'
import type { CommentRow, PostCore } from './repo'

type Author = { author_id: string; author_member_id: string | null; author_display_name: string | null }

export const authorDto = (r: Author, avatarUrl: string | null) => ({
  user_id: r.author_id,
  member_id: r.author_member_id ?? '',
  display_name: r.author_display_name,
  avatar_url: avatarUrl,
})

export const commentDto = (c: CommentRow, avatarUrl: string | null, likeCount: number, likedByMe: boolean) => ({
  id: c.id,
  parent_comment_id: c.parent_comment_id,
  content: c.content,
  created_at: toJson(c.created_at),
  updated_at: toJson(c.updated_at),
  edited_at: toJsonNullable(c.edited_at),
  author: authorDto(c, avatarUrl),
  like_count: likeCount,
  liked_by_me: likedByMe,
})

export const postDto = (
  p: PostCore,
  x: { avatarUrl: string | null; images: string[]; likeCount: number; commentCount: number; previews: ReturnType<typeof commentDto>[]; likedByMe: boolean },
) => ({
  id: p.id,
  type: p.type,
  content: p.content,
  created_at: toJson(p.created_at),
  updated_at: toJson(p.updated_at),
  edited_at: toJsonNullable(p.edited_at),
  author: authorDto(p, x.avatarUrl),
  images: x.images,
  like_count: x.likeCount,
  comment_count: x.commentCount,
  comment_previews: x.previews,
  liked_by_me: x.likedByMe,
})

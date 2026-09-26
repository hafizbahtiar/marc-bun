// Jenis konteks Hono yang dikongsi setiap feature.
export type AppEnv = {
  Bindings: CloudflareBindings
  Variables: {
    requestId: string
    // Diisi oleh requireAuth / optionalAuth. Baca melalui userId(c) / sessionId(c).
    userId?: string
    sessionId?: string | null
  }
}

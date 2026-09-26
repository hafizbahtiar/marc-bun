// Jenis konteks Hono yang dikongsi setiap feature.
export type AppEnv = {
  Bindings: CloudflareBindings
  Variables: {
    requestId: string
  }
}

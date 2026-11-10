/**
 * The running WeCom connection, reachable from the kind's Channel: `SourceChannel.send` receives only `commands`, and a
 * long connection belongs to the plugin entry that watches it, so the watch loop publishes its sender here on start and
 * withdraws it on disposal. One process holds one connection per bot, so this registry holds one sender.
 */
export interface WecomSender {
  /** The connected client, or undefined while it reconnects. */
  client(): WecomClient | undefined
  /** The callback frame that keeps `req_id` valid, or undefined once the connection dropped it. */
  frame(messageId: string): WecomFrame | undefined
  /** The stored `req_id` of a callback's message; a retried reply reuses it as its idempotency key. */
  reqId(messageId: string): string | undefined
  /** Moves the chat's topic to the message a push answers, so later messages there continue that conversation. */
  openRoot(chatId: string, messageId: string): void
  /** The chat id a push addresses; a direct chat is pushed to by its sender's user ID. */
  pushTarget(chatId: string): string
}
type WecomClient = import('./wecom-protocol.ts').WecomSdkClient
type WecomFrame = import('./wecom-protocol.ts').WecomSdkFrame
let running: WecomSender | undefined
/** Publishes the connection the Channel replies through. */
export const setWecomSender = (sender: WecomSender | undefined): void => { running = sender }
/** The running connection, or undefined while the plugin is off, waiting for setup, or reconnecting. */
export const wecomSender = (): WecomSender | undefined => running

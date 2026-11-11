/**
 * The WeCom image Channel: a message carries text or one media attachment, never both, so the pictures a ticket's reply
 * should show are uploaded and sent as messages of their own, right after it.
 *
 * The images are the ticket's own visual-acceptance frames, which the Engine hashed when the worker reported them; a frame
 * whose bytes changed since then is skipped rather than sent, so a reply never shows a picture the ticket did not judge.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Ticket } from '../core/index.ts'
import type { WecomFrame, WecomSdkClient } from './wecom-protocol.ts'
import { wecomSender } from './wecom-connection.ts'

/** What a reply's images need: the frame to answer, or the chat to push to, and the client to upload and send with. */
export interface WecomMediaTarget {
  chatId: string
  messageId?: string | undefined
  /** Whether the message is an answer to a callback, which decides between replying and pushing. */
  respond: boolean
}
/** Extensions WeCom renders as an image; anything else is a file, which this Channel does not send. */
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
/** WeCom accepts an uploaded image up to 2 MiB. */
export const WECOM_IMAGE_BYTES = 2 * 1024 * 1024
/** At most this many pictures follow one reply, so a ticket cannot flood a chat. */
export const WECOM_IMAGES_PER_REPLY = 3

/** One frame a ticket's visual acceptance recorded: its path and the hash the Engine verified. */
export interface VisualFrame { path: string; sha256: string }
/** The frames a ticket recorded, in the order the worker judged them. */
export function visualFrames(ticket: Ticket | undefined): VisualFrame[] {
  const frames = ticket?.validation?.visual?.frames
  return Array.isArray(frames) ? frames.filter((frame): frame is VisualFrame =>
    !!frame && typeof frame.path === 'string' && typeof frame.sha256 === 'string') : []
}
/** Reads one frame and answers its bytes and media type, or undefined when it cannot be sent as it was judged. */
async function picture(frame: VisualFrame): Promise<{ data: Buffer; mediaType: string; filename: string } | undefined> {
  const mediaType = IMAGE_TYPES[extname(frame.path).toLowerCase()]
  // A frame that is not a picture WeCom renders, or that grew past its limit since it was hashed, is left out.
  if (!mediaType) return undefined
  let data: Buffer
  try { data = await readFile(frame.path) }
  catch { return undefined }
  if (data.length === 0 || data.length > WECOM_IMAGE_BYTES) return undefined
  // The Engine verified this hash when the worker recorded the frame; a file changed since then is not what was judged.
  if (createHash('sha256').update(data).digest('hex') !== frame.sha256.toLowerCase()) return undefined
  return { data, mediaType, filename: frame.path.split(/[\\/]/).pop() ?? 'frame.png' }
}
/** Sends the ticket's recorded pictures after its reply; returns how many reached the chat. */
export async function sendWecomImages(ticket: Ticket | undefined, target: WecomMediaTarget): Promise<number> {
  const sender = wecomSender()
  const client = sender?.client()
  if (!sender || !client) return 0
  const frames = visualFrames(ticket).slice(0, WECOM_IMAGES_PER_REPLY)
  let sent = 0
  for (const frame of frames) {
    const file = await picture(frame)
    if (!file) continue
    try {
      const media = await client.uploadMedia(file.data, { type: 'image', filename: file.filename })
      if (!media?.media_id) continue
      await ack(await deliver(client, target, sender.frame(target.messageId ?? ''), media.media_id))
      sent += 1
    } catch {
      // One picture failing does not fail the reply beside it; the text already told the person what happened.
    }
  }
  return sent
}
/** Answers the callback while the connection holds it, and pushes to the chat once the reply window has passed. */
async function deliver(client: WecomSdkClient, target: WecomMediaTarget, frame: WecomFrame | undefined, mediaId: string): Promise<WecomFrame> {
  if (target.respond && frame) {
    try { return await client.replyMedia(frame, 'image', mediaId) }
    catch { /* An expired window falls through to the push below, which needs no callback. */ }
  }
  return client.sendMediaMessage(wecomSender()!.pushTarget(target.chatId), 'image', mediaId)
}
/** Applies the answer's `errcode`, which the client resolves instead of rejecting for a refused command. */
async function ack(frame: WecomFrame | undefined): Promise<void> {
  const code = frame?.errcode ?? 0
  if (code !== 0) throw new Error(`WeCom image send failed (${code})`)
}

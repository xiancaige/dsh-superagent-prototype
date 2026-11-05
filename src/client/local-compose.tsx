/** Local requests enter the normal evaluation pipeline; they do not authorize remote actions. */
import { useId, useRef, useState } from 'react'
import { usePoll } from './api.ts'
import { Button, Input } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint, Section } from './widgets.tsx'

const copy = {
  en: { title: 'Local task request', hint: 'Submit a local-mode request for evaluation. This does not authorize remote actions.',
    demand: 'Task request', thread: 'Thread (optional)', threadHint: 'Leave blank for a new task; use the returned thread for a follow-up.',
    send: 'Send request', busy: 'Sending…', retry: 'Retry request', success: 'Request received', open: 'Open thread' },
  zh: { title: '本地任务请求', hint: '提交本地模式请求，进入正常评估流程；此操作不授权任何远程操作。', demand: '任务需求',
    thread: '线程（可选）', threadHint: '留空创建新任务；填写返回的线程可继续跟进。', send: '发送请求', busy: '发送中…', retry: '重试请求',
    success: '请求已收到', open: '打开线程' },
}

export function LocalCompose() {
  const { t, call, navigate } = usePanel()
  const words = t('lang') === 'zh' ? copy.zh : copy.en
  const { data: sources } = usePoll(() => call('GET sources'), [call])
  const demandId = useId(), threadId = useId()
  const [text, setText] = useState('')
  const [thread, setThread] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [sent, setSent] = useState<{ triggerId: string; thread: string }>()
  const running = useRef(false)
  const attempt = useRef<{ id: string; text: string; thread?: string }>()
  // Keep the same id and payload after an ambiguous failure; editing the draft starts a different request.
  const change = (update: () => void) => { attempt.current = undefined; setError(undefined); setSent(undefined); update() }
  const send = async () => {
    if (running.current || !text.trim()) return
    running.current = true
    setBusy(true)
    setError(undefined)
    setSent(undefined)
    try {
      const body = attempt.current ??= { id: crypto.randomUUID(), text: text.trim(), ...thread.trim() ? { thread: thread.trim() } : {} }
      const result = await call('POST local/messages', { body })
      attempt.current = undefined
      setSent(result)
      setText('')
      setThread(result.thread)
    } catch (failure) { setError(errorText(failure)) }
    finally { running.current = false; setBusy(false) }
  }
  if (!sources?.some(source => source.id === 'local' && source.installed)) return null
  return <Section title={words.title}>
    <Hint>{words.hint}</Hint>
    <form onSubmit={event => { event.preventDefault(); void send() }} aria-busy={busy}>
      <div className="dt-field">
        <label className="dt-field-head" htmlFor={demandId}>{words.demand}</label>
        <textarea id={demandId} className="dt-textarea" rows={4} required disabled={busy} value={text}
          onChange={event => change(() => setText(event.target.value))} />
      </div>
      <div className="dt-field">
        <label className="dt-field-head" htmlFor={threadId}>{words.thread}</label>
        <Input id={threadId} disabled={busy} value={thread} onChange={event => change(() => setThread(event.target.value))} />
        <Hint>{words.threadHint}</Hint>
      </div>
      <Button type="submit" variant="primary" disabled={busy || !text.trim()}>{busy ? words.busy : error ? words.retry : words.send}</Button>
      {error && <p className="dt-error" role="alert">{error}</p>}
      {sent && <p role="status">{words.success}: <span className="dt-mono">{sent.triggerId}</span> · <button type="button"
        className="dt-textlink" onClick={() => navigate({ page: 'trigger', id: sent.thread })}>{words.open}: {sent.thread}</button></p>}
    </form>
  </Section>
}

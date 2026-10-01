import { useEffect, useRef } from 'react'
import type { ChatMessage } from '../../shared/types'
import Markdown from './Markdown'

interface Props {
  messages: ChatMessage[]
  /** Текст в поле ввода: сюда же дописывается распознанная речь. */
  draft: string
  onDraftChange: (text: string) => void
  onSubmit: () => void
  onClearDraft: () => void
  onInterrupt: () => void
  busy: boolean
  /** Идёт отсчёт до автоотправки: когда начался и сколько длится. */
  countdown: { startedAt: number; durationMs: number } | null
  /** Над чатом: план, вопрос, согласие. */
  header?: React.ReactNode
  /** Кнопка микрофона — слева от поля ввода. */
  voiceSlot?: React.ReactNode
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

export default function Chat({
  messages,
  draft,
  onDraftChange,
  onSubmit,
  onClearDraft,
  onInterrupt,
  busy,
  countdown,
  header,
  voiceSlot
}: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  // Автоскролл только если пользователь уже внизу — иначе он читает историю
  // и рывок вниз при каждом новом сообщении будет мешать.
  useEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  return (
    <section className="chat">
      {header}
      <div className="chat__scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 && (
          <p className="chat__empty">
            Скажите, что нужно сделать. Claude изучит проект и покажет план — ответьте «выполняй»
            или скажите, что изменить.
          </p>
        )}
        {messages.map((m) =>
          m.variant === 'plan' ? (
            // План — отдельной карточкой: остаётся в истории и после одобрения.
            <details key={m.id} className="msg msg--plan" open>
              <summary className="msg__meta">
                <span className="msg__who">☰ План</span>
                <span className="msg__time">{timeLabel(m.at)}</span>
              </summary>
              <div className="msg__text">
                <Markdown text={m.text} />
              </div>
            </details>
          ) : (
          <article key={m.id} className={`msg msg--${m.role}${m.final ? ' msg--final' : ''}`}>
            <header className="msg__meta">
              <span className="msg__who">
                {m.role === 'user' ? (m.fromVoice ? '🎙 Вы' : 'Вы') : 'Claude'}
              </span>
              <span className="msg__time">{timeLabel(m.at)}</span>
            </header>
            <div className="msg__text">
              {m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}
            </div>
          </article>
          )
        )}
      </div>

      <div className="composer">
        {voiceSlot}
        <div className="composer__field">
          <textarea
            className="composer__input"
            value={draft}
            placeholder="Говорите или пишите, что нужно сделать"
            rows={2}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              // Enter отправляет, Shift+Enter — перенос строки.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (draft.trim()) onSubmit()
              }
              if (e.key === 'Escape') onClearDraft()
            }}
          />
          {countdown && (
            // key перезапускает анимацию при каждом новом отсчёте.
            <div className="composer__countdown" key={countdown.startedAt}>
              <div
                className="composer__countdownBar"
                style={{ animationDuration: `${countdown.durationMs}ms` }}
              />
            </div>
          )}
        </div>
        <div className="composer__actions">
          <button className="btn btn--primary" onClick={onSubmit} disabled={!draft.trim()}>
            {countdown ? 'Сейчас' : 'Отправить'}
          </button>
          {draft.trim() ? (
            <button className="btn btn--ghost btn--small" onClick={onClearDraft} title="Очистить (Esc)">
              Очистить
            </button>
          ) : busy ? (
            <button className="btn btn--danger btn--small" onClick={onInterrupt} title="Прервать Claude">
              Стоп
            </button>
          ) : null}
        </div>
      </div>
    </section>
  )
}

import { useEffect, useState } from 'react'
import type { HistorySession } from '../../shared/types'
import { dateLabel, outcomeText, plural, timeLabel } from '../../shared/history-format'

interface Props {
  /** Открытая сейчас сессия — выделена и раскрыта, «Продолжить» у неё нет. */
  currentId: string
  /** Меняется, когда стоит перечитать список (закончился ход, сменилась сессия). */
  refreshKey: string
  /** Можно ли сейчас переключаться: не посреди работы Claude. */
  canResume: boolean
  onResume: (id: string) => void
  onClose: () => void
}

/** Левая панель: сессии проекта, свежие сверху, и ваши запросы в каждой. */
export default function HistoryPanel({
  currentId,
  refreshKey,
  canResume,
  onResume,
  onClose
}: Props): React.JSX.Element {
  const [sessions, setSessions] = useState<HistorySession[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([currentId]))

  useEffect(() => {
    let alive = true
    window.desk.history
      .list()
      .then((list) => {
        if (!alive) return
        setSessions(list)
        setFailed(false)
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [refreshKey])

  // Новая текущая сессия (после «Продолжить») — раскрываем её.
  useEffect(() => {
    setExpanded((prev) => (prev.has(currentId) ? prev : new Set(prev).add(currentId)))
  }, [currentId])

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // У только что открытой сессии ещё нет ни одного запроса в транскрипте.
  const list: HistorySession[] =
    sessions === null || sessions.some((s) => s.id === currentId)
      ? (sessions ?? [])
      : [{ id: currentId, title: 'Новая сессия', startedAt: Date.now(), updatedAt: Date.now(), fromApp: true, requests: [] }, ...sessions]

  return (
    <aside className="history" aria-label="История">
      <div className="history__head">
        <h2 className="tasks__title">История</h2>
        <button className="history__close" onClick={onClose} aria-label="Скрыть историю" title="Скрыть историю">
          ×
        </button>
      </div>

      {failed && <p className="tasks__empty history__note">Не удалось прочитать историю.</p>}
      {sessions === null && !failed && <p className="tasks__empty history__note">Читаю историю…</p>}

      <ul className="history__list">
        {list.map((s) => {
          const current = s.id === currentId
          const open = expanded.has(s.id)
          const count = s.requests.length
          return (
            <li key={s.id} className={`hsession${current ? ' hsession--current' : ''}`}>
              <button className="hsession__head" onClick={() => toggle(s.id)} aria-expanded={open}>
                <span className="hsession__title">{s.title}</span>
                <span className="hsession__meta">
                  {current ? 'сейчас' : dateLabel(s.updatedAt)}
                  {count > 0 && ` · ${count} ${plural(count, 'запрос', 'запроса', 'запросов')}`}
                  {!s.fromApp && ' · из терминала'}
                </span>
              </button>

              {open && (
                <div className="hsession__body">
                  {count === 0 ? (
                    <p className="tasks__empty">Запросов пока нет.</p>
                  ) : (
                    <ol className="hrequests">
                      {s.requests.map((r, i) => (
                        <li key={`${r.at}:${i}`} className="hrequest">
                          <span className="hrequest__time">{timeLabel(r.at)}</span>
                          <span className="hrequest__text" title={r.text}>
                            {r.text}
                          </span>
                          <span className={`outcome outcome--${r.outcome}`}>{outcomeText(r)}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {!current && (
                    <button
                      className="btn btn--small hsession__resume"
                      disabled={!canResume}
                      title={canResume ? 'Закрыть текущую сессию и продолжить эту' : 'Дождитесь, пока Claude закончит'}
                      onClick={() => onResume(s.id)}
                    >
                      Продолжить
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

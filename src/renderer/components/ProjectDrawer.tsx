import { useEffect, useState } from 'react'
import type {
  AssistantState,
  PlanRecord,
  ProjectChanges,
  ProjectOverview
} from '../../shared/types'
import Markdown from './Markdown'

interface Props {
  state: AssistantState
  /** Меняется, когда стоит перечитать сведения (закончилась задача, новая точка отката). */
  refreshKey: string
  onClose: () => void
  /** Сказать за пользователя: «изучи проект», «откати». */
  onSay: (text: string) => void
}

const PLAN_STATUS: Record<PlanRecord['status'], string> = {
  waiting: 'ждёт «выполняй»',
  approved: 'одобрен',
  revising: 'дорабатывается',
  cancelled: 'отменён'
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

/** Дифф с подсветкой строк: + зелёным, − красным, заголовки ханков приглушённо. */
function Diff({ text }: { text: string }): React.JSX.Element {
  const lines = text.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l))
  return (
    <pre className="diff">
      {lines.map((line, i) => {
        const cls = line.startsWith('+')
          ? 'diff__add'
          : line.startsWith('-')
            ? 'diff__del'
            : line.startsWith('@@')
              ? 'diff__hunk'
              : ''
        return (
          <span key={i} className={cls}>
            {line}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}

/**
 * Панель «Проект»: всё важное в одном месте и не теряется в чате — текущий план,
 * что изменилось в последней задаче (с диффом), итоги проверок и ревью, стек и
 * команды, описание и архитектура из CLAUDE.md.
 */
export default function ProjectDrawer({ state, refreshKey, onClose, onSay }: Props): React.JSX.Element {
  const [overview, setOverview] = useState<ProjectOverview | null>(null)
  const [changes, setChanges] = useState<ProjectChanges | null>(null)
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [diff, setDiff] = useState<string>('')

  useEffect(() => {
    void window.desk.project.overview().then(setOverview)
    void window.desk.project.changes().then(setChanges)
  }, [refreshKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggleFile = (path: string): void => {
    if (openFile === path) {
      setOpenFile(null)
      return
    }
    setOpenFile(path)
    setDiff('')
    void window.desk.project.diff(path).then(setDiff)
  }

  const plan = state.lastPlan
  const files = changes?.files ?? []
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)

  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-label="Проект">
      <div className="drawer__backdrop" onClick={onClose} />
      <aside className="drawer__panel">
        <header className="drawer__head">
          <div>
            <h2 className="drawer__title">Проект</h2>
            {overview?.git && (
              <span className="drawer__sub">
                ветка {overview.git.branch} · {overview.git.lastCommit}
              </span>
            )}
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </header>

        <div className="drawer__body">
          <details className="sect" open>
            <summary className="sect__head">
              <span>Текущий план</span>
              {plan && (
                <span className={`badge badge--${plan.status}`}>
                  {PLAN_STATUS[plan.status]} · {timeLabel(plan.at)}
                </span>
              )}
            </summary>
            <div className="sect__body">
              {plan ? (
                <Markdown text={plan.text} />
              ) : (
                <p className="muted">
                  Плана пока не было. Для сложных задач Claude составит его сам, или скажите
                  «с планом, …».
                </p>
              )}
            </div>
          </details>

          <details className="sect" open>
            <summary className="sect__head">
              <span>Что изменилось</span>
              {files.length > 0 && (
                <span className="sect__meta">
                  {files.length} файл. · <span className="plus">+{added}</span>{' '}
                  <span className="minus">−{removed}</span>
                </span>
              )}
            </summary>
            <div className="sect__body">
              {files.length === 0 ? (
                <p className="muted">В последней задаче файлы не менялись.</p>
              ) : (
                <>
                  <ul className="files">
                    {files.map((f) => (
                      <li key={f.path}>
                        <button
                          className={`files__row${openFile === f.path ? ' files__row--open' : ''}`}
                          onClick={() => toggleFile(f.path)}
                          disabled={!changes?.base}
                        >
                          <span className={`files__status files__status--${f.status}`}>
                            {f.status === 'new' ? 'новый' : f.status === 'deleted' ? 'удалён' : 'изменён'}
                          </span>
                          <span className="files__path">{f.path}</span>
                          {changes?.base && (
                            <span className="files__count">
                              <span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span>
                            </span>
                          )}
                        </button>
                        {openFile === f.path && (diff ? <Diff text={diff} /> : <p className="muted">Загружаю дифф…</p>)}
                      </li>
                    ))}
                  </ul>
                  {changes?.base && (
                    <div className="sect__actions">
                      <span className="muted">От точки отката {changes.base}</span>
                      <button className="btn btn--ghost btn--small" onClick={() => onSay('откати')}>
                        Откатить
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </details>

          <details className="sect" open={state.checks.length > 0 || state.review !== null}>
            <summary className="sect__head">
              <span>Проверки и ревью</span>
              {state.checks.length > 0 && (
                <span className="sect__meta">
                  {state.checks.every((c) => c.status !== 'failed') ? '✓ зелёные' : '✕ есть ошибки'}
                </span>
              )}
            </summary>
            <div className="sect__body">
              {state.checks.length === 0 && !state.review ? (
                <p className="muted">
                  Проверки запускаются, когда Claude заканчивает задачу с правками.
                </p>
              ) : (
                <ul className="checks">
                  {state.checks.map((c) => (
                    <li key={c.command} className={`checks__row checks__row--${c.status}`}>
                      <span className="checks__mark">
                        {c.status === 'ok' ? '✓' : c.status === 'failed' ? '✕' : '—'}
                      </span>
                      <span>{c.name}</span>
                      <code className="checks__cmd">{c.command}</code>
                      <span className="checks__time">{(c.ms / 1000).toFixed(1)} с</span>
                    </li>
                  ))}
                  {state.review && (
                    <li className={`checks__row checks__row--${state.review.ok ? 'ok' : 'failed'}`}>
                      <span className="checks__mark">{state.review.ok ? '✓' : '✕'}</span>
                      <span>Ревью</span>
                      <span className="checks__cmd">
                        {state.review.ok
                          ? 'существенных замечаний нет'
                          : state.review.issues.map((i) => `${i.file}: ${i.problem}`).join('; ')}
                      </span>
                      <span className="checks__time">{timeLabel(state.review.at)}</span>
                    </li>
                  )}
                </ul>
              )}
            </div>
          </details>

          <details className="sect">
            <summary className="sect__head">
              <span>Стек и команды</span>
              {overview && overview.stack.length > 0 && (
                <span className="sect__meta">{overview.stack.slice(0, 4).join(', ')}</span>
              )}
            </summary>
            <div className="sect__body">
              {overview && overview.stack.length > 0 ? (
                <div className="stack">
                  {overview.stack.map((s) => (
                    <span key={s} className="chip">
                      {s}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="muted">Стек по файлам проекта не определился.</p>
              )}
              {overview && overview.commands.length > 0 && (
                <ul className="cmds">
                  {overview.commands.map((c) => (
                    <li key={c.name}>
                      <code>{c.name}</code>
                      <span className="muted">{c.command}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>

          <details className="sect" open={!overview?.claudeMd}>
            <summary className="sect__head">
              <span>О проекте и архитектура</span>
              <span className="sect__meta">{overview?.claudeMd ? 'CLAUDE.md' : 'нет описания'}</span>
            </summary>
            <div className="sect__body">
              {overview?.claudeMd ? (
                <>
                  <Markdown text={overview.claudeMd} />
                  <div className="sect__actions">
                    <span className="muted">Описание пишет Claude и обновляет по просьбе.</span>
                    <button className="btn btn--ghost btn--small" onClick={() => onSay('изучи проект')}>
                      Обновить описание
                    </button>
                  </div>
                </>
              ) : (
                <div className="sect__actions">
                  <span className="muted">
                    Claude изучит проект и запишет в CLAUDE.md, что это, как устроено и какими
                    командами собирать и проверять.
                  </span>
                  <button className="btn btn--primary btn--small" onClick={() => onSay('изучи проект')}>
                    Изучить проект
                  </button>
                </div>
              )}
            </div>
          </details>
        </div>
      </aside>
    </div>
  )
}

import { useMemo, useState } from 'react'
import type { ActionKind, TodoItem, TokenUsage, ToolTask } from '../../shared/types'
import { TOOL_LABEL, kindOf } from '../../shared/action-kind'
import { KIND } from '../actionKinds'
import TokenChart from './TokenChart'

interface Props {
  tasks: ToolTask[]
  todos: TodoItem[]
  usage: Record<string, { tools: string[]; usage: TokenUsage }>
}

const STATE_MARK: Record<ToolTask['state'], string> = {
  running: '⟳',
  ok: '✓',
  error: '✕'
}

const TODO_MARK: Record<TodoItem['status'], string> = {
  pending: '○',
  in_progress: '⟳',
  completed: '✓'
}

type Filter = 'all' | 'edit' | 'command' | 'check' | 'approval' | 'read'

const FILTERS: { id: Filter; label: string; kinds: ActionKind[] }[] = [
  { id: 'all', label: 'Все', kinds: [] },
  { id: 'edit', label: 'Правки', kinds: ['edit', 'checkpoint'] },
  { id: 'command', label: 'Команды', kinds: ['command'] },
  { id: 'check', label: 'Проверки', kinds: ['check', 'review'] },
  { id: 'approval', label: 'Согласия', kinds: ['approval'] },
  { id: 'read', label: 'Чтение', kinds: ['read'] }
]

interface Group {
  id: string
  title: string
  at: number
  items: ToolTask[]
}

/** Действия по задачам: каждая ваша задача открывает группу, всё до первой — «Начало сессии». */
function groupByTask(tasks: ToolTask[]): Group[] {
  const groups: Group[] = []
  let current: Group | null = null
  for (const t of tasks) {
    if (kindOf(t) === 'task') {
      current = { id: t.id, title: t.summary, at: t.startedAt, items: [] }
      groups.push(current)
      continue
    }
    if (!current) {
      current = { id: 'session', title: 'Начало сессии', at: t.startedAt, items: [] }
      groups.push(current)
    }
    current.items.push(t)
  }
  return groups.reverse()
}

function duration(task: ToolTask): string | null {
  if (task.endedAt === null) return null
  const ms = task.endedAt - task.startedAt
  if (ms < 50) return null // мгновенные записи приложения — время не интересно
  if (ms < 1000) return `${ms} мс`
  return `${(ms / 1000).toFixed(1)} с`
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

export default function Tasks({ tasks, todos, usage }: Props): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('all')
  const groups = useMemo(() => groupByTask(tasks), [tasks])
  // Раскрытые группы (список действий рендерим только у них) и строки с подробностями.
  // Явный выбор пользователя по группам; без него раскрыта только первая (последняя задача).
  const [groupChoice, setGroupChoice] = useState<Record<string, boolean>>({})
  const [openRows, setOpenRows] = useState<Set<string>>(new Set())
  const toggleRow = (id: string): void =>
    setOpenRows((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const kinds = FILTERS.find((f) => f.id === filter)?.kinds ?? []
  const visible = (t: ToolTask): boolean => kinds.length === 0 || kinds.includes(kindOf(t))

  return (
    <aside className="tasks">
      {todos.length > 0 && (
        <div className="tasks__block">
          <h2 className="tasks__title">План</h2>
          <ul className="todos">
            {todos.map((todo, i) => (
              <li key={`${i}:${todo.content}`} className={`todo todo--${todo.status}`}>
                <span className="todo__mark">{TODO_MARK[todo.status]}</span>
                <span className="todo__text">
                  {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="tasks__block tasks__block--grow">
        <h2 className="tasks__title">Действия</h2>
        <div className="filters" role="tablist" aria-label="Фильтр действий">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              className={`filters__chip${filter === f.id ? ' filters__chip--on' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {groups.length === 0 ? (
          <p className="tasks__empty">Пока ничего не выполнялось.</p>
        ) : (
          <div className="groups">
            {groups.map((group, gi) => {
              const items = group.items.filter(visible).slice().reverse()
              if (filter !== 'all' && items.length === 0) return null
              const isOpen = groupChoice[group.id] ?? gi === 0
              const failed = group.items.some((t) => t.state === 'error')
              return (
                // Последняя задача раскрыта, прошлые свёрнуты — их можно развернуть.
                <details
                  key={group.id}
                  className="group"
                  open={isOpen}
                  onToggle={(e) => {
                    const on = e.currentTarget.open
                    // toggle приходит и после программного open — берём только расхождения.
                    if (on !== isOpen) setGroupChoice((prev) => ({ ...prev, [group.id]: on }))
                  }}
                >
                  <summary className={`group__head${failed ? ' group__head--failed' : ''}`}>
                    <span className="group__icon">▶</span>
                    <span className="group__title">{group.title}</span>
                    <span className="group__meta">
                      {timeLabel(group.at)} · {group.items.length}
                    </span>
                  </summary>
                  {isOpen && (
                    <ul className="tools">
                      {items.map((task) => {
                        const kind = kindOf(task)
                        const meta = KIND[kind]
                        const expanded = openRows.has(task.id)
                        const detail = task.detail && task.detail !== task.summary ? task.detail : null
                        return (
                          <li key={task.id} className={`tool act act--${kind} tool--${task.state}`}>
                            <span className="act__icon" title={meta.label}>
                              {task.state === 'running' ? STATE_MARK.running : meta.icon}
                            </span>
                            <div className="tool__body">
                              <button
                                type="button"
                                className="tool__toggle"
                                aria-expanded={expanded}
                                onClick={() => toggleRow(task.id)}
                              >
                              <span className="tool__name" title={task.name}>
                                {TOOL_LABEL[task.name] ?? task.name}
                                {task.state === 'error' && <span className="act__fail"> ✕</span>}
                              </span>
                              {task.summary && <span className="tool__summary">{task.summary}</span>}
                              {task.error && (
                                <span className={`tool__error${expanded ? '' : ' tool__error--clamp'}`}>
                                  {task.error}
                                </span>
                              )}
                              </button>
                              {expanded && detail && <pre className="tool__detail">{detail}</pre>}
                            </div>
                            {duration(task) && <span className="tool__time">{duration(task)}</span>}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </details>
              )
            })}
          </div>
        )}
      </div>

      <TokenChart usage={usage} />
    </aside>
  )
}

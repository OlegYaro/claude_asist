import { useMemo, useState } from 'react'
import type { ActionKind, TodoItem, ToolTask } from '../../shared/types'

interface Props {
  tasks: ToolTask[]
  todos: TodoItem[]
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

/** Значок и подпись типа — у каждого типа свой цвет (см. .act--<kind> в стилях). */
const KIND: Record<ActionKind, { icon: string; label: string }> = {
  task: { icon: '▶', label: 'Задача' },
  edit: { icon: '✎', label: 'Правка' },
  command: { icon: '❯', label: 'Команда' },
  read: { icon: '◌', label: 'Чтение' },
  approval: { icon: '⛉', label: 'Согласие' },
  check: { icon: '⚑', label: 'Проверка' },
  review: { icon: '◉', label: 'Ревью' },
  plan: { icon: '☰', label: 'План' },
  checkpoint: { icon: '⟲', label: 'Точка отката' },
  question: { icon: '?', label: 'Вопрос' },
  agent: { icon: '◈', label: 'Субагент' },
  system: { icon: '·', label: 'Служебное' }
}

/** Русские названия инструментов Claude; незнакомые показываем как есть. */
const TOOL_LABEL: Record<string, string> = {
  Read: 'Чтение',
  Write: 'Запись',
  Edit: 'Правка',
  MultiEdit: 'Правка',
  NotebookEdit: 'Правка блокнота',
  Bash: 'Команда',
  Glob: 'Поиск файлов',
  Grep: 'Поиск в коде',
  WebSearch: 'Поиск в интернете',
  WebFetch: 'Загрузка страницы',
  Agent: 'Субагент',
  Task: 'Субагент',
  TodoWrite: 'План',
  TaskCreate: 'Новая задача',
  TaskUpdate: 'Обновление задачи',
  AskUserQuestion: 'Вопрос',
  Skill: 'Навык',
  ExitPlanMode: 'План готов',
  EnterPlanMode: 'Переход к плану',
  ToolSearch: 'Поиск инструментов'
}

/** Тип действия Claude по имени инструмента; у записей приложения он задан явно. */
function kindOf(task: ToolTask): ActionKind {
  if (task.kind) return task.kind
  switch (task.name) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit'
    case 'Bash':
      return 'command'
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'WebSearch':
    case 'WebFetch':
    case 'ToolSearch':
      return 'read'
    case 'ExitPlanMode':
    case 'EnterPlanMode':
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'plan'
    case 'AskUserQuestion':
      return 'question'
    case 'Agent':
    case 'Task':
      return 'agent'
    default:
      return 'system'
  }
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

export default function Tasks({ tasks, todos }: Props): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('all')
  const groups = useMemo(() => groupByTask(tasks.slice(-400)), [tasks])
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
              const failed = group.items.some((t) => t.state === 'error')
              return (
                // Последняя задача раскрыта, прошлые свёрнуты — их можно развернуть.
                <details key={group.id} className="group" open={gi === 0}>
                  <summary className={`group__head${failed ? ' group__head--failed' : ''}`}>
                    <span className="group__icon">▶</span>
                    <span className="group__title">{group.title}</span>
                    <span className="group__meta">
                      {timeLabel(group.at)} · {group.items.length}
                    </span>
                  </summary>
                  <ul className="tools">
                    {items.map((task) => {
                      const kind = kindOf(task)
                      const meta = KIND[kind]
                      return (
                        <li key={task.id} className={`tool act act--${kind} tool--${task.state}`}>
                          <span className="act__icon" title={meta.label}>
                            {task.state === 'running' ? STATE_MARK.running : meta.icon}
                          </span>
                          <span className="tool__body">
                            <span className="tool__name" title={task.name}>
                              {TOOL_LABEL[task.name] ?? task.name}
                              {task.state === 'error' && <span className="act__fail"> ✕</span>}
                            </span>
                            {task.summary && <span className="tool__summary">{task.summary}</span>}
                            {task.error && <span className="tool__error">{task.error}</span>}
                          </span>
                          {duration(task) && <span className="tool__time">{duration(task)}</span>}
                        </li>
                      )
                    })}
                  </ul>
                </details>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}

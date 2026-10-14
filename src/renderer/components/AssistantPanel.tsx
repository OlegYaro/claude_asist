import { useState } from 'react'
import type { AssistantState, PendingQuestion, PluginRequest } from '../../shared/types'
import Markdown from './Markdown'

interface Props {
  state: AssistantState
  /** Отправить фразу — как если бы её сказали голосом. */
  onSay: (text: string) => void
  onPermission: (allow: boolean) => void
  /** Плагин, о котором просит Claude; показывается между задачами. */
  pluginRequest: PluginRequest | null
  onPlugin: (id: string | null) => void
}

/**
 * «Самое главное» над чатом: готовый план, вопрос Claude или рискованная
 * команда. Всё, что здесь есть, можно сделать и голосом — кнопки для тех
 * случаев, когда говорить неудобно.
 */
export default function AssistantPanel({
  state,
  onSay,
  onPermission,
  pluginRequest,
  onPlugin
}: Props): React.JSX.Element | null {
  switch (state.phase) {
    case 'starting':
      return <div className="assist assist--quiet">Запускаю Claude Code…</div>

    case 'planning':
      return (
        <div className="assist assist--quiet">
          <span className="assist__spinner" /> Claude изучает проект и составляет план…
        </div>
      )

    case 'executing':
      return (
        <div className="assist assist--quiet">
          <span className="assist__spinner" /> Claude работает — действия видны справа.
        </div>
      )

    case 'checking':
      return (
        <div className="assist assist--quiet">
          <span className="assist__spinner" /> Проверяю результат: тесты, типы, линтер, независимое ревью…
        </div>
      )

    case 'ready':
      if (pluginRequest) {
        return (
          <div className="assist assist--tip">
            <div className="assist__head">
              <strong>Claude просит подключить {pluginRequest.title}</strong>
              <span className="assist__hint">{pluginRequest.purpose}</span>
            </div>
            <div className="assist__body">
              Claude Code перезапустится в этой же сессии: переписка и окно сохранятся, плагин будет
              доступен до смены проекта.
            </div>
            <div className="assist__actions">
              <button className="btn btn--ghost" onClick={() => onPlugin(null)}>
                Не надо
              </button>
              <button className="btn btn--primary" onClick={() => onPlugin(pluginRequest.id)}>
                Подключить и перезапустить
              </button>
            </div>
          </div>
        )
      }
      return state.needsInit ? (
        <div className="assist assist--quiet assist--tip">
          <span>
            В проекте нет CLAUDE.md — памяти о его командах и правилах. Скажите «изучи проект», и
            Claude её составит: качество работы заметно вырастет.
          </span>
          <button className="btn btn--ghost btn--small" onClick={() => onSay('изучи проект')}>
            Изучить проект
          </button>
        </div>
      ) : null

    case 'plan-ready':
      return (
        <div className="assist assist--plan">
          <div className="assist__head">
            <strong>План готов</strong>
            <span className="assist__hint">Скажите «выполняй» — или что изменить</span>
          </div>
          <div className="assist__body">{state.plan ? <Markdown text={state.plan} /> : null}</div>
          <div className="assist__actions">
            <button className="btn btn--ghost" onClick={() => onSay('стоп')}>
              Отмена
            </button>
            <button className="btn btn--primary" onClick={() => onSay('выполняй')}>
              Выполнять
            </button>
          </div>
        </div>
      )

    case 'question':
      return state.question ? (
        // key: у следующего вопроса — свои отмеченные варианты.
        <QuestionCard
          key={`${state.question.index ?? 0}:${state.question.question}`}
          question={state.question}
          onSay={onSay}
        />
      ) : null

    case 'permission':
      return (
        <div className="assist assist--danger">
          <div className="assist__head">
            <strong>Нужно ваше согласие</strong>
            <span className="assist__hint">Скажите «да» или «нет»</span>
          </div>
          <div className="assist__body">
            <code className="assist__cmd">{state.permission?.summary}</code>
          </div>
          <div className="assist__actions">
            <button className="btn btn--ghost" onClick={() => onPermission(false)}>
              Запретить
            </button>
            <button className="btn btn--danger" onClick={() => onPermission(true)}>
              Разрешить
            </button>
          </div>
        </div>
      )

    default:
      return null
  }
}

/**
 * Вопрос Claude. Если вопросов несколько, они идут по одному. Один ответ уходит
 * сразу по кнопке; несколько вариантов отмечаются и уходят кнопкой «Готово» —
 * номерами, как если бы их назвали голосом («1, 3»).
 */
function QuestionCard({
  question,
  onSay
}: {
  question: PendingQuestion
  onSay: (text: string) => void
}): React.JSX.Element {
  const [picked, setPicked] = useState<number[]>([])
  const total = question.total ?? 1
  const multi = question.multiSelect === true
  const toggle = (n: number): void =>
    setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n].sort((a, b) => a - b)))

  return (
    <div className="assist assist--plan">
      <div className="assist__head">
        <strong>
          {total > 1 ? `Вопрос ${(question.index ?? 0) + 1} из ${total}` : 'Вопрос от Claude'}
        </strong>
        <span className="assist__hint">
          {multi ? 'Можно несколько: назовите номера, например «первый и третий»' : 'Назовите номер варианта'}
        </span>
      </div>
      <div className="assist__body">
        <Markdown text={question.question} />
      </div>
      <div className="assist__options">
        {question.options.map((option, i) =>
          multi ? (
            <button
              key={i}
              className={`btn ${picked.includes(i + 1) ? 'btn--primary' : 'btn--ghost'}`}
              aria-pressed={picked.includes(i + 1)}
              onClick={() => toggle(i + 1)}
            >
              {picked.includes(i + 1) ? '☑' : '☐'} {i + 1}. {option}
            </button>
          ) : (
            <button key={i} className="btn btn--ghost" onClick={() => onSay(String(i + 1))}>
              {i + 1}. {option}
            </button>
          )
        )}
      </div>
      {multi && (
        <div className="assist__actions">
          <button className="btn btn--primary" disabled={picked.length === 0} onClick={() => onSay(picked.join(', '))}>
            Готово
          </button>
        </div>
      )}
    </div>
  )
}

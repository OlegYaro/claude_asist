/**
 * Вопросы AskUserQuestion: Claude может задать до нескольких вопросов сразу,
 * в том числе с выбором нескольких вариантов. Ответ на все уходит одним
 * решением хука PermissionRequest: `allow` с `updatedInput.answers`
 * ({ текст вопроса: подпись варианта }, несколько вариантов — через «, »).
 * Так Claude Code получает ответ, не показывая диалог в терминале.
 */

export interface QuestionItem {
  question: string
  options: string[]
  multiSelect: boolean
}

/** Все вопросы из входа инструмента; пустой массив — разобрать нечего. */
export function parseQuestions(input: unknown): QuestionItem[] {
  const questions = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(questions)) return []
  const items: QuestionItem[] = []
  for (const q of questions) {
    const raw = q as { question?: unknown; options?: unknown; multiSelect?: unknown } | null
    if (!raw || typeof raw.question !== 'string') continue
    const options = Array.isArray(raw.options)
      ? raw.options
          .map((o) => (typeof o === 'string' ? o : (o as { label?: unknown } | null)?.label))
          .filter((o): o is string => typeof o === 'string')
      : []
    items.push({ question: raw.question, options, multiSelect: raw.multiSelect === true })
  }
  return items
}

/**
 * Номера, которые назвал пользователь, → ответ на вопрос (подписи вариантов).
 * null — номера не подходят: вне списка или несколько на вопрос с одним ответом.
 */
export function answerFor(item: QuestionItem, nums: number[]): string | null {
  if (nums.length === 0) return null
  if (!item.multiSelect && nums.length > 1) return null
  const labels: string[] = []
  for (const n of nums) {
    const label = item.options[n - 1]
    if (label === undefined) return null
    labels.push(label)
  }
  return labels.join(', ')
}

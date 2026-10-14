/**
 * Автовыбор модели: Claude в плане распределяет шаги по моделям (раздел «Модели»),
 * а приложение после проверок сверяет результат с планом и недоделанный шаг
 * отдаёт на ступень более сильной модели. Чистая логика без Electron — с тестами.
 */

export type StepModel = 'haiku' | 'sonnet' | 'opus'

export interface PlanStep {
  n: number
  text: string
  model: StepModel
}

/** Чего не хватает по итогам проверки полноты; step 0 — не относится к конкретному шагу. */
export interface MissingStep {
  step: number
  what: string
}

export interface Escalation {
  step: number
  title: string | null
  what: string
  model: StepModel
}

/** Ступени по силе; выше opus не поднимаемся. */
const LADDER: StepModel[] = ['haiku', 'sonnet', 'opus']

/** Модель, на которой исполняется задача без явного шага: исполнительная часть `opusplan`. */
const EXECUTOR_MODEL: StepModel = 'sonnet'

export function escalate(model: StepModel): StepModel {
  return LADDER[Math.min(LADDER.indexOf(model) + 1, LADDER.length - 1)]!
}

const HEADING = /^\s*#{1,6}\s+(.*)$/
const STEP = /^\s*(\d+)[.)]\s+(.+?)\s*[—–-]+\s*\**`?(haiku|sonnet|opus)`?\**\s*\.?\s*$/i

/**
 * Шаги из раздела «## Модели» плана: строки `1. что сделать — sonnet`.
 * Нет раздела или строк в этом формате — пустой список.
 */
export function parsePlanModels(plan: string): PlanStep[] {
  const steps: PlanStep[] = []
  let inside = false
  for (const line of plan.split('\n')) {
    const heading = HEADING.exec(line)
    if (heading) {
      inside = /^модели(?!\p{L})/iu.test(heading[1]!.replace(/[*_`]/g, '').trim())
      continue
    }
    if (!inside) continue
    const m = STEP.exec(line)
    if (!m) continue
    steps.push({
      n: Number(m[1]),
      text: m[2]!.replace(/[*_`]/g, '').trim(),
      model: m[3]!.toLowerCase() as StepModel
    })
  }
  return steps
}

/**
 * Для каждого недоделанного пункта — модель на ступень сильнее той, что уже пробовали.
 * `tried` — номер шага → последняя модель; обновляется, чтобы следующий круг
 * поднялся ещё выше. Пункт без шага считается сделанным исполнителем сессии.
 */
export function planEscalations(
  missing: MissingStep[],
  steps: PlanStep[],
  tried: Map<number, StepModel>
): Escalation[] {
  return missing.map((item) => {
    const step = steps.find((s) => s.n === item.step) ?? null
    const prev = tried.get(item.step) ?? step?.model ?? EXECUTOR_MODEL
    const model = escalate(prev)
    tried.set(item.step, model)
    return { step: item.step, title: step?.text ?? null, what: item.what, model }
  })
}

/** Задание Claude через Stop-хук: доделать пункты субагентами на указанных моделях. */
export function completionReason(escalations: Escalation[]): string {
  const lines = escalations.map((e) => {
    const where = e.step > 0 ? `Шаг ${e.step}${e.title ? ` «${e.title}»` : ''}` : 'Вне шагов плана'
    return `- ${where}: ${e.what}\n  Перезапусти субагентом (Agent) с model: "${e.model}".`
  })
  return [
    'Проверка полноты: по одобренному плану сделано не всё.',
    ...lines,
    '',
    'Доделай только это. Дождись результата субагентов, затем снова запусти проверки проекта и коротко отчитайся.'
  ].join('\n')
}

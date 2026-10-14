import type { ActionKind } from '../shared/types'
import type { TokenCategory } from '../shared/token-stats'

/** Значок и подпись типа — у каждого типа свой цвет (см. .act--<kind> в стилях). */
export const KIND: Record<ActionKind, { icon: string; label: string }> = {
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

/** Подпись категории токенов: тип действия или «Ответ модели». */
export function categoryLabel(c: TokenCategory): string {
  return c === 'answer' ? 'Ответ модели' : KIND[c].label
}

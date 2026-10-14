import type { ActionKind, ToolTask } from './types.ts'

/** Русские названия инструментов Claude; незнакомые показываем как есть. */
export const TOOL_LABEL: Record<string, string> = {
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

/** Тип действия Claude по имени инструмента. */
function kindOfTool(name: string): ActionKind {
  switch (name) {
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

/** Тип действия Claude по имени инструмента; у записей приложения он задан явно. */
export function kindOf(task: ToolTask): ActionKind {
  return task.kind ?? kindOfTool(task.name)
}

/** Служебные имена шагов самого приложения (как ACTION_KIND в assistant.ts). */
const APP_KIND: Record<string, ActionKind> = {
  Задача: 'task',
  Изучение: 'task',
  Согласие: 'approval',
  Проверка: 'check',
  Проверки: 'check',
  Ревью: 'review',
  План: 'plan',
  'Точка отката': 'checkpoint',
  Откат: 'checkpoint',
  Git: 'checkpoint',
  Ответ: 'question'
}

/** Категория токенов ответа: без инструментов — 'answer', иначе тип первого инструмента. */
export function usageCategory(tools: string[]): ActionKind | 'answer' {
  if (tools.length === 0) return 'answer'
  return categoryOfName(tools[0] ?? '')
}

/** Категория одного имени: инструмент Claude или служебный шаг приложения. */
export function categoryOfName(name: string): ActionKind {
  return APP_KIND[name] ?? kindOfTool(name)
}

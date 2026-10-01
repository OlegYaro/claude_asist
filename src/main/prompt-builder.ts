import Anthropic from '@anthropic-ai/sdk'
import { readdirSync } from 'node:fs'
import { getApiKey } from './secrets'
import { loadSettings } from './settings'
import type { AppError, GeneratedPrompt, PromptContext } from '../shared/types'

/**
 * Превращает сырую расшифровку речи в чёткую задачу для Claude Code.
 *
 * Живёт в main-процессе: ключ не должен попадать в renderer. Шаг опциональный —
 * без ключа приложение работает, просто отправляет расшифровку как есть.
 */

export class PromptBuildError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'PromptBuildError'
  }
}

const SYSTEM_PROMPT = `Ты — помощник, который превращает надиктованную вслух реплику в точную задачу для Claude Code (агента-программиста, работающего в терминале внутри проекта пользователя).

Правила:
- Сохраняй исходный смысл. Не придумывай требований, которых не было, и не расширяй объём задачи.
- Убирай слова-паразиты, оговорки и самоповторы устной речи.
- Исправляй очевидные ошибки распознавания по контексту проекта: например, если в тексте встречается бессмысленное слово, а рядом по смыслу подходит имя файла, команда или технический термин из списка файлов проекта — используй правильный вариант.
- Пиши на том же языке, на котором говорил пользователь.
- Формулируй как прямое указание к действию, без вежливых вступлений и без пояснений о том, что ты сделал.
- Если реплика — вопрос, оставь её вопросом, а не превращай в задание.
- Не добавляй в промт фразы вроде «пожалуйста» или «спасибо».

Верни JSON с двумя полями:
- prompt: готовый текст задачи;
- title: очень короткий (до 6 слов) заголовок для истории чата.`

/** Схема ответа: `messages.parse` проверит её и вернёт типизированный объект. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Готовый текст задачи для Claude Code' },
    title: { type: 'string', description: 'Короткий заголовок, до 6 слов' }
  },
  required: ['prompt', 'title'],
  additionalProperties: false
} as const

/** Верхний уровень дерева проекта — помогает исправить распознанные имена файлов. */
function projectOutline(dir: string, limit = 60): string {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .slice(0, limit)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    return entries.join(', ')
  } catch {
    return ''
  }
}

function buildUserMessage(ctx: PromptContext): string {
  const parts: string[] = []
  parts.push(`Папка проекта: ${ctx.projectDir}`)

  const outline = projectOutline(ctx.projectDir)
  if (outline) parts.push(`Файлы верхнего уровня: ${outline}`)

  if (ctx.todos.length > 0) {
    const todoList = ctx.todos
      .map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`)
      .join('\n')
    parts.push(`Текущий план работы:\n${todoList}`)
  }

  if (ctx.recentMessages.length > 0) {
    const history = ctx.recentMessages
      .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Claude'}: ${m.text.slice(0, 400)}`)
      .join('\n')
    parts.push(`Последние реплики диалога:\n${history}`)
  }

  parts.push(`Надиктованная реплика: «${ctx.transcript}»`)
  return parts.join('\n\n')
}

export async function buildPrompt(ctx: PromptContext): Promise<GeneratedPrompt> {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new PromptBuildError({
      code: 'no-api-key',
      message: 'Не задан API-ключ Anthropic',
      hint: 'Добавьте ключ в настройках — или отправьте расшифровку как есть, без обработки.'
    })
  }

  const client = new Anthropic({ apiKey })
  const model = loadSettings().promptModel

  try {
    // `parse` валидирует ответ по схеме, поэтому разбирать текст руками не нужно.
    // Ни thinking, ни effort не задаём: для перефразирования они не нужны,
    // а на Haiku 4.5 параметр effort и вовсе не поддерживается.
    const response = await client.messages.parse({
      model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(ctx) }],
      output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } }
    })

    const parsed = response.parsed_output as GeneratedPrompt | null
    if (!parsed?.prompt?.trim()) {
      throw new PromptBuildError({
        code: 'api-error',
        message: 'Модель вернула пустой промт',
        hint: 'Попробуйте ещё раз или отправьте расшифровку как есть.'
      })
    }

    return {
      prompt: parsed.prompt.trim(),
      title: parsed.title?.trim() || parsed.prompt.trim().slice(0, 40)
    }
  } catch (err) {
    if (err instanceof PromptBuildError) throw err
    throw new PromptBuildError(toAppError(err))
  }
}

/**
 * Типизированные классы ошибок SDK вместо сопоставления по тексту сообщения:
 * текст меняется от версии к версии, класс — нет.
 */
function toAppError(err: unknown): AppError {
  if (err instanceof Anthropic.AuthenticationError) {
    return {
      code: 'api-auth',
      message: 'API-ключ отклонён',
      hint: 'Проверьте ключ в настройках приложения.'
    }
  }
  if (err instanceof Anthropic.RateLimitError) {
    return {
      code: 'api-rate-limit',
      message: 'Слишком много запросов к Claude API',
      hint: 'Подождите немного и попробуйте снова.'
    }
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return {
      code: 'api-error',
      message: 'Не удалось связаться с Claude API',
      hint: 'Проверьте подключение к сети.'
    }
  }
  if (err instanceof Anthropic.APIError) {
    return { code: 'api-error', message: `Ошибка Claude API: ${err.message}` }
  }
  return {
    code: 'unknown',
    message: err instanceof Error ? err.message : 'Неизвестная ошибка при генерации промта'
  }
}

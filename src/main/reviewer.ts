import { execFile } from 'node:child_process'
import { getLoginShellEnv, resolveClaudeBin } from './paths'
import { loadSettings } from './settings'
import type { MissingStep } from './model-routing'
import type { TokenUsage } from '../shared/types'
import { parseUsage } from '../shared/token-stats'
import { dominantModel } from '../shared/limit-estimate'

export interface ReviewIssue {
  file: string
  problem: string
  fix: string
}

export interface ReviewInput {
  dir: string
  /** Что просил пользователь. */
  task: string
  /** Одобренный план, если был. */
  plan: string | null
  /** Точка отката до задачи: `git diff <sha>` покажет ровно изменения задачи. */
  baseSha: string | null
  /** Файлы, которые правили инструментами, — для проектов без git. */
  files: string[]
}

const REVIEW_TIMEOUT_MS = 4 * 60_000

const SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'файл:строка' },
          problem: { type: 'string' },
          fix: { type: 'string' }
        },
        required: ['file', 'problem', 'fix']
      }
    }
  },
  required: ['ok', 'issues']
}

function changesLocation(input: ReviewInput): string {
  return input.baseSha
    ? `Изменения задачи: \`git diff ${input.baseSha}\` (это точка до начала задачи) плюс новые неотслеживаемые файлы из \`git status --porcelain\`.`
    : `Изменённые файлы: ${input.files.length ? input.files.join(', ') : 'смотри git status / git diff, если это git-репозиторий'}.`
}

function reviewPrompt(input: ReviewInput): string {
  const where = changesLocation(input)
  return [
    'Ты — строгий старший инженер и делаешь независимое ревью изменений. Ты ничего не меняешь — только читаешь.',
    '',
    `Задача пользователя: «${input.task}»`,
    input.plan ? `\nОдобренный план:\n${input.plan.slice(0, 4000)}` : '',
    '',
    where,
    'Прочитай окружающий код, чтобы понимать контекст.',
    '',
    'Проверь: корректность и граничные случаи; обработку ошибок; соответствие задаче и плану (всё ли сделано, нет ли лишнего);',
    'безопасность (инъекции, секреты, небезопасный ввод); тесты на новое поведение; следование паттернам проекта;',
    'заглушки, TODO, подавленные ошибки, ослабленные типы и проверки.',
    '',
    'Сообщай ТОЛЬКО проблемы, которые влияют на корректность, безопасность или требования задачи. Стиль и вкусовщину не упоминай:',
    'погоня за мелочами ведёт к переусложнению. Нет существенных проблем — ok: true и пустой список.',
    'Для каждой проблемы: file — «файл:строка», problem — что не так, fix — как исправить. Пиши по-русски.'
  ].join('\n')
}

/**
 * Независимое ревью отдельным запуском Claude Code (`claude -p`): чистый контекст,
 * только чтение, ответ по JSON-схеме. Не субагент основной сессии — тот в этой
 * версии CLI всегда уходит в фон, и Claude заканчивал работу, не дождавшись ревью.
 *
 * null — ревью не удалось (нет claude, таймаут, сбой); это не повод держать задачу.
 */
export async function reviewChanges(
  input: ReviewInput,
  signal?: AbortSignal
): Promise<{ issues: ReviewIssue[] | null; usage: TokenUsage | null; model: string | null }> {
  const run = await runReadonlyClaude(input.dir, reviewPrompt(input), SCHEMA, null, signal)
  const issues = (run.output as { issues?: ReviewIssue[] } | null)?.issues
  return {
    issues: Array.isArray(issues) ? issues.filter((i) => i && i.problem) : null,
    usage: run.usage,
    model: run.model
  }
}

const COMPLETION_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    missing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          step: { type: 'integer', description: 'номер шага из раздела «Модели»; 0 — не относится к шагу' },
          what: { type: 'string' }
        },
        required: ['step', 'what']
      }
    }
  },
  required: ['done', 'missing']
}

function completionPrompt(input: ReviewInput & { plan: string }): string {
  return [
    'Ты проверяешь только полноту: выполнено ли всё, что обещал одобренный план. Ты ничего не меняешь — только читаешь.',
    '',
    `Задача пользователя: «${input.task}»`,
    `\nОдобренный план:\n${input.plan.slice(0, 6000)}`,
    '',
    changesLocation(input),
    '',
    'Сверь каждый пункт плана с изменениями. Качество, стиль и баги не оценивай — это сделает ревью после тебя.',
    'Не считай невыполненным то, что по плану делает сам пользователь (установить, настроить, перезапустить).',
    'Всё сделано — done: true и пустой список. Иначе для каждого недоделанного пункта: step — номер шага',
    'из раздела «Модели» плана (0, если такого раздела нет или пункт к шагу не относится), what — чего именно',
    'не хватает, одной фразой. Пиши по-русски.'
  ].join('\n')
}

/**
 * Проверка полноты перед ревью (автовыбор модели): отдельный `claude -p` на Sonnet —
 * сверить план с диффом хватает средней модели. null — проверка не удалась.
 */
export async function checkCompletion(
  input: ReviewInput & { plan: string },
  signal?: AbortSignal
): Promise<{ missing: MissingStep[] | null; usage: TokenUsage | null; model: string | null }> {
  const run = await runReadonlyClaude(input.dir, completionPrompt(input), COMPLETION_SCHEMA, 'sonnet', signal)
  const out = run.output as { done?: boolean; missing?: MissingStep[] } | null
  if (!out || !Array.isArray(out.missing)) return { missing: null, usage: run.usage, model: run.model }
  const missing = out.missing.filter((m) => m && typeof m.what === 'string' && m.what.trim())
  return {
    missing: missing.map((m) => ({ step: Number.isInteger(m.step) && m.step > 0 ? m.step : 0, what: m.what.trim() })),
    usage: run.usage,
    model: run.model
  }
}

/** `claude -p` только на чтение с ответом по JSON-схеме; output null — запуск не удался. usage — расход токенов за весь запуск. */
async function runReadonlyClaude(
  dir: string,
  prompt: string,
  schema: object,
  model: string | null,
  signal?: AbortSignal
): Promise<{ output: unknown; usage: TokenUsage | null; model: string | null }> {
  const failed = { output: null, usage: null, model: null }
  const bin = await resolveClaudeBin(loadSettings().claudeBinPath)
  if (!bin) return failed
  const env = await getLoginShellEnv()

  return new Promise((resolve) => {
    execFile(
      bin,
      [
        '-p',
        prompt,
        ...(model ? ['--model', model] : []),
        '--tools',
        'Read,Grep,Glob,Bash',
        // Bash — только git на чтение. --restricted не читает настройки пользователя:
        // его глобальное `allow: ["Bash"]` разрешило бы ревьюеру любую команду,
        // а dontAsk отклоняет всё, что не разрешено здесь. Правила — отдельными
        // аргументами: через запятую CLI правила со скобками не разбирает.
        '--allowedTools',
        'Read',
        'Grep',
        'Glob',
        'Bash(git diff:*)',
        'Bash(git status:*)',
        'Bash(git log:*)',
        'Bash(git show:*)',
        '--disallowedTools',
        'Edit,Write,MultiEdit,NotebookEdit',
        '--restricted',
        '--permission-mode',
        'dontAsk',
        '--no-session-persistence',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(schema)
      ],
      {
        cwd: dir,
        env,
        timeout: REVIEW_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        ...(signal ? { signal } : {})
      },
      (err, stdout) => {
        if (err && !stdout) return resolve(failed)
        try {
          const out = JSON.parse(stdout) as { structured_output?: unknown; usage?: unknown; modelUsage?: unknown }
          // Фактическая модель — из modelUsage; без неё — та, что просили (null: у пользователя по умолчанию).
          resolve({
            output: out.structured_output ?? null,
            usage: parseUsage(out.usage),
            model: dominantModel(out.modelUsage) ?? model
          })
        } catch {
          resolve(failed)
        }
      }
    )
  })
}

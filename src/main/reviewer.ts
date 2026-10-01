import { execFile } from 'node:child_process'
import { getLoginShellEnv, resolveClaudeBin } from './paths'
import { loadSettings } from './settings'

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

function reviewPrompt(input: ReviewInput): string {
  const where = input.baseSha
    ? `Изменения задачи: \`git diff ${input.baseSha}\` (это точка до начала задачи) плюс новые неотслеживаемые файлы из \`git status --porcelain\`.`
    : `Изменённые файлы: ${input.files.length ? input.files.join(', ') : 'смотри git status / git diff, если это git-репозиторий'}.`
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
export async function reviewChanges(input: ReviewInput, signal?: AbortSignal): Promise<ReviewIssue[] | null> {
  const bin = await resolveClaudeBin(loadSettings().claudeBinPath)
  if (!bin) return null
  const env = await getLoginShellEnv()

  return new Promise((resolve) => {
    execFile(
      bin,
      [
        '-p',
        reviewPrompt(input),
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
        JSON.stringify(SCHEMA)
      ],
      {
        cwd: input.dir,
        env,
        timeout: REVIEW_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        ...(signal ? { signal } : {})
      },
      (err, stdout) => {
        if (err && !stdout) return resolve(null)
        try {
          const out = JSON.parse(stdout) as { structured_output?: { ok?: boolean; issues?: ReviewIssue[] } }
          const issues = out.structured_output?.issues
          resolve(Array.isArray(issues) ? issues.filter((i) => i && i.problem) : null)
        } catch {
          resolve(null)
        }
      }
    )
  })
}

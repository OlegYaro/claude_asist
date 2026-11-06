/**
 * Правила разрешений для инструментов Claude Code: какие действия ассистент
 * одобряет сам, о каких спрашивает голосом, какие запрещает. Чистая логика без
 * Electron — используется и в main (хук PreToolUse), и в окне настроек.
 */

/** «Сам», «спросить меня голосом», «запретить». */
export type PermMode = 'allow' | 'ask' | 'deny'
export type PermGroup = 'safe' | 'danger'

export const PERM_MODES: readonly PermMode[] = ['allow', 'ask', 'deny']

/** Порядок важен: опасные идут раньше безопасных, среди опасных — от самого строгого. */
export const PERM_RULE_IDS = [
  'rm-rf',
  'sudo',
  'git-history',
  'git-push',
  'disk',
  'pipe-shell',
  'drop-db',
  'edit',
  'bash-read',
  'bash-other',
  'install',
  'web',
  'mcp'
] as const

export type PermRuleId = (typeof PERM_RULE_IDS)[number]

export interface PermRule {
  id: PermRuleId
  group: PermGroup
  label: string
  hint: string
  default: PermMode
  match(tool: string, input: unknown): boolean
}

/** Команды Bash, которые точно ничего не меняют, — проверки после них не нужны. */
const READONLY_BASH =
  /^\s*(ls|cat|head|tail|less|grep|rg|find|fd|pwd|echo|printf|wc|which|whoami|date|tree|file|stat|du|df|env|node\s+-v|npm\s+(ls|view|-v)|git\s+(status|log|diff|show|branch|remote|rev-parse|blame))\b[^;&|>]*$/

/** Опасные команды. Применяются ко всей строке, чтобы ловить и составные (`a && rm -rf x`). */
const RM_RF = /\brm\s+(-\w*\s+)*-\w*[rR]\w*f|\brm\s+(-\w*\s+)*-\w*f\w*[rR]/
const SUDO = /\bsudo\b/
const GIT_HISTORY = [
  /\bgit\s+push\b.*(--force|\s-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-\w*f/
]
const GIT_PUSH = /\bgit\s+push\b/
const DISK = [/\bmkfs\b|\bdd\s+if=/, /\bchmod\s+-R\s+777\b/]
const PIPE_SHELL = /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/
const DROP_DB = /\bdrop\s+(table|database)\b/i

/** Установка пакетов: в любом месте команды, в том числе в составной. */
const INSTALL = [
  /\b(npm|pnpm|yarn|bun)\s+(add|install|i|ci)\b/,
  /\b(pip3?|pipx|uv\s+pip|python3?\s+-m\s+pip)\s+install\b/,
  /\b(uv|poetry)\s+add\b/,
  /\bbrew\s+(install|reinstall)\b/,
  /\bcargo\s+(add|install)\b/,
  /\bgem\s+install\b/,
  /\bgo\s+(install|get)\b/,
  /\b(apt|apt-get|port)\s+install\b/
]

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])

/** Текст команды Bash или null, если инструмент не Bash. Без строки команды — пустая строка. */
function bashCommand(tool: string, input: unknown): string | null {
  if (tool !== 'Bash') return null
  if (typeof input !== 'object' || input === null || !('command' in input)) return ''
  const command = (input as { command: unknown }).command
  return typeof command === 'string' ? command : ''
}

function bashRule(test: (command: string) => boolean) {
  return (tool: string, input: unknown): boolean => {
    const command = bashCommand(tool, input)
    return command !== null && test(command)
  }
}

const anyOf = (patterns: readonly RegExp[]) => (command: string) =>
  patterns.some((re) => re.test(command))

/** Команда только на чтение: вся строка, без `;`, `&`, `|` и перенаправления в файл. */
export function isReadOnlyBash(command: string): boolean {
  return READONLY_BASH.test(command)
}

const DANGER_RULES: readonly PermRule[] = [
  {
    id: 'rm-rf',
    group: 'danger',
    label: 'Рекурсивное удаление (rm -rf)',
    hint: 'Удалённое так не попадает в корзину и не откатывается.',
    default: 'ask',
    match: bashRule((c) => RM_RF.test(c))
  },
  {
    id: 'sudo',
    group: 'danger',
    label: 'Команды от администратора (sudo)',
    hint: 'Любая команда с правами суперпользователя.',
    default: 'ask',
    match: bashRule((c) => SUDO.test(c))
  },
  {
    id: 'git-history',
    group: 'danger',
    label: 'Перезапись истории git',
    hint: 'git push --force, git reset --hard, git clean -f: изменения можно потерять безвозвратно.',
    default: 'ask',
    match: bashRule(anyOf(GIT_HISTORY))
  },
  {
    id: 'git-push',
    group: 'danger',
    label: 'Отправка в удалённый репозиторий (git push)',
    hint: 'Обычный git push без --force: изменения становятся видны другим.',
    default: 'ask',
    match: bashRule((c) => GIT_PUSH.test(c))
  },
  {
    id: 'disk',
    group: 'danger',
    label: 'Диск и права доступа',
    hint: 'mkfs, dd if=, chmod -R 777.',
    default: 'ask',
    match: bashRule(anyOf(DISK))
  },
  {
    id: 'pipe-shell',
    group: 'danger',
    label: 'Запуск скрипта из сети',
    hint: 'curl или wget, переданные прямо в sh/bash/zsh.',
    default: 'ask',
    match: bashRule((c) => PIPE_SHELL.test(c))
  },
  {
    id: 'drop-db',
    group: 'danger',
    label: 'Удаление базы данных',
    hint: 'DROP TABLE и DROP DATABASE.',
    default: 'ask',
    match: bashRule((c) => DROP_DB.test(c))
  }
]

const isDangerBash = (tool: string, input: unknown): boolean =>
  DANGER_RULES.some((rule) => rule.match(tool, input))

const isInstall = anyOf(INSTALL)

const SAFE_RULES: readonly PermRule[] = [
  {
    id: 'edit',
    group: 'safe',
    label: 'Правка файлов',
    hint: 'Edit, Write, MultiEdit, NotebookEdit. «Спросить» остановит работу на каждой правке.',
    default: 'allow',
    match: (tool) => EDIT_TOOLS.has(tool)
  },
  {
    id: 'bash-read',
    group: 'safe',
    label: 'Команды только на чтение',
    hint: 'ls, cat, grep, git status, git diff и подобные — без перенаправления в файл.',
    default: 'allow',
    match: bashRule(isReadOnlyBash)
  },
  {
    id: 'bash-other',
    group: 'safe',
    label: 'Прочие команды терминала',
    hint: 'Сборка, тесты, npm run и всё, что не попало в другие правила.',
    default: 'allow',
    match: (tool, input) => {
      const command = bashCommand(tool, input)
      return (
        command !== null &&
        !isDangerBash(tool, input) &&
        !isReadOnlyBash(command) &&
        !isInstall(command)
      )
    }
  },
  {
    id: 'install',
    group: 'safe',
    label: 'Установка пакетов',
    hint: 'npm/pnpm/yarn/bun add или install, pip install, brew install, cargo add и т. п.',
    default: 'allow',
    match: bashRule(isInstall)
  },
  {
    id: 'web',
    group: 'safe',
    label: 'Интернет',
    hint: 'WebFetch и WebSearch: чтение страниц и поиск.',
    default: 'allow',
    match: (tool) => WEB_TOOLS.has(tool)
  },
  {
    id: 'mcp',
    group: 'safe',
    label: 'MCP-инструменты',
    hint: 'Инструменты подключённых MCP-серверов (mcp__…).',
    default: 'allow',
    match: (tool) => tool.startsWith('mcp__')
  }
]

/** Все правила: сначала опасные (от самого строгого), потом безопасные. */
export const PERMISSION_RULES: readonly PermRule[] = [...DANGER_RULES, ...SAFE_RULES]

/**
 * Первое совпавшее правило. Опасные проверяются раньше безопасных, поэтому
 * `git push --force` — это «перезапись истории», а не обычный push.
 * Неизвестный инструмент (Read, Grep, Agent…) → null.
 */
export function classify(tool: string, input: unknown): PermRule | null {
  return PERMISSION_RULES.find((rule) => rule.match(tool, input)) ?? null
}

export function isPermMode(value: unknown): value is PermMode {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

/**
 * Режим правила с учётом настроек. `loadSettings` склеивает с дефолтами только
 * верхний уровень, поэтому отсутствующее или испорченное значение → дефолт правила.
 */
export function permissionMode(
  overrides: Partial<Record<string, PermMode>> | undefined,
  rule: PermRule
): PermMode {
  const value: unknown = overrides?.[rule.id]
  return isPermMode(value) ? value : rule.default
}

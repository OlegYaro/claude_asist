import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

/** Кандидаты на случай, если login shell недоступен или PATH не содержит claude. */
const FALLBACK_BINS = [
  join(homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude'
]

let cachedEnv: NodeJS.ProcessEnv | null = null
let cachedBin: string | null = null

/**
 * Маркеры, которые Claude Code выставляет своим дочерним процессам.
 *
 * Если они утекут в наш PTY, запущенный claude сочтёт себя вложенной дочерней
 * сессией и ВЫКЛЮЧИТ запись транскрипта («Transcript saving is off — inherited
 * CLAUDE_CODE_CHILD_SESSION marker»). Панель задач держится на транскрипте,
 * поэтому такая утечка ломает половину приложения — молча, без ошибок.
 *
 * Утечка реальна: переменные наследуются, если приложение (или dev-сборка)
 * запущено изнутри сессии Claude Code, и переживают даже login shell.
 */
const INHERITED_CLAUDE_MARKERS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT'
]

function stripInheritedMarkers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env }
  for (const key of INHERITED_CLAUDE_MARKERS) delete clean[key]
  return clean
}

/**
 * GUI-приложения на macOS запускаются из launchd и не наследуют PATH из шелла,
 * поэтому окружение приходится добывать из login shell отдельно. Оно же нужно
 * самому Claude Code, чтобы найти свои инструменты и keychain-авторизацию.
 */
export async function getLoginShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (cachedEnv) return cachedEnv

  const shell = process.env.SHELL || '/bin/zsh'
  try {
    // Нулевой разделитель: значения переменных могут содержать переводы строк.
    const { stdout } = await execFileAsync(shell, ['-lic', 'env -0'], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024
    })
    const env: NodeJS.ProcessEnv = {}
    for (const entry of stdout.split('\0')) {
      if (!entry) continue
      const eq = entry.indexOf('=')
      if (eq <= 0) continue
      env[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
    // Если шелл вернул мусор — не затираем рабочее окружение процесса.
    cachedEnv = stripInheritedMarkers(env.PATH ? { ...process.env, ...env } : { ...process.env })
  } catch {
    cachedEnv = stripInheritedMarkers({ ...process.env })
  }
  return cachedEnv
}

/**
 * Находит бинарь `claude`. `override` — явный путь из настроек, он всегда в приоритете.
 * Возвращает null, если бинарь не найден: вызывающий код показывает понятную ошибку.
 */
export async function resolveClaudeBin(override?: string | null): Promise<string | null> {
  if (override && existsSync(override)) return override
  if (cachedBin && existsSync(cachedBin)) return cachedBin

  const env = await getLoginShellEnv()
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const { stdout } = await execFileAsync(shell, ['-lic', 'command -v claude'], {
      timeout: 5000,
      env
    })
    const found = stdout.trim().split('\n').pop()?.trim()
    if (found && existsSync(found)) {
      cachedBin = found
      return found
    }
  } catch {
    // проваливаемся в список кандидатов
  }

  for (const candidate of FALLBACK_BINS) {
    if (existsSync(candidate)) {
      cachedBin = candidate
      return candidate
    }
  }
  return null
}

/** Абсолютный путь к `node` — нужен для bridge-скрипта, запускаемого в Terminal.app. */
export async function resolveNodeBin(): Promise<string | null> {
  const env = await getLoginShellEnv()
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const { stdout } = await execFileAsync(shell, ['-lic', 'command -v node'], {
      timeout: 5000,
      env
    })
    const found = stdout.trim().split('\n').pop()?.trim()
    if (found && existsSync(found)) return found
  } catch {
    // ниже — статические кандидаты
  }
  for (const candidate of ['/usr/local/bin/node', '/opt/homebrew/bin/node']) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Корень пользовательских данных Claude Code. */
export function claudeHome(): string {
  return join(homedir(), '.claude')
}

/** Каталог, в котором Claude Code держит транскрипты по проектам. */
export function claudeProjectsDir(): string {
  return join(claudeHome(), 'projects')
}

/** Версия CLI — показываем в статус-баре, чтобы было видно, на чём мы работаем. */
export async function claudeVersion(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

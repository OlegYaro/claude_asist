import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { getLoginShellEnv } from './paths.ts'

const execFileAsync = promisify(execFile)

/** Одна проверка проекта: команда, которая завершается кодом 0, если всё хорошо. */
export interface Check {
  name: string
  command: string
}

export interface CheckResult extends Check {
  ok: boolean
  /** Инструмент не установлен (код 127) — не считаем это провалом. */
  skipped: boolean
  code: number | null
  /** Хвост вывода — его увидит Claude, если проверка упала. */
  output: string
  ms: number
}

const CHECK_TIMEOUT_MS = 10 * 60_000
const OUTPUT_TAIL = 3500

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function packageManager(dir: string): string {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun'
  return 'npm'
}

/** Скрипт-заглушка из `npm init` — это не тесты. */
const PLACEHOLDER_TEST = /no test specified/

function nodeChecks(dir: string): Check[] {
  const pkg = readJson(join(dir, 'package.json'))
  if (!pkg) return []
  const scripts = (pkg['scripts'] ?? {}) as Record<string, string>
  const run = (script: string): string => {
    const pm = packageManager(dir)
    return pm === 'npm' ? `npm run -s ${script}` : `${pm} run ${script}`
  }
  const checks: Check[] = []

  const typecheck = ['typecheck', 'type-check', 'check-types', 'tsc'].find((s) => scripts[s])
  if (typecheck) {
    checks.push({ name: 'Типы', command: run(typecheck) })
  } else if (existsSync(join(dir, 'tsconfig.json'))) {
    // Проект-ссылки (references) tsc без -b не проверит — тогда не угадываем.
    const tsconfig = readText(join(dir, 'tsconfig.json'))
    const deps = { ...(pkg['dependencies'] as object), ...(pkg['devDependencies'] as object) }
    if (!/"references"/.test(tsconfig) && 'typescript' in deps) {
      checks.push({ name: 'Типы', command: 'npx tsc --noEmit' })
    }
  }

  if (scripts['lint']) checks.push({ name: 'Линтер', command: run('lint') })

  const test = scripts['test']
  if (test && !PLACEHOLDER_TEST.test(test)) checks.push({ name: 'Тесты', command: run('test') })
  // Дополнительные наборы (test:unit, test:cli…), кроме долгих и интерактивных.
  for (const name of Object.keys(scripts)) {
    if (/^test:/.test(name) && !/watch|e2e|ui|dev|coverage|debug/i.test(name)) {
      checks.push({ name: `Тесты (${name.slice(5)})`, command: run(name) })
    }
  }
  return checks
}

function pythonChecks(dir: string): Check[] {
  const pyproject = readText(join(dir, 'pyproject.toml'))
  const isPython =
    pyproject !== '' || existsSync(join(dir, 'setup.py')) || existsSync(join(dir, 'requirements.txt'))
  if (!isPython) return []
  const checks: Check[] = []
  if (/\[tool\.ruff/.test(pyproject) || existsSync(join(dir, 'ruff.toml'))) {
    checks.push({ name: 'Линтер', command: 'ruff check .' })
  }
  if (/\[tool\.mypy/.test(pyproject) || existsSync(join(dir, 'mypy.ini'))) {
    checks.push({ name: 'Типы', command: 'mypy .' })
  }
  const hasTests =
    existsSync(join(dir, 'tests')) ||
    existsSync(join(dir, 'pytest.ini')) ||
    /\[tool\.pytest/.test(pyproject) ||
    safeList(dir).some((f) => /^test_.*\.py$|_test\.py$/.test(f))
  if (hasTests) checks.push({ name: 'Тесты', command: 'python3 -m pytest -q -x' })
  return checks
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Какие проверки есть в проекте. Берём только то, что проект объявил сам
 * (скрипты, конфиги) — ничего не устанавливаем и не придумываем.
 */
export function detectChecks(dir: string): Check[] {
  const checks = [...nodeChecks(dir), ...pythonChecks(dir)]
  if (existsSync(join(dir, 'Cargo.toml'))) {
    checks.push({ name: 'Сборка и тесты', command: 'cargo test --quiet' })
  }
  if (existsSync(join(dir, 'go.mod'))) {
    checks.push({ name: 'Анализ', command: 'go vet ./...' }, { name: 'Тесты', command: 'go test ./...' })
  }
  if (checks.length === 0 && /^test:/m.test(readText(join(dir, 'Makefile')))) {
    checks.push({ name: 'Тесты', command: 'make test' })
  }
  return checks
}

/** `signal` — отмена по «стоп»: процесс проверки убивается сразу, а не через 10 минут. */
export async function runCheck(dir: string, check: Check, signal?: AbortSignal): Promise<CheckResult> {
  const env = { ...(await getLoginShellEnv()), CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }
  const started = Date.now()
  try {
    // CI=1 — тест-раннеры (vitest, jest) запускаются один раз, а не в режиме наблюдения.
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', check.command], {
      cwd: dir,
      env,
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      ...(signal ? { signal } : {})
    })
    return { ...check, ok: true, skipped: false, code: 0, output: tail(stdout + stderr), ms: Date.now() - started }
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean }
    const code = typeof e.code === 'number' ? e.code : null
    const output = e.killed
      ? `Проверка не уложилась в ${CHECK_TIMEOUT_MS / 60_000} минут и была остановлена.`
      : tail(`${e.stdout ?? ''}${e.stderr ?? ''}`)
    return { ...check, ok: false, skipped: code === 127, code, output, ms: Date.now() - started }
  }
}

function tail(text: string): string {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim()
  return clean.length > OUTPUT_TAIL ? `…${clean.slice(-OUTPUT_TAIL)}` : clean
}

// ─────────────────────────── Git ───────────────────────────

async function git(dir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: dir,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env
    })
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * Дерево git со ВСЕМ рабочим состоянием, включая новые неотслеживаемые файлы
 * (кроме игнорируемых). Строится во временном индексе — ваш индекс и файлы не
 * меняются. null — не git.
 *
 * Временный индекс начинается с копии настоящего: в нём stat-кэш, и `add -A`
 * перехеширует только изменённые файлы, а не весь проект. Индекса нет (новый
 * репозиторий) — с HEAD, если он есть.
 */
/**
 * Копия настоящего индекса — только ускорение: git не перечитывает неизменённые файлы.
 * Git сверяет время файла с временем индекса: что изменено не раньше индекса,
 * перечитывается («racy git»). У свежей копии время — «сейчас», и правка той же
 * секунды без смены размера сошла бы за неизменённую, поэтому время переносим
 * (округление вниз до мс безопасно). Не вышло — false, и копии нет.
 */
function copyIndex(realIndex: string, copy: string): boolean {
  try {
    if (!existsSync(realIndex)) return false
    copyFileSync(realIndex, copy)
    const { atime, mtime } = statSync(realIndex)
    utimesSync(copy, atime, mtime)
    return true
  } catch (err) {
    console.error('[quality] копия индекса:', err instanceof Error ? err.message : err)
    rmSync(copy, { force: true })
    return false
  }
}

export async function snapshotTree(dir: string): Promise<string | null> {
  if ((await git(dir, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return null
  const index = join(tmpdir(), `cvd-index-${randomUUID()}`)
  const env = { GIT_INDEX_FILE: index }
  try {
    const realIndex = await git(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    if (!(realIndex && copyIndex(realIndex, index)) && (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']))) {
      await git(dir, ['read-tree', 'HEAD'], env)
    }
    if ((await git(dir, ['add', '-A'], env)) === null) return null
    return await git(dir, ['write-tree'], env)
  } finally {
    rmSync(index, { force: true })
  }
}

/**
 * Точка отката перед правками: коммит со всем рабочим состоянием, включая новые
 * неотслеживаемые файлы (иначе файл, созданный в прошлой задаче, считался бы
 * «новым» в каждой следующей). Рабочую копию, индекс и ветку не трогаем; ссылка
 * refs/cvd/… не даёт сборщику мусора удалить коммит.
 */
export async function createCheckpoint(dir: string): Promise<string | null> {
  const tree = await snapshotTree(dir)
  if (!tree) return null
  const head = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])
  const sha = await git(
    dir,
    ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'Claude Voice Desk: точка отката'],
    { GIT_AUTHOR_NAME: 'Claude Voice Desk', GIT_AUTHOR_EMAIL: 'voice-desk@localhost', GIT_COMMITTER_NAME: 'Claude Voice Desk', GIT_COMMITTER_EMAIL: 'voice-desk@localhost' }
  )
  if (!sha) return null
  await git(dir, ['update-ref', `refs/cvd/checkpoint-${Date.now()}`, sha])
  await pruneCheckpoints(dir)
  return sha
}

/** Сколько последних точек отката держим в refs/cvd — остальные отдаём сборщику мусора. */
const KEEP_CHECKPOINTS = 20

/** Ссылки точек отката, которые пора удалить: все, кроме `keep` самых свежих. */
export function staleCheckpoints(refs: string[], keep: number): string[] {
  const stamp = (ref: string): number => Number(/checkpoint-(\d+)$/.exec(ref)?.[1] ?? NaN)
  return refs
    .filter((ref) => !Number.isNaN(stamp(ref)))
    .sort((a, b) => stamp(b) - stamp(a))
    .slice(keep)
}

async function pruneCheckpoints(dir: string): Promise<void> {
  const list = await git(dir, ['for-each-ref', '--format=%(refname)', 'refs/cvd/'])
  if (!list) return
  for (const ref of staleCheckpoints(list.split('\n'), KEEP_CHECKPOINTS)) {
    await git(dir, ['update-ref', '-d', ref])
  }
}

/**
 * Отпечаток рабочего дерева git: меняется, если изменился любой файл (в том числе
 * новый неотслеживаемый). null — не git. Так «были ли правки» определяется по факту,
 * а не по догадке о том, что делала команда Bash.
 */
export async function worktreeFingerprint(dir: string): Promise<string | null> {
  // Хеш дерева со всем рабочим состоянием — меняется при любой правке файла.
  return snapshotTree(dir)
}

/** Есть ли в проекте CLAUDE.md — постоянная память проекта для Claude. */
export function hasClaudeMd(dir: string): boolean {
  return existsSync(join(dir, 'CLAUDE.md')) || existsSync(join(dir, '.claude', 'CLAUDE.md'))
}

/** Пустая папка — изучать нечего, /init не предлагаем. */
export function isEmptyProject(dir: string): boolean {
  return safeList(dir).filter((f) => !f.startsWith('.')).length === 0
}

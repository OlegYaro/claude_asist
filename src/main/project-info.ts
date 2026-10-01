import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { snapshotTree } from './quality'
import type { ChangedFile, ProjectChanges, ProjectOverview } from '../shared/types'

const execFileAsync = promisify(execFile)

async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: dir,
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024
    })
    return stdout
  } catch {
    return null
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Узнаваемые зависимости → человеческое название. Остальное не показываем: шум. */
const KNOWN_DEPS: Record<string, string> = {
  react: 'React',
  'react-dom': 'React',
  next: 'Next.js',
  vue: 'Vue',
  nuxt: 'Nuxt',
  svelte: 'Svelte',
  '@angular/core': 'Angular',
  electron: 'Electron',
  express: 'Express',
  fastify: 'Fastify',
  '@nestjs/core': 'NestJS',
  typescript: 'TypeScript',
  vite: 'Vite',
  'electron-vite': 'electron-vite',
  webpack: 'webpack',
  tailwindcss: 'Tailwind CSS',
  prisma: 'Prisma',
  '@prisma/client': 'Prisma',
  'drizzle-orm': 'Drizzle',
  mongoose: 'MongoDB (Mongoose)',
  pg: 'PostgreSQL',
  jest: 'Jest',
  vitest: 'Vitest',
  mocha: 'Mocha',
  playwright: 'Playwright',
  '@playwright/test': 'Playwright',
  eslint: 'ESLint',
  prettier: 'Prettier',
  zod: 'Zod',
  '@anthropic-ai/sdk': 'Anthropic SDK'
}

const KNOWN_PY: Record<string, string> = {
  django: 'Django',
  flask: 'Flask',
  fastapi: 'FastAPI',
  sqlalchemy: 'SQLAlchemy',
  pandas: 'pandas',
  numpy: 'NumPy',
  pytest: 'pytest',
  'apache-airflow': 'Airflow',
  airflow: 'Airflow',
  pydantic: 'Pydantic',
  ruff: 'Ruff',
  mypy: 'mypy',
  anthropic: 'Anthropic SDK'
}

/**
 * Обзор проекта для панели «Проект»: то, что видно по файлам без участия Claude.
 * Описание и архитектура — из CLAUDE.md (его пишет Claude по «изучи проект»).
 */
export async function projectOverview(dir: string): Promise<ProjectOverview> {
  const stack = new Set<string>()
  const commands: { name: string; command: string }[] = []

  const pkgText = readText(join(dir, 'package.json'))
  if (pkgText) {
    stack.add('Node.js')
    try {
      const pkg = JSON.parse(pkgText) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        scripts?: Record<string, string>
      }
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        const name = KNOWN_DEPS[dep]
        if (name) stack.add(name)
      }
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        commands.push({ name: `npm run ${name}`, command })
      }
    } catch {
      // битый package.json — просто без деталей
    }
  }

  const py = [
    readText(join(dir, 'pyproject.toml')),
    readText(join(dir, 'requirements.txt')),
    readText(join(dir, 'setup.py'))
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  if (py) {
    stack.add('Python')
    for (const [dep, name] of Object.entries(KNOWN_PY)) {
      if (new RegExp(`(^|[^a-z0-9_-])${dep}([^a-z0-9_-]|$)`, 'm').test(py)) stack.add(name)
    }
  }
  if (existsSync(join(dir, 'Cargo.toml'))) stack.add('Rust')
  if (existsSync(join(dir, 'go.mod'))) stack.add('Go')
  if (existsSync(join(dir, 'Dockerfile')) || existsSync(join(dir, 'docker-compose.yml'))) stack.add('Docker')

  const makefile = readText(join(dir, 'Makefile'))
  if (makefile) {
    for (const m of makefile.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)) {
      commands.push({ name: `make ${m[1]}`, command: `make ${m[1]}` })
    }
  }

  const claudeMd = readText(join(dir, 'CLAUDE.md')) ?? readText(join(dir, '.claude', 'CLAUDE.md'))

  let gitInfo: ProjectOverview['git'] = null
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  if (branch) {
    const last = (await git(dir, ['log', '-1', '--format=%h %s (%cr)']))?.trim() ?? ''
    gitInfo = { branch, lastCommit: last }
  }

  return { dir, claudeMd, stack: [...stack], commands: commands.slice(0, 30), git: gitInfo }
}

/**
 * Что изменилось в последней задаче: с точки отката (она сделана ДО задачи) до
 * текущего состояния, включая новые неотслеживаемые файлы. Без git — список
 * файлов, которые правил Claude, без счётчиков строк.
 */
export async function projectChanges(
  dir: string,
  baseSha: string | null,
  editedFiles: string[]
): Promise<ProjectChanges> {
  if (!baseSha) {
    return {
      base: null,
      files: editedFiles.map((p) => ({ path: rel(dir, p), added: 0, removed: 0, status: 'modified' }))
    }
  }

  // Сравниваем снимки целиком: точку отката и текущее дерево со всеми новыми
  // файлами — так видно ровно то, что изменилось в задаче.
  const current = await snapshotTree(dir)
  if (!current) return { base: baseSha.slice(0, 8), files: [] }
  const files: ChangedFile[] = []
  const numstat = (await git(dir, ['diff', '--numstat', baseSha, current])) ?? ''
  const nameStatus = (await git(dir, ['diff', '--name-status', baseSha, current])) ?? ''
  const statusOf = new Map<string, string>()
  for (const line of nameStatus.split('\n')) {
    const [code, path] = line.split('\t')
    if (code && path) statusOf.set(path, code)
  }
  for (const line of numstat.split('\n')) {
    const [added, removed, path] = line.split('\t')
    if (!path) continue
    const code = statusOf.get(path)
    files.push({
      path,
      added: Number(added) || 0,
      removed: Number(removed) || 0,
      status: code === 'A' ? 'new' : code === 'D' ? 'deleted' : 'modified'
    })
  }
  return { base: baseSha.slice(0, 8), files }
}

/** Дифф одного файла относительно точки отката — для разворота в панели. */
export async function fileDiff(dir: string, baseSha: string | null, path: string): Promise<string> {
  if (!baseSha) return ''
  const current = await snapshotTree(dir)
  if (!current) return ''
  return (await git(dir, ['diff', baseSha, current, '--', path])) ?? ''
}


function rel(dir: string, path: string): string {
  if (!isAbsolute(path)) return path
  const r = relative(dir, path)
  return r && !r.startsWith('..') ? r : path
}


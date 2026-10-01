import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { claudeProjectsDir } from './paths'
import { TranscriptSummarizer } from './history-logic'
import type { HistorySession } from '../shared/types'

/** Сколько последних транскриптов разбирать: старше — уже не «история», а архив. */
const MAX_SESSIONS = 30

/**
 * Claude Code называет папку проекта путём, где всё, кроме латиницы и цифр,
 * заменено на `-`; длинные пути обрезает и дописывает хеш. Поэтому имя — только
 * подсказка, где искать, а принадлежность проверяется по `cwd` в самих записях.
 */
const SLUG_PREFIX_CHARS = 200

interface CacheEntry {
  mtimeMs: number
  size: number
  cwd: string | null
  summary: HistorySession | null
}

/** Разбор файла в 8 МБ занимает заметное время — повторно читаем только изменённые. */
const cache = new Map<string, CacheEntry>()

async function summarizeFile(path: string, id: string): Promise<Omit<CacheEntry, 'mtimeMs' | 'size'>> {
  const summarizer = new TranscriptSummarizer()
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      summarizer.add(JSON.parse(trimmed))
    } catch {
      // битая или недописанная строка — остальные разбираем
    }
  }
  return { cwd: summarizer.cwd, summary: summarizer.result(id) }
}

async function projectFolders(projectDir: string): Promise<string[]> {
  const root = claudeProjectsDir()
  const slug = projectDir.replace(/[^a-zA-Z0-9]/g, '-')
  let entries: string[]
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
  return entries
    .filter((name) =>
      slug.length > SLUG_PREFIX_CHARS ? name.startsWith(slug.slice(0, SLUG_PREFIX_CHARS)) : name === slug
    )
    .map((name) => join(root, name))
}

/** Сессии Claude Code в папке проекта, свежие первыми; без запросов — не показываем. */
export async function listSessions(projectDir: string): Promise<HistorySession[]> {
  const files: { path: string; id: string; mtimeMs: number; size: number }[] = []
  for (const folder of await projectFolders(projectDir)) {
    let names: string[]
    try {
      names = await readdir(folder)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(folder, name)
      try {
        const s = await stat(path)
        if (s.isFile()) files.push({ path, id: name.slice(0, -'.jsonl'.length), mtimeMs: s.mtimeMs, size: s.size })
      } catch {
        // файл удалили между readdir и stat
      }
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const sessions: HistorySession[] = []
  for (const file of files.slice(0, MAX_SESSIONS)) {
    let entry = cache.get(file.path)
    if (!entry || entry.mtimeMs !== file.mtimeMs || entry.size !== file.size) {
      try {
        entry = { mtimeMs: file.mtimeMs, size: file.size, ...(await summarizeFile(file.path, file.id)) }
      } catch {
        continue
      }
      cache.set(file.path, entry)
    }
    if (entry.summary && entry.cwd === projectDir) sessions.push(entry.summary)
  }
  return sessions
}

/** Путь к транскрипту сессии этого проекта или null, если такой нет. */
export async function sessionTranscript(projectDir: string, id: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  for (const folder of await projectFolders(projectDir)) {
    const path = join(folder, `${id}.jsonl`)
    try {
      if ((await stat(path)).isFile()) return path
    } catch {
      // в этой папке нет
    }
  }
  return null
}

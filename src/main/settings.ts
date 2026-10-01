import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

/**
 * Свой мини-стор вместо electron-store: тот ESM-only, что конфликтует со сборкой
 * main-процесса, а нам нужен всего один JSON-файл. Секреты сюда не пишем —
 * для них secrets.ts с safeStorage.
 */

const MAX_RECENTS = 10

let cache: Settings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): Settings {
  if (cache) return cache
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<Settings>
    // Мержим с дефолтами: файл мог быть записан более старой версией без новых полей.
    cache = { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch }
  cache = next
  const target = settingsPath()
  mkdirSync(dirname(target), { recursive: true })
  // Пишем через временный файл, чтобы не оставить обрезанный JSON при падении.
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, target)
  return next
}

/** Поднимает папку в начало списка недавних, схлопывая дубли. */
export function rememberProject(dir: string): Settings {
  const current = loadSettings()
  const recentProjects = [dir, ...current.recentProjects.filter((p) => p !== dir)].slice(
    0,
    MAX_RECENTS
  )
  return saveSettings({ recentProjects })
}

export function forgetProject(dir: string): Settings {
  const current = loadSettings()
  return saveSettings({ recentProjects: current.recentProjects.filter((p) => p !== dir) })
}

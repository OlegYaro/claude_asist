import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Хранение секретов: API-ключа Claude и токена Telegram-бота.
 *
 * Секрет шифруется через `safeStorage` (на macOS — Keychain) и лежит отдельным
 * файлом, а не в settings.json: настройки читаются свободно и могут попасть
 * в бэкап или скриншот, секрет — не должен. В renderer секреты не передаются
 * никогда; наружу отдаётся только признак «настроен».
 */

const FILE = 'anthropic-key.bin'
const TELEGRAM_FILE = 'telegram-token.bin'

function secretPath(file: string): string {
  return join(app.getPath('userData'), file)
}

/**
 * Расшифрованные секреты в памяти: каждое расшифрование — обращение к Keychain,
 * а ключ проверяется на каждой задаче. Меняются секреты только через этот модуль.
 */
const cache = new Map<string, string | null>()

function readSecret(file: string): string | null {
  const cached = cache.get(file)
  if (cached !== undefined) return cached
  try {
    const value = safeStorage.decryptString(readFileSync(secretPath(file))).trim() || null
    cache.set(file, value)
    return value
  } catch {
    // Файла нет или Keychain не расшифровал — не кэшируем: в следующий раз может получиться.
    return null
  }
}

function writeSecret(file: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    // Лучше отказать, чем молча записать секрет открытым текстом.
    throw new Error('Системное хранилище секретов недоступно — секрет не сохранён')
  }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(secretPath(file), safeStorage.encryptString(value), { mode: 0o600 })
  cache.set(file, value || null)
}

function removeSecret(file: string): void {
  cache.set(file, null)
  try {
    rmSync(secretPath(file), { force: true })
  } catch {
    // нечего удалять
  }
}

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * Возвращает ключ: сначала из хранилища, затем из окружения. Переменная
 * окружения — осознанный запасной путь для тех, кто уже держит ключ там
 * и не хочет дублировать его в приложении.
 */
export function getApiKey(): string | null {
  const stored = readSecret(FILE)
  if (stored) return stored
  const fromEnv = process.env['ANTHROPIC_API_KEY']?.trim()
  return fromEnv ? fromEnv : null
}

export function hasApiKey(): boolean {
  return getApiKey() !== null
}

/** Пустая строка стирает ключ. */
export function setApiKey(value: string): void {
  const trimmed = value.trim()
  if (!trimmed) {
    clearApiKey()
    return
  }
  writeSecret(FILE, trimmed)
}

export function clearApiKey(): void {
  removeSecret(FILE)
}

/** Источник ключа — нужен UI, чтобы объяснить, почему ключ «уже есть». */
export function keySource(): 'stored' | 'env' | 'none' {
  if (readSecret(FILE)) return 'stored'
  return process.env['ANTHROPIC_API_KEY']?.trim() ? 'env' : 'none'
}

export function getTelegramToken(): string | null {
  return readSecret(TELEGRAM_FILE)
}

export function setTelegramToken(value: string): void {
  writeSecret(TELEGRAM_FILE, value.trim())
}

export function clearTelegramToken(): void {
  removeSecret(TELEGRAM_FILE)
}

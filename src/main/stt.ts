import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { AppError, SttProviderId } from '../shared/types'

const execFileAsync = promisify(execFile)

/**
 * Распознавание речи. Провайдер за интерфейсом, чтобы движок можно было заменить
 * без переделки остального кода.
 *
 * По умолчанию — нативный macOS (`apple-speech`): офлайн, бесплатно, без ключей и
 * без загрузки многогигабайтных моделей. Русский там обслуживается моделью системной
 * диктовки, которая на этой машине уже установлена.
 */

export interface SttResult {
  text: string
  locale: string
  engine: string
}

export class SttError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'SttError'
  }
}

/** Хелпер лежит в Resources собранного приложения, а в dev — в repo/resources. */
function helperPath(): string | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'stt-helper'),
    join(app.getAppPath(), 'resources', 'stt-helper'),
    join(process.cwd(), 'resources', 'stt-helper')
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

async function runHelper(args: string[]): Promise<Record<string, unknown>> {
  const bin = helperPath()
  if (!bin) {
    throw new SttError({
      code: 'stt-unavailable',
      message: 'Не найден модуль распознавания речи',
      hint: 'Соберите его командой npm run build:stt.'
    })
  }

  try {
    // Первый запуск для нового языка догружает модель — отсюда щедрый таймаут.
    const { stdout } = await execFileAsync(bin, args, { timeout: 180_000 })
    return JSON.parse(stdout.trim()) as Record<string, unknown>
  } catch (err) {
    // Хелпер при ошибке печатает JSON в stdout и выходит с кодом 1 — разберём его.
    const stdout = (err as { stdout?: string }).stdout
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout.trim()) as { error?: string; code?: string }
        if (parsed.error) {
          throw new SttError({
            code: parsed.code === 'stt-unavailable' ? 'stt-unavailable' : 'stt-failed',
            message: parsed.error
          })
        }
      } catch (parseErr) {
        if (parseErr instanceof SttError) throw parseErr
      }
    }
    if (err instanceof SttError) throw err
    throw new SttError({
      code: 'stt-failed',
      message: err instanceof Error ? err.message : 'Не удалось распознать речь'
    })
  }
}

export interface SttProvider {
  readonly id: SttProviderId
  /** Готовность движка и языковой модели — для подсказок в интерфейсе. */
  probe(locale: string): Promise<{ available: boolean; installed: boolean; detail: string }>
  transcribeWav(wav: Buffer, locale: string): Promise<SttResult>
}

/** Нативный Speech framework macOS 26 через Swift-хелпер. */
const appleSpeech: SttProvider = {
  id: 'apple-speech',

  async probe(locale) {
    const out = await runHelper(['probe', locale])
    return {
      available: out['available'] === true,
      installed: out['installed'] === true,
      detail:
        typeof out['engine'] === 'string'
          ? `${out['engine']} · ${String(out['locale'] ?? locale)}`
          : String(out['reason'] ?? '')
    }
  },

  async transcribeWav(wav, locale) {
    // Хелпер читает файл: передавать сырое аудио через argv нельзя, а возиться
    // со stdin ради одного короткого фрагмента не стоит.
    const file = join(tmpdir(), `cvd-${randomUUID()}.wav`)
    try {
      await writeFile(file, wav)
      const out = await runHelper(['transcribe', file, locale])
      return {
        text: String(out['text'] ?? ''),
        locale: String(out['locale'] ?? locale),
        engine: String(out['engine'] ?? 'apple-speech')
      }
    } finally {
      await unlink(file).catch(() => {
        // временный файл мог не создаться — не важно
      })
    }
  }
}

/**
 * Перекодирует сжатое аудио (например, Ogg/Opus голосовых Telegram) в WAV 16 кГц моно,
 * который понимают провайдеры. Системный `afconvert` читает Ogg/Opus — ffmpeg не нужен.
 */
export async function toWav16k(audio: Buffer, ext: string): Promise<Buffer> {
  const base = join(tmpdir(), `cvd-${randomUUID()}`)
  const input = `${base}.${ext}`
  const output = `${base}.wav`
  try {
    await writeFile(input, audio)
    await execFileAsync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', input, output], {
      timeout: 60_000
    })
    return await readFile(output)
  } catch (err) {
    throw new SttError({
      code: 'stt-failed',
      message: 'Не удалось прочитать аудио',
      hint: err instanceof Error ? err.message : undefined
    })
  } finally {
    await Promise.all([unlink(input).catch(() => undefined), unlink(output).catch(() => undefined)])
  }
}

/** Сейчас провайдер один; `id` из настроек — точка выбора, когда появятся другие. */
export function getProvider(_id: SttProviderId): SttProvider {
  return appleSpeech
}

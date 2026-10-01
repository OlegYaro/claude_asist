import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

/**
 * Озвучка коротких сообщений и ответов Claude голосом macOS (`say`).
 *
 * Главное здесь — признак `speaking`: пока приложение говорит, микрофон
 * слушает только с повышенным порогом (или вовсе глохнет), иначе фраза
 * «скажите „выполняй“» распознается как ваша команда и сама одобрит план.
 * Конец фразы — конец воспроизведения, а не оценка по длине текста.
 *
 * Звук обычно играет окно (`WindowVoice`): эхоподавление Chromium вычитает из
 * микрофона только то, что играет само приложение, — поэтому вас слышно
 * и во время речи. Без окна фраза звучит прямо через `say`.
 *
 * События: `speaking` (boolean).
 */

/** Хвост тишины после речи: эхо комнаты ещё долетает до микрофона. */
export const ECHO_TAIL_MS = 500
/** Предел на одну фразу: зависший `say` убиваем, иначе микрофон заглохнет навсегда. */
export const PHRASE_LIMIT_MS = 30_000

export interface SayProcess {
  /** Завершается всегда, в том числе при ошибке или убийстве процесса. */
  done: Promise<void>
  kill(): void
}

export type SayRunner = (text: string) => SayProcess

/** Необязательные крючки раннера: заранее готовить следующую фразу и забыть заготовки. */
export interface SayHooks {
  prepare?(text: string): void
  reset?(): void
}

export class Speaker extends EventEmitter {
  private queue: string[] = []
  private current: SayProcess | null = null
  private speaking = false
  private tail: ReturnType<typeof setTimeout> | null = null
  private readonly run: SayRunner
  private readonly hooks: SayHooks

  constructor(run: SayRunner, hooks: SayHooks = {}) {
    super()
    this.run = run
    this.hooks = hooks
  }

  get isSpeaking(): boolean {
    return this.speaking
  }

  say(text: string): void {
    const phrase = text.trim()
    if (!phrase) return
    this.queue.push(phrase)
    if (this.tail) {
      clearTimeout(this.tail)
      this.tail = null
    }
    this.setSpeaking(true)
    if (!this.current) this.next()
    else if (this.queue.length === 1) this.hooks.prepare?.(phrase)
  }

  /** Обрывает текущую фразу и очередь; микрофон включится после хвоста на эхо. */
  stop(): void {
    this.queue = []
    this.hooks.reset?.()
    this.current?.kill()
  }

  private next(): void {
    const phrase = this.queue.shift()
    if (phrase === undefined) {
      this.release()
      return
    }
    const proc = this.run(phrase)
    this.current = proc
    // Пока звучит эта фраза, следующая синтезируется — без пауз между ними.
    const upcoming = this.queue[0]
    if (upcoming !== undefined) this.hooks.prepare?.(upcoming)
    const limit = setTimeout(() => proc.kill(), PHRASE_LIMIT_MS)
    // Отклонённый done (ошибка запуска say) не должен останавливать очередь.
    const finished = (): void => {
      clearTimeout(limit)
      this.current = null
      this.next()
    }
    void proc.done.then(finished, finished)
  }

  private release(): void {
    if (this.tail) clearTimeout(this.tail)
    this.tail = setTimeout(() => {
      this.tail = null
      this.setSpeaking(false)
    }, ECHO_TAIL_MS)
  }

  private setSpeaking(next: boolean): void {
    if (this.speaking === next) return
    this.speaking = next
    this.emit('speaking', next)
  }
}

// ─────────────────────────── Голоса ───────────────────────────

/** Голос и скорость (слов в минуту); null — системные по умолчанию. */
export interface SpeechConfig {
  voice: string | null
  rate: number | null
}

/** Скорость в разумных пределах `say`; иначе — системная. */
function validRate(rate: number | null): number | null {
  return rate !== null && Number.isFinite(rate) && rate >= 80 && rate <= 400 ? Math.round(rate) : null
}

/** Премиум звучит живее улучшенного, улучшенный — живее компактного. */
function voiceRank(name: string): number {
  if (/premium|премиум/i.test(name)) return 0
  if (/enhanced|улучш/i.test(name)) return 1
  return 2
}

/** Есть ли среди голосов улучшенный или премиум: без них речь звучит как у робота. */
export function hasLiveVoice(voices: string[]): boolean {
  return voices.some((name) => voiceRank(name) < 2)
}

/** Русские голоса из вывода `say -v ?`, лучшие первыми, без повторов. */
export function parseRussianVoices(list: string): string[] {
  const names: string[] = []
  for (const line of list.split('\n')) {
    const name = /^(.+?)\s+ru_RU\s+#/.exec(line)?.[1]?.trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
    .map((name, index) => ({ name, index }))
    .sort((a, b) => voiceRank(a.name) - voiceRank(b.name) || a.index - b.index)
    .map((v) => v.name)
}

async function readRussianVoices(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/say', ['-v', '?'], { timeout: 10_000 })
    return parseRussianVoices(stdout)
  } catch {
    // Без списка голосов говорим системным голосом по умолчанию.
    return []
  }
}

/**
 * Список русских голосов читается один раз и перечитывается по `refresh()` —
 * при открытии настроек: так скачанный улучшенный голос подхватится без перезапуска.
 */
export class VoiceCatalog {
  private list: Promise<string[]> | null = null
  private readonly read: () => Promise<string[]>

  constructor(read: () => Promise<string[]> = readRussianVoices) {
    this.read = read
  }

  voices(): Promise<string[]> {
    this.list ??= this.read()
    return this.list
  }

  refresh(): Promise<string[]> {
    this.list = this.read()
    return this.list
  }

  /** Выбранный голос, если он установлен, иначе лучший из установленных. */
  async resolve(preferred: string | null): Promise<string | null> {
    const voices = await this.voices()
    if (preferred && voices.includes(preferred)) return preferred
    return voices[0] ?? null
  }
}

// ─────────────────────────── Аргументы say ───────────────────────────

/**
 * Аргументы `say`. Текст — кусок ответа Claude и может начинаться с `-`
 * («--no-verify …»): без `--` say разобрал бы его как опцию (`-f путь` прочитал
 * бы файл, `-o путь` записал бы аудио).
 */
export function sayArgs(text: string, config: SpeechConfig): string[] {
  const rate = validRate(config.rate)
  return [
    ...(config.voice ? ['-v', config.voice] : []),
    ...(rate !== null ? ['-r', String(rate)] : []),
    '--',
    text
  ]
}

/** Аргументы синтеза в WAV-файл: окно проигрывает его само. */
export function synthArgs(out: string, text: string, config: SpeechConfig): string[] {
  return ['-o', out, '--file-format=WAVE', '--data-format=LEI16@22050', ...sayArgs(text, config)]
}

// ─────────────────────────── Раннеры ───────────────────────────

/** Запуск `say` прямо в динамик — когда окна нет. */
export function systemSay(config: () => Promise<SpeechConfig>): SayRunner {
  return (text) => {
    let child: ChildProcess | null = null
    let killed = false
    const done = config().then(
      (cfg) =>
        new Promise<void>((resolve) => {
          if (killed) return resolve()
          child = execFile('/usr/bin/say', sayArgs(text, cfg), (err) => {
            if (err && !killed) console.error('[speaker] say:', err.message)
            resolve()
          })
        })
    )
    return {
      done,
      kill: () => {
        killed = true
        child?.kill()
      }
    }
  }
}

/** Фраза → WAV; null — синтез не удался (ошибка уже в логе). */
export async function synthesizeWav(text: string, config: SpeechConfig): Promise<Buffer | null> {
  const out = join(tmpdir(), `cvd-speech-${randomUUID()}.wav`)
  try {
    await execFileAsync('/usr/bin/say', synthArgs(out, text, config), { timeout: PHRASE_LIMIT_MS })
    return await readFile(out)
  } catch (err) {
    console.error('[speaker] синтез:', err instanceof Error ? err.message : err)
    return null
  } finally {
    await unlink(out).catch(() => {})
  }
}

/** Куда отдавать звук: окно приложения. */
export interface SpeechOutput {
  /** Окно открыто и может играть. */
  ready(): boolean
  play(id: number, wav: Buffer, text: string): void
  cancel(id: number): void
}

/**
 * Раннер, который синтезирует фразу в WAV и отдаёт окну; фраза кончается, когда
 * окно сообщит `ended(id)`. Окна нет — говорит `fallback` прямо через `say`.
 */
export class WindowVoice {
  private seq = 0
  private readonly pending = new Map<number, () => void>()
  private prepared = new Map<string, Promise<Buffer | null>>()
  private readonly output: SpeechOutput
  private readonly config: () => Promise<SpeechConfig>
  private readonly fallback: SayRunner
  private readonly synth: (text: string, config: SpeechConfig) => Promise<Buffer | null>

  constructor(
    output: SpeechOutput,
    config: () => Promise<SpeechConfig>,
    fallback: SayRunner = systemSay(config),
    synth: (text: string, config: SpeechConfig) => Promise<Buffer | null> = synthesizeWav
  ) {
    this.output = output
    this.config = config
    this.fallback = fallback
    this.synth = synth
  }

  readonly run: SayRunner = (text) => {
    const id = ++this.seq
    let killed = false
    let stopCurrent = (): void => {}
    const wav = this.prepared.get(text) ?? this.synthesize(text)
    this.prepared.delete(text)
    const done = wav.then(async (buf) => {
      if (killed) return
      // Синтез в файл не удался или окна нет — фразу всё равно произносим, прямо через say.
      if (!buf || !this.output.ready()) {
        const proc = this.fallback(text)
        stopCurrent = proc.kill
        return proc.done
      }
      await new Promise<void>((resolve) => {
        this.pending.set(id, resolve)
        stopCurrent = () => {
          this.output.cancel(id)
          this.ended(id)
        }
        this.output.play(id, buf, text)
      })
    })
    return {
      done,
      kill: () => {
        killed = true
        stopCurrent()
      }
    }
  }

  readonly hooks: SayHooks = {
    prepare: (text) => {
      if (!this.prepared.has(text)) this.prepared.set(text, this.synthesize(text))
    },
    reset: () => {
      this.prepared = new Map()
    }
  }

  /** Окно доиграло фразу (или оборвало её). */
  ended(id: number): void {
    const resolve = this.pending.get(id)
    this.pending.delete(id)
    resolve?.()
  }

  /** Окно закрыли или перезагрузили — то, что оно играло, уже не доиграет. */
  endAll(): void {
    for (const id of [...this.pending.keys()]) this.ended(id)
  }

  private async synthesize(text: string): Promise<Buffer | null> {
    return this.synth(text, await this.config())
  }
}

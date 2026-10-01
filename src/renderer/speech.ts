/**
 * Озвучка в окне. Синтез и очередь фраз — в main (`src/main/speaker.ts`), сюда
 * приходят готовые WAV: окно их играет и сообщает, когда доиграло. Играть
 * именно здесь важно: эхоподавление Chromium вычитает из микрофона только звук
 * самого приложения, поэтому вас слышно и во время речи — можно перебить.
 *
 * Признак «приложение говорит» тоже приходит из main: пока он включён,
 * микрофон слушает с повышенным порогом (или глохнет, если перебивать голосом
 * выключено), иначе фраза «скажите „выполняй“» сама одобрила бы план.
 */

type Listener = (speaking: boolean) => void

let speaking = false
const listeners = new Set<Listener>()

window.desk.on.speaking((next) => {
  if (speaking === next) return
  speaking = next
  listeners.forEach((cb) => cb(next))
})

export function onSpeaking(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function isSpeaking(): boolean {
  return speaking
}

/** Замолчать сейчас — кнопкой, Esc или когда вы заговорили. */
export function stopSpeaking(): void {
  void window.desk.speech.stop()
}

// ─────────────────────── Воспроизведение ───────────────────────

/** Эхо комнаты и задержка микрофона: фраза «звучит» ещё столько после конца воспроизведения. */
const ECHO_LAG_MS = 1500
/** Сколько фраз помнить: дольше одной фразы сегмент речи почти не тянется. */
const SPOKEN_MEMORY = 8

let context: AudioContext | null = null
let current: { id: number; source: AudioBufferSourceNode } | null = null
const cancelled = new Set<number>()
/** Сказанные фразы с началом и концом воспроизведения (`end` null — ещё звучит). */
const spoken: { id: number; text: string; start: number; end: number | null }[] = []

/**
 * Фразы, звучавшие, пока шла ваша речь (`from`…`to`, мс эпохи), — только с ними
 * сверяется услышанное: весь прочитанный ответ дал бы ложные совпадения.
 */
export function speechBetween(from: number, to: number): string[] {
  return spoken
    .filter((s) => s.start <= to && (s.end ?? Date.now()) + ECHO_LAG_MS >= from)
    .map((s) => s.text)
}

function finish(id: number): void {
  cancelled.delete(id)
  if (current?.id === id) current = null
  const phrase = spoken.find((s) => s.id === id)
  if (phrase && phrase.end === null) phrase.end = Date.now()
  void window.desk.speech.ended(id)
}

async function play(id: number, wav: Uint8Array, text: string): Promise<void> {
  spoken.push({ id, text, start: Date.now(), end: null })
  if (spoken.length > SPOKEN_MEMORY) spoken.shift()
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') await context.resume()
    // decodeAudioData забирает буфер себе — отдаём копию ровно этого куска.
    const data = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer
    const buffer = await context.decodeAudioData(data)
    if (cancelled.has(id)) return finish(id)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => finish(id)
    current = { id, source }
    source.start()
  } catch (err) {
    console.error('[speech] воспроизведение:', err)
    finish(id)
  }
}

window.desk.on.speechPlay(({ id, wav, text }) => void play(id, wav, text))

window.desk.on.speechCancel((id) => {
  // stop() вызовет onended — оттуда и уйдёт `ended`.
  if (current?.id === id) current.source.stop()
  else cancelled.add(id)
})

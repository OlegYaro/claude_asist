/**
 * Запись голоса в WAV 16 кГц моно.
 *
 * Сознательно не используем MediaRecorder: он отдаёт webm/opus, который пришлось бы
 * перекодировать через ffmpeg (его в системе нет). Speech framework хочет линейный
 * PCM, поэтому пишем его напрямую: AudioContext с частотой 16 кГц сам делает
 * ресемплинг, а WAV-контейнер собирается тут же, в двадцать строк.
 */

const SAMPLE_RATE = 16_000

/** AudioWorklet как строка: отдельный файл пришлось бы отдавать по URL. */
const WORKLET_SOURCE = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    // Копия обязательна: движок переиспользует буфер между вызовами.
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel))
    return true
  }
}
registerProcessor('capture', Capture)
`

function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const buffer = new ArrayBuffer(44 + total * 2)
  const view = new DataView(buffer)

  const writeText = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeText(0, 'RIFF')
  view.setUint32(4, 36 + total * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true) // размер fmt-блока
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // моно
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // байт в секунду
  view.setUint16(32, 2, true) // выравнивание блока
  view.setUint16(34, 16, true) // бит на отсчёт
  writeText(36, 'data')
  view.setUint32(40, total * 2, true)

  let offset = 44
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      // Клиппинг перед переводом в int16, иначе громкие пики завернутся в шум.
      const sample = Math.max(-1, Math.min(1, chunk[i] ?? 0))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

export class MicPermissionError extends Error {
  constructor() {
    super('Нет доступа к микрофону')
    this.name = 'MicPermissionError'
  }
}

export class Recorder {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private chunks: Float32Array[] = []

  get isRecording(): boolean {
    return this.context !== null
  }

  async start(): Promise<void> {
    if (this.context) return
    this.chunks = []

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
    } catch {
      throw new MicPermissionError()
    }

    // Просим сразу 16 кГц — ресемплинг делает сам движок, качественнее наивного.
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(blobUrl)
    } finally {
      URL.revokeObjectURL(blobUrl)
    }

    const source = context.createMediaStreamSource(this.stream)
    const node = new AudioWorkletNode(context, 'capture')
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.chunks.push(e.data)
    source.connect(node)
    // К destination не подключаем: иначе пользователь услышит сам себя.

    this.context = context
    this.node = node
  }

  /** Останавливает запись и возвращает WAV. null — если ничего не записалось. */
  async stop(): Promise<Blob | null> {
    const context = this.context
    if (!context) return null

    this.node?.port.close()
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    await context.close()

    const chunks = this.chunks
    this.context = null
    this.node = null
    this.stream = null
    this.chunks = []

    const samples = chunks.reduce((sum, c) => sum + c.length, 0)
    // Меньше четверти секунды — это случайный клик, а не реплика.
    if (samples < SAMPLE_RATE / 4) return null

    return encodeWav(chunks, context.sampleRate)
  }

  /** Прерывание без результата — например, если пользователь передумал. */
  async cancel(): Promise<void> {
    this.chunks = []
    await this.stop()
  }
}

// ─────────────────────── Постоянное прослушивание ───────────────────────

/** Сколько звука до срабатывания детектора сохраняем, чтобы не съесть начало слова. */
const PREROLL_MS = 350
/** Столько громкого звука подряд нужно, чтобы считать это речью, а не щелчком. */
const SPEECH_START_MS = 90
/** Пауза, после которой фраза считается законченной. */
const SPEECH_END_MS = 900
/** Короче этого — не фраза, а шум. */
const MIN_SPEECH_MS = 350
/** Защита от бесконечной фразы (телевизор, музыка). */
const MAX_SEGMENT_MS = 30_000
/**
 * Пока приложение говорит, порог выше: остаток собственной речи после
 * эхоподавления тише вашего голоса у микрофона.
 */
const BARGE_IN_FACTOR = 2.5
const BARGE_IN_MIN_LEVEL = 0.03
/** И речь должна длиться дольше: короткий всплеск эха не обрывает фразу. */
const BARGE_IN_START_MS = 250

export interface ListenerHandlers {
  /**
   * Готовая фраза в WAV — её остаётся распознать. `overlapped` — фраза звучала,
   * пока говорило приложение: в ней может быть его эхо.
   */
  onSegment: (wav: Blob, overlapped: boolean) => void
  /** Детектор услышал речь (true) или она закончилась (false) — для индикатора. */
  onSpeech: (active: boolean) => void
}

/**
 * Микрофон, который слушает постоянно и сам нарезает речь на фразы.
 *
 * Детектор голоса — энергетический: громкость кадра сравнивается с уровнем
 * фонового шума, который постоянно подстраивается. Этого хватает для
 * комнаты с ноутбуком и не требует ни моделей, ни сети. Распознавание при
 * этом тратится только на фразы, а не на тишину.
 */
export class ContinuousListener {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null

  private preroll: Float32Array[] = []
  private prerollMs = 0
  private segment: Float32Array[] | null = null
  private segmentMs = 0
  private loudMs = 0
  private silenceMs = 0
  private noiseFloor = 0.004
  private muted = false
  private bargeIn = false
  private overlapped = false

  constructor(private readonly handlers: ListenerHandlers) {}

  /** Временно не слышать — например, пока приложение само что-то говорит. */
  setMuted(muted: boolean): void {
    this.muted = muted
    if (muted && this.segment) {
      this.resetSegment()
      this.handlers.onSpeech(false)
    }
    this.preroll = []
    this.prerollMs = 0
  }

  /**
   * Приложение говорит, но вас всё равно слушаем — с повышенным порогом,
   * чтобы можно было перебить. Начало фразы в этом режиме сообщает `onSpeech(true)`.
   */
  setBargeIn(on: boolean): void {
    this.bargeIn = on
    this.loudMs = 0
    if (on && this.segment) this.overlapped = true
  }

  get isListening(): boolean {
    return this.context !== null
  }

  async start(): Promise<void> {
    if (this.context) return
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Эхоподавление важно: иначе детектор срабатывает на собственный звук системы.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
    } catch {
      throw new MicPermissionError()
    }

    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(blobUrl)
    } finally {
      URL.revokeObjectURL(blobUrl)
    }

    const source = context.createMediaStreamSource(this.stream)
    const node = new AudioWorkletNode(context, 'capture')
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onChunk(e.data, context.sampleRate)
    source.connect(node)

    this.context = context
    this.node = node
  }

  /** Полностью отпускает микрофон — индикатор записи в строке меню гаснет. */
  async stop(): Promise<void> {
    const context = this.context
    if (!context) return
    this.node?.port.close()
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.context = null
    this.node = null
    this.stream = null
    if (this.segment) this.handlers.onSpeech(false)
    this.resetSegment()
    this.preroll = []
    this.prerollMs = 0
    await context.close()
  }

  private onChunk(chunk: Float32Array, sampleRate: number): void {
    if (this.muted) return
    const ms = (chunk.length / sampleRate) * 1000
    let sum = 0
    for (let i = 0; i < chunk.length; i++) sum += (chunk[i] ?? 0) ** 2
    const rms = Math.sqrt(sum / (chunk.length || 1))

    // Порог — кратный фону, но не ниже абсолютного минимума, чтобы в тихой
    // комнате не реагировать на дыхание.
    const base = Math.max(this.noiseFloor * 3.5, 0.012)
    const threshold = this.bargeIn ? Math.max(base * BARGE_IN_FACTOR, BARGE_IN_MIN_LEVEL) : base

    if (!this.segment) {
      // Фон подстраиваем только вне речи — и не под собственную речь приложения,
      // иначе голос сам поднимет себе порог.
      if (!this.bargeIn) this.noiseFloor = Math.max(0.002, this.noiseFloor * 0.995 + rms * 0.005)

      this.preroll.push(chunk)
      this.prerollMs += ms
      while (this.prerollMs > PREROLL_MS && this.preroll.length > 1) {
        const dropped = this.preroll.shift()
        this.prerollMs -= dropped ? (dropped.length / sampleRate) * 1000 : 0
      }

      this.loudMs = rms > threshold ? this.loudMs + ms : 0
      if (this.loudMs >= (this.bargeIn ? BARGE_IN_START_MS : SPEECH_START_MS)) {
        this.overlapped = this.bargeIn
        this.segment = [...this.preroll]
        this.segmentMs = this.prerollMs
        this.silenceMs = 0
        this.preroll = []
        this.prerollMs = 0
        this.handlers.onSpeech(true)
      }
      return
    }

    this.segment.push(chunk)
    this.segmentMs += ms
    // Гистерезис: на спаде голоса порог ниже, чтобы не рвать фразу на тихих слогах.
    this.silenceMs = rms > threshold * 0.7 ? 0 : this.silenceMs + ms

    if (this.silenceMs >= SPEECH_END_MS || this.segmentMs >= MAX_SEGMENT_MS) {
      const chunks = this.segment
      const voicedMs = this.segmentMs - this.silenceMs
      const overlapped = this.overlapped
      this.resetSegment()
      this.handlers.onSpeech(false)
      if (voicedMs >= MIN_SPEECH_MS) this.handlers.onSegment(encodeWav(chunks, sampleRate), overlapped)
    }
  }

  private resetSegment(): void {
    this.segment = null
    this.segmentMs = 0
    this.silenceMs = 0
    this.loudMs = 0
    this.overlapped = false
  }
}

import { EventEmitter } from 'node:events'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { app } from 'electron'
import type { ClaudeSession } from './claude-runtime'
import { DEFAULT_COLS, DEFAULT_ROWS } from './claude-runtime'
import { resolveNodeBin } from './paths'

const execFileAsync = promisify(execFile)

const TAG_DATA = 0x00
const TAG_CONTROL = 0x01
const HEADER = 5

export class TerminalAutomationDeniedError extends Error {
  constructor() {
    super('macOS не разрешил приложению управлять Terminal.app')
    this.name = 'TerminalAutomationDeniedError'
  }
}

/** Короткий приватный каталог для сокетов: /tmp/cvd-<uid>. */
export function socketDir(): string {
  const dir = join('/tmp', `cvd-${userInfo().uid}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  return dir
}

function frame(tag: number, payload: Buffer | string): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const head = Buffer.alloc(HEADER)
  head[0] = tag
  head.writeUInt32BE(body.length, 1)
  return Buffer.concat([head, body])
}

/** Экранирование для вставки внутрь строки в двойных кавычках в AppleScript. */
function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Экранирование для одинарных кавычек в POSIX-шелле: 'a'\''b'. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Слушает два Unix-сокета и раздаёт им поток PTY:
 *
 *  - `<id>.sock`     — кадрированный протокол для resources/bridge.js (умеет ресайз)
 *  - `<id>.raw.sock` — сырой поток для фолбэка `nc -U` (без ресайза)
 *
 * Два сокета вместо эвристики «кадры или не кадры» на одном: raw-клиент ничего не
 * присылает до первого нажатия клавиши, поэтому определить его протокол по первым
 * байтам невозможно — сервер должен отдавать вывод сразу после подключения.
 *
 * События: `attach`, `detach` (аргумент — количество активных клиентов).
 */
export class TerminalBridge extends EventEmitter {
  private framedServer: net.Server | null = null
  private rawServer: net.Server | null = null
  private clients = new Set<net.Socket>()
  private rawClients = new Set<net.Socket>()
  private readonly dir: string
  readonly framedSocketPath: string
  readonly rawSocketPath: string

  constructor(private readonly session: ClaudeSession) {
    super()
    // Не userData: путь Unix-сокета на macOS ограничен 104 байтами, а
    // «~/Library/Application Support/claude-voice-desk/sock/<uuid>.raw.sock» —
    // это 108. listen() падал, и сессия запускалась без чтения транскрипта:
    // ни ответов, ни действий в окне. Короткий каталог в /tmp, доступ только владельцу.
    this.dir = socketDir()
    this.framedSocketPath = join(this.dir, `${session.sessionId}.sock`)
    this.rawSocketPath = join(this.dir, `${session.sessionId}.raw.sock`)
  }

  get attachedCount(): number {
    return this.clients.size + this.rawClients.size
  }

  async listen(): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    this.unlinkSockets()

    this.session.on('data', (buf: Buffer) => this.broadcast(buf))
    this.session.on('exit', () => this.shutdown())

    this.framedServer = net.createServer((sock) => this.onFramedClient(sock))
    this.rawServer = net.createServer((sock) => this.onRawClient(sock))

    await Promise.all([
      new Promise<void>((res, rej) => {
        this.framedServer!.once('error', rej)
        this.framedServer!.listen(this.framedSocketPath, () => res())
      }),
      new Promise<void>((res, rej) => {
        this.rawServer!.once('error', rej)
        this.rawServer!.listen(this.rawSocketPath, () => res())
      })
    ])
  }

  private onFramedClient(sock: net.Socket): void {
    this.clients.add(sock)
    sock.write(frame(TAG_DATA, this.session.getScrollback()))
    this.emit('attach', this.attachedCount)

    let inbox = Buffer.alloc(0)
    sock.on('data', (chunk) => {
      inbox = inbox.length ? Buffer.concat([inbox, chunk]) : chunk
      for (;;) {
        if (inbox.length < HEADER) return
        const len = inbox.readUInt32BE(1)
        if (inbox.length < HEADER + len) return
        const tag = inbox[0]
        const payload = inbox.subarray(HEADER, HEADER + len)
        inbox = inbox.subarray(HEADER + len)

        if (tag === TAG_DATA) {
          this.session.write(payload)
        } else if (tag === TAG_CONTROL) {
          this.handleControl(payload)
        }
      }
    })

    const drop = (): void => {
      if (!this.clients.delete(sock)) return
      this.emit('detach', this.attachedCount)
    }
    sock.on('close', drop)
    sock.on('error', drop)
  }

  private onRawClient(sock: net.Socket): void {
    this.rawClients.add(sock)
    sock.write(this.session.getScrollback())
    // У raw-клиента нет канала для SIGWINCH, поэтому фиксируем размер PTY —
    // окно Terminal под него подгоняется через AppleScript при открытии.
    this.session.resize(DEFAULT_COLS, DEFAULT_ROWS)
    this.emit('attach', this.attachedCount)

    sock.on('data', (chunk) => this.session.write(chunk))

    const drop = (): void => {
      if (!this.rawClients.delete(sock)) return
      this.emit('detach', this.attachedCount)
    }
    sock.on('close', drop)
    sock.on('error', drop)
  }

  private handleControl(payload: Buffer): void {
    let msg: unknown
    try {
      msg = JSON.parse(payload.toString('utf8'))
    } catch {
      return
    }
    if (typeof msg !== 'object' || msg === null) return
    const m = msg as { t?: string; cols?: number; rows?: number }
    if (m.t === 'size' && typeof m.cols === 'number' && typeof m.rows === 'number') {
      this.session.resize(m.cols, m.rows)
    }
  }

  private broadcast(buf: Buffer): void {
    if (this.clients.size) {
      const framed = frame(TAG_DATA, buf)
      for (const sock of this.clients) {
        if (!sock.destroyed) sock.write(framed)
      }
    }
    for (const sock of this.rawClients) {
      if (!sock.destroyed) sock.write(buf)
    }
  }

  /**
   * Команда, которую нужно выполнить в терминале, чтобы присоединиться к сессии.
   * Возвращается наружу, чтобы UI мог показать её пользователю, если автоматическое
   * открытие окна не сработало (например, отклонено разрешение Automation).
   */
  async attachCommand(): Promise<string> {
    const nodeBin = await resolveNodeBin()
    if (nodeBin) {
      const bridgeScript = join(process.resourcesPath ?? app.getAppPath(), 'bridge.js')
      const script = existsSync(bridgeScript)
        ? bridgeScript
        : join(app.getAppPath(), 'resources', 'bridge.js')
      return `exec ${shellSingleQuote(nodeBin)} ${shellSingleQuote(script)} ${shellSingleQuote(this.framedSocketPath)}`
    }
    // Фолбэк без Node: сырой поток через nc. У macOS nc поддерживает -U.
    return `stty raw -echo; nc -U ${shellSingleQuote(this.rawSocketPath)}; stty sane`
  }

  /** Открывает окно Terminal.app, присоединённое к PTY этой сессии. */
  async openTerminalWindow(title: string): Promise<void> {
    const command = await this.attachCommand()
    const usingRawFallback = command.startsWith('stty')

    const lines = [
      'tell application "Terminal"',
      '  activate',
      `  do script "${escapeAppleScriptString(command)}"`,
      '  try',
      `    set custom title of front window to "${escapeAppleScriptString(title)}"`
    ]
    if (usingRawFallback) {
      // Без SIGWINCH размер PTY фиксирован — подгоняем окно под него,
      // иначе TUI будет рисоваться не по границам.
      lines.push(`    set number of columns of front window to ${DEFAULT_COLS}`)
      lines.push(`    set number of rows of front window to ${DEFAULT_ROWS}`)
    }
    lines.push('  end try', 'end tell')

    try {
      await execFileAsync('osascript', ['-e', lines.join('\n')], { timeout: 10_000 })
    } catch (err) {
      const text = err instanceof Error ? `${err.message}` : String(err)
      // -1743 / errAEEventNotPermitted — пользователь не дал разрешение на Automation.
      if (text.includes('-1743') || /not authori[sz]ed/i.test(text)) {
        throw new TerminalAutomationDeniedError()
      }
      throw err
    }
  }

  shutdown(): void {
    for (const sock of this.clients) {
      if (!sock.destroyed) {
        sock.write(frame(TAG_CONTROL, JSON.stringify({ t: 'bye' })))
        sock.end()
      }
    }
    for (const sock of this.rawClients) {
      if (!sock.destroyed) sock.end()
    }
    this.clients.clear()
    this.rawClients.clear()
    this.framedServer?.close()
    this.rawServer?.close()
    this.framedServer = null
    this.rawServer = null
    this.unlinkSockets()
  }

  private unlinkSockets(): void {
    for (const p of [this.framedSocketPath, this.rawSocketPath]) {
      try {
        rmSync(p, { force: true })
      } catch {
        // сокета может не быть — это нормально
      }
    }
  }
}

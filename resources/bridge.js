#!/usr/bin/env node
/**
 * Мост между окном Terminal.app и PTY, которым владеет приложение.
 *
 * Запускается внутри Terminal.app, подключается к Unix-сокету приложения и
 * проксирует stdin/stdout в raw-режиме. Благодаря этому пользователь видит и
 * управляет настоящей сессией Claude Code, а приложение остаётся владельцем PTY
 * и может отправлять туда текст обычной записью — без AppleScript-инъекции нажатий.
 *
 * Кадр: [tag:1][len:4 BE][payload]
 *   tag 0x00 — сырые данные терминала
 *   tag 0x01 — управляющий JSON
 *
 * Использование: node bridge.js /path/to/socket
 */
'use strict'

const net = require('node:net')

const TAG_DATA = 0x00
const TAG_CONTROL = 0x01
const HEADER = 5

const socketPath = process.argv[2]
if (!socketPath) {
  process.stderr.write('bridge: не передан путь к сокету\n')
  process.exit(2)
}

function frame(tag, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const head = Buffer.alloc(HEADER)
  head[0] = tag
  head.writeUInt32BE(body.length, 1)
  return Buffer.concat([head, body])
}

let restored = false
function restoreTty() {
  if (restored) return
  restored = true
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false)
    } catch {
      /* уже не tty */
    }
  }
}

function finish(code) {
  restoreTty()
  process.exit(code)
}

const sock = net.connect(socketPath)

sock.on('connect', () => {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  process.stdin.resume()
  sendSize()
})

function sendSize() {
  const cols = process.stdout.columns
  const rows = process.stdout.rows
  if (!cols || !rows) return
  sock.write(frame(TAG_CONTROL, JSON.stringify({ t: 'size', cols, rows })))
}

// Terminal.app присылает SIGWINCH при ресайзе окна — так приложение узнаёт
// реальный размер и подгоняет под него PTY, иначе TUI отрисуется неправильно.
process.on('SIGWINCH', sendSize)

process.stdin.on('data', (chunk) => {
  if (!sock.destroyed) sock.write(frame(TAG_DATA, chunk))
})

// Разбор потока обратно в кадры: Unix-сокет не сохраняет границы записей,
// поэтому склеиваем и режем по длине из заголовка.
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
      process.stdout.write(payload)
    } else if (tag === TAG_CONTROL) {
      let msg
      try {
        msg = JSON.parse(payload.toString('utf8'))
      } catch {
        continue
      }
      if (msg && msg.t === 'bye') {
        process.stdout.write('\r\n[сессия завершена]\r\n')
        finish(0)
      }
    }
  }
})

sock.on('error', (err) => {
  restoreTty()
  process.stderr.write(`\r\nbridge: не удалось подключиться к сессии: ${err.message}\r\n`)
  process.exit(1)
})

sock.on('close', () => {
  process.stdout.write('\r\n[отключено от сессии]\r\n')
  finish(0)
})

// Ctrl-C должен уходить в PTY как байт 0x03, а не убивать сам мост.
process.on('SIGINT', () => {
  if (!sock.destroyed) sock.write(frame(TAG_DATA, Buffer.from([0x03])))
})
process.on('SIGTERM', () => finish(0))
process.on('exit', restoreTty)

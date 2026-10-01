import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantState, HistorySession, SessionInfo } from '../../shared/types'
import {
  NOTHING_SEEN,
  PAIR_CODE_MAX_ATTEMPTS,
  PAIR_CODE_TTL_MS,
  VOICE_MAX_BYTES,
  VOICE_MAX_SECONDS,
  checkPairCode,
  HISTORY_REQUESTS,
  HISTORY_SESSIONS,
  formatHistory,
  formatStatus,
  messageInput,
  newPairCode,
  parseCallback,
  parseCommand,
  permissionKeyboard,
  planKeyboard,
  questionKeyboard,
  replyFor,
  sessionNotes,
  splitMessage
} from './bot-logic.ts'

const ASSISTANT: AssistantState = {
  phase: 'ready',
  plan: null,
  question: null,
  permission: null,
  needsInit: false,
  checkpoint: null,
  lastPlan: null,
  checks: [],
  review: null
}

function info(patch: Partial<SessionInfo> = {}, assistant: Partial<AssistantState> = {}): SessionInfo {
  return {
    sessionId: 's1',
    projectDir: '/Users/me/proj',
    title: null,
    status: 'idle',
    transcriptPath: null,
    permissionMode: null,
    model: null,
    terminalAttached: false,
    assistant: { ...ASSISTANT, ...assistant },
    ...patch
  }
}

test('parseCommand: команды, имя бота, аргументы, текст', () => {
  assert.deepEqual(parseCommand('/start 123456'), { kind: 'start', code: '123456' })
  assert.deepEqual(parseCommand('/start'), { kind: 'start', code: null })
  assert.deepEqual(parseCommand('/status@MyDeskBot'), { kind: 'status' })
  assert.deepEqual(parseCommand('/STOP'), { kind: 'stop' })
  assert.deepEqual(parseCommand('/history'), { kind: 'history' })
  assert.deepEqual(parseCommand('/foo'), { kind: 'unknown', name: 'foo' })
  assert.deepEqual(parseCommand('  выполняй '), { kind: 'text', text: 'выполняй' })
  assert.deepEqual(parseCommand('путь /usr/bin'), { kind: 'text', text: 'путь /usr/bin' })
  assert.equal(parseCommand('   '), null)
})

test('checkPairCode: верный код расходуется', () => {
  const pair = newPairCode(1000)
  assert.match(pair.code, /^\d{6}$/)
  assert.deepEqual(checkPairCode(pair, pair.code, 2000), { ok: true, next: null })
})

test('checkPairCode: неверные попытки исчерпывают код', () => {
  let pair = newPairCode(0)
  const wrong = pair.code === '000000' ? '111111' : '000000'
  for (let i = 1; i < PAIR_CODE_MAX_ATTEMPTS; i++) {
    const r = checkPairCode(pair, wrong, 1)
    assert.equal(r.ok, false)
    assert.ok(r.next)
    pair = r.next
  }
  const last = checkPairCode(pair, wrong, 1)
  assert.deepEqual(last, { ok: false, next: null })
})

test('checkPairCode: код действует сутки', () => {
  assert.equal(PAIR_CODE_TTL_MS, 24 * 60 * 60 * 1000)
  const pair = newPairCode(0)
  assert.equal(checkPairCode(pair, pair.code, 23 * 60 * 60 * 1000).ok, true)
})

test('checkPairCode: истёкший, пустой и отсутствующий код', () => {
  const pair = newPairCode(0)
  assert.deepEqual(checkPairCode(pair, pair.code, PAIR_CODE_TTL_MS + 1), { ok: false, next: null })
  assert.equal(checkPairCode(pair, null, 1).ok, false)
  assert.equal(checkPairCode(null, '123456', 1).ok, false)
})

test('splitMessage: короткий текст — одна часть', () => {
  assert.deepEqual(splitMessage('привет'), ['привет'])
  assert.deepEqual(splitMessage('   '), [])
})

test('splitMessage: режет по строкам и не превышает лимит', () => {
  const text = Array.from({ length: 30 }, (_, i) => `строка ${i} ${'x'.repeat(20)}`).join('\n')
  const parts = splitMessage(text, 200, 10)
  assert.ok(parts.length > 1)
  for (const p of parts) assert.ok(p.length <= 200)
  assert.equal(parts.join('\n'), text)
})

test('splitMessage: обрезает после maxParts частей', () => {
  const parts = splitMessage('слово '.repeat(1000), 100, 3)
  assert.equal(parts.length, 3)
  assert.ok(parts[2]!.endsWith('…продолжение — в приложении.'))
  for (const p of parts) assert.ok(p.length <= 100)
})

test('parseCallback и кнопки', () => {
  assert.deepEqual(parseCallback('open:3'), { kind: 'open', index: 3 })
  assert.equal(parseCallback('open:abc'), null)
  assert.equal(parseCallback('say:plan-ready:'), null)
  assert.equal(parseCallback('say:ready:выполняй'), null)
  assert.equal(parseCallback('say:выполняй'), null)
  assert.equal(parseCallback(undefined), null)
  assert.deepEqual(parseCallback(planKeyboard()[0]![0]!.callback_data), {
    kind: 'say',
    phase: 'plan-ready',
    text: 'выполняй'
  })
  assert.deepEqual(parseCallback(permissionKeyboard()[0]![1]!.callback_data), {
    kind: 'say',
    phase: 'permission',
    text: 'нет'
  })
  const q = questionKeyboard(['Первый', 'Второй'])
  assert.equal(q.length, 2)
  assert.deepEqual(parseCallback(q[1]![0]!.callback_data), { kind: 'say', phase: 'question', text: '2' })
  for (const row of q) for (const b of row) assert.ok(Buffer.byteLength(b.callback_data) <= 64)
})

test('replyFor: «Принято» только когда ассистент возьмёт текст', () => {
  assert.deepEqual(replyFor('checking', 'добавь тест'), {
    submit: false,
    reply: 'Claude проверяет результат — напишите, когда закончит.'
  })
  assert.deepEqual(replyFor('ready', 'добавь тест'), { submit: true, reply: 'Принято.' })
  assert.deepEqual(replyFor('executing', 'и ещё README'), { submit: true, reply: 'Принято.' })
  assert.deepEqual(replyFor('question', 'второй'), { submit: true, reply: 'Принято.' })
  assert.deepEqual(replyFor('question', 'сделай как лучше'), { submit: true, reply: null })
  assert.deepEqual(replyFor('permission', 'да'), { submit: true, reply: 'Принято.' })
  assert.deepEqual(replyFor('permission', 'может быть'), { submit: true, reply: null })
  assert.equal(replyFor('starting', 'задача').submit, true)
  assert.deepEqual(replyFor('checking', 'стоп'), { submit: true, reply: 'Останавливаю.' })
})

test('formatStatus', () => {
  assert.match(formatStatus(null), /не открыт/)
  assert.match(formatStatus(info({}, { phase: 'executing' })), /proj[\s\S]*работает/)
  assert.match(formatStatus(info({ status: 'stopped' })), /завершился/)
})

test('sessionNotes: новый проект, затем тишина без изменений', () => {
  const first = sessionNotes(NOTHING_SEEN, info({}, { phase: 'starting' }))
  assert.deepEqual(first.notes, [{ kind: 'opened', dir: '/Users/me/proj' }])
  const again = sessionNotes(first.seen, info({}, { phase: 'ready' }))
  assert.deepEqual(again.notes, [])
})

test('sessionNotes: план сообщается один раз и снова после следующего плана', () => {
  let s = sessionNotes(NOTHING_SEEN, info()).seen
  const plan = sessionNotes(s, info({}, { phase: 'plan-ready', plan: 'шаг 1' }))
  assert.deepEqual(plan.notes, [{ kind: 'plan', text: 'шаг 1' }])
  assert.deepEqual(sessionNotes(plan.seen, info({}, { phase: 'plan-ready', plan: 'шаг 1' })).notes, [])
  s = sessionNotes(plan.seen, info({}, { phase: 'planning' })).seen
  assert.deepEqual(sessionNotes(s, info({}, { phase: 'plan-ready', plan: 'шаг 1' })).notes, [
    { kind: 'plan', text: 'шаг 1' }
  ])
})

test('sessionNotes: вопрос и согласие', () => {
  const s = sessionNotes(NOTHING_SEEN, info()).seen
  const q = sessionNotes(s, info({}, { phase: 'question', question: { question: 'Какой?', options: ['А', 'Б'] } }))
  assert.deepEqual(q.notes, [
    { kind: 'question', question: 'Какой?', options: ['А', 'Б'], multiSelect: false, position: null }
  ])
  const p = sessionNotes(s, info({}, { phase: 'permission', permission: { tool: 'Bash', summary: 'rm -rf build' } }))
  assert.deepEqual(p.notes, [{ kind: 'permission', summary: 'rm -rf build' }])
})

test('sessionNotes: несколько вопросов — по сообщению на каждый, даже одинаковых', () => {
  const s = sessionNotes(NOTHING_SEEN, info()).seen
  const question = (index: number) =>
    info({}, { phase: 'question', question: { question: 'Какие?', options: ['А', 'Б'], multiSelect: true, index, total: 2 } })
  const first = sessionNotes(s, question(0))
  assert.deepEqual(first.notes, [
    { kind: 'question', question: 'Какие?', options: ['А', 'Б'], multiSelect: true, position: 'Вопрос 1 из 2' }
  ])
  assert.deepEqual(sessionNotes(first.seen, question(0)).notes, [])
  assert.equal(sessionNotes(first.seen, question(1)).notes.length, 1)
})

test('replyFor: несколько номеров на вопрос — принято', () => {
  assert.deepEqual(replyFor('question', '1 3'), { submit: true, reply: 'Принято.' })
})

test('sessionNotes: Claude Code завершился сам, а остановку приложением не сообщаем', () => {
  const s = sessionNotes(NOTHING_SEEN, info()).seen
  const exited = sessionNotes(s, info({ status: 'stopped' }))
  assert.deepEqual(exited.notes, [{ kind: 'exited' }])
  assert.deepEqual(sessionNotes(exited.seen, info({ status: 'stopped' })).notes, [])
  assert.deepEqual(sessionNotes(s, null).notes, [])
})

test('messageInput: текст, голосовое в пределах лимитов, всё прочее', () => {
  assert.deepEqual(messageInput({ text: 'выполняй' }), { kind: 'text', text: 'выполняй' })
  assert.deepEqual(messageInput({ voice: { file_id: 'v1', duration: 12, file_size: 40_000 } }), {
    kind: 'voice',
    fileId: 'v1'
  })
  assert.deepEqual(messageInput({ voice: { file_id: 'v2', duration: VOICE_MAX_SECONDS } }), {
    kind: 'voice',
    fileId: 'v2'
  })
  assert.equal(messageInput({ voice: { file_id: 'v3', duration: VOICE_MAX_SECONDS + 1 } }).kind, 'rejected')
  assert.equal(
    messageInput({ voice: { file_id: 'v4', duration: 10, file_size: VOICE_MAX_BYTES + 1 } }).kind,
    'rejected'
  )
  assert.equal(messageInput({}).kind, 'rejected')
})

function historySession(id: string, title: string, updatedAt: number, texts: string[]): HistorySession {
  return {
    id,
    title,
    startedAt: updatedAt,
    updatedAt,
    fromApp: true,
    requests: texts.map((text, i) => ({
      text,
      at: updatedAt + i * 60_000,
      outcome: i === 0 ? 'plan' : 'edits',
      files: i === 0 ? 0 : 2
    }))
  }
}

test('formatHistory: текущая сессия с итогами и прошлые сессии', () => {
  const now = new Date(2026, 9, 1, 15, 0).getTime()
  const today = new Date(2026, 9, 1, 12, 30).getTime()
  const yesterday = new Date(2026, 8, 30, 18, 40).getTime()
  const text = formatHistory(
    '/Users/me/Claude_asist',
    [
      historySession('cur', 'Панель истории', today, ['сделай панель истории', 'добавь команду в бота']),
      historySession('old', 'Тёмная тема', yesterday, ['сделай тёмную тему'])
    ],
    'cur',
    now
  )
  assert.match(text, /^История: Claude_asist/)
  assert.match(text, /Сейчас — Панель истории/)
  assert.match(text, /12:30 · план — сделай панель истории/)
  assert.match(text, /12:31 · правки: 2 — добавь команду в бота/)
  assert.match(text, /Раньше:\n• вчера, 18:40 — Тёмная тема \(1 запрос\)/)
})

test('formatHistory: новая сессия, лимиты и длинный текст', () => {
  const now = new Date(2026, 9, 1, 15, 0).getTime()
  assert.match(formatHistory('/p', [], 'cur', now), /новая сессия, запросов пока нет/)
  assert.doesNotMatch(formatHistory('/p', [], 'cur', now), /Раньше/)

  const many = Array.from({ length: HISTORY_REQUESTS + 3 }, (_, i) => `запрос ${i} ${'х'.repeat(200)}`)
  const past = Array.from({ length: HISTORY_SESSIONS + 2 }, (_, i) => historySession(`p${i}`, `сессия ${i}`, now - 1000, ['a']))
  const text = formatHistory('/p', [historySession('cur', 'Т', now, many), ...past], 'cur', now)
  assert.match(text, /…и ещё 3 запроса раньше/)
  assert.doesNotMatch(text, /запрос 2 /)
  assert.match(text, /запрос 3 /)
  assert.equal(text.match(/^• /gm)?.length, HISTORY_SESSIONS)
  assert.ok(text.split('\n').every((line) => line.length < 200))
})

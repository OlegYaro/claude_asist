import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  ECHO_TAIL_MS,
  PHRASE_LIMIT_MS,
  Speaker,
  VoiceCatalog,
  WindowVoice,
  hasLiveVoice,
  parseRussianVoices,
  sayArgs,
  synthArgs,
  type SayProcess
} from './speaker.ts'

interface FakeProcess extends SayProcess {
  text: string
  killed: boolean
  finish(): void
  fail(): void
}

function setup(t: TestContext): { speaker: Speaker; procs: FakeProcess[]; states: boolean[] } {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const procs: FakeProcess[] = []
  const speaker = new Speaker((text) => {
    let finish = (): void => {}
    let fail = (): void => {}
    const done = new Promise<void>((resolve, reject) => {
      finish = resolve
      fail = () => reject(new Error('say упал'))
    })
    const proc: FakeProcess = {
      text,
      killed: false,
      done,
      finish: () => finish(),
      fail: () => fail(),
      kill: () => {
        proc.killed = true
        finish()
      }
    }
    procs.push(proc)
    return proc
  })
  const states: boolean[] = []
  speaker.on('speaking', (s: boolean) => states.push(s))
  return { speaker, procs, states }
}

/** Даём отработать цепочке промисов после завершения процесса. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('микрофон глохнет с первой фразы и оживает после хвоста на эхо', async (t) => {
  const { speaker, procs, states } = setup(t)
  speaker.say('Готово.')
  assert.deepEqual(states, [true])
  procs[0]!.finish()
  await flush()
  t.mock.timers.tick(ECHO_TAIL_MS - 1)
  assert.equal(speaker.isSpeaking, true)
  t.mock.timers.tick(1)
  assert.deepEqual(states, [true, false])
})

test('две фразы подряд: говорим по очереди, микрофон молчит до конца второй', async (t) => {
  const { speaker, procs, states } = setup(t)
  speaker.say('Ревью нашло замечания.')
  speaker.say('План готов. Скажите «выполняй».')
  assert.equal(procs.length, 1)
  procs[0]!.finish()
  await flush()
  assert.equal(procs[1]?.text, 'План готов. Скажите «выполняй».')
  t.mock.timers.tick(ECHO_TAIL_MS * 10)
  assert.equal(speaker.isSpeaking, true)
  procs[1]!.finish()
  await flush()
  t.mock.timers.tick(ECHO_TAIL_MS)
  assert.deepEqual(states, [true, false])
})

test('новая фраза во время хвоста на эхо не даёт микрофону включиться', async (t) => {
  const { speaker, procs, states } = setup(t)
  speaker.say('Первая.')
  procs[0]!.finish()
  await flush()
  t.mock.timers.tick(ECHO_TAIL_MS - 100)
  speaker.say('Вторая.')
  t.mock.timers.tick(ECHO_TAIL_MS)
  assert.deepEqual(states, [true])
  assert.equal(procs.length, 2)
})

test('stop() обрывает фразу и очередь, микрофон оживает после хвоста', async (t) => {
  const { speaker, procs, states } = setup(t)
  speaker.say('Первая.')
  speaker.say('Вторая.')
  speaker.stop()
  assert.equal(procs[0]!.killed, true)
  await flush()
  assert.equal(procs.length, 1)
  t.mock.timers.tick(ECHO_TAIL_MS)
  assert.deepEqual(states, [true, false])
})

test('зависший say убивается по пределу, долгая речь до предела не прерывается', async (t) => {
  const { speaker, procs } = setup(t)
  speaker.say('Очень длинная фраза.')
  t.mock.timers.tick(PHRASE_LIMIT_MS - 1)
  assert.equal(procs[0]!.killed, false)
  assert.equal(speaker.isSpeaking, true)
  t.mock.timers.tick(1)
  assert.equal(procs[0]!.killed, true)
  await flush()
  t.mock.timers.tick(ECHO_TAIL_MS)
  assert.equal(speaker.isSpeaking, false)
})

test('ошибка say не останавливает очередь и не глушит микрофон навсегда', async (t) => {
  const { speaker, procs, states } = setup(t)
  speaker.say('Первая.')
  speaker.say('Вторая.')
  procs[0]!.fail()
  await flush()
  assert.equal(procs[1]?.text, 'Вторая.')
  procs[1]!.fail()
  await flush()
  t.mock.timers.tick(ECHO_TAIL_MS)
  assert.deepEqual(states, [true, false])
})

test('пустой текст не озвучивается', (t) => {
  const { speaker, procs, states } = setup(t)
  speaker.say('   ')
  assert.equal(procs.length, 0)
  assert.deepEqual(states, [])
})

test('фраза, начинающаяся с «-», доходит до раннера и say целиком, а не как опция', (t) => {
  const { speaker, procs } = setup(t)
  speaker.say('-f /etc/hosts')
  assert.equal(procs[0]?.text, '-f /etc/hosts')
  assert.deepEqual(sayArgs('--no-verify пропускает хуки', { voice: 'Milena', rate: null }), [
    '-v',
    'Milena',
    '--',
    '--no-verify пропускает хуки'
  ])
  assert.deepEqual(sayArgs('-o /tmp/x.aiff', { voice: null, rate: null }), ['--', '-o /tmp/x.aiff'])
  const synth = synthArgs('/tmp/a.wav', '-f /etc/hosts', { voice: null, rate: 200 })
  assert.deepEqual(synth.slice(-4), ['-r', '200', '--', '-f /etc/hosts'])
  assert.deepEqual(synth.slice(0, 2), ['-o', '/tmp/a.wav'])
})

test('скорость вне разумных пределов не передаётся say', () => {
  assert.deepEqual(sayArgs('Привет', { voice: null, rate: 5 }), ['--', 'Привет'])
  assert.deepEqual(sayArgs('Привет', { voice: null, rate: Number.NaN }), ['--', 'Привет'])
  assert.deepEqual(sayArgs('Привет', { voice: null, rate: 190.4 }), ['-r', '190', '--', 'Привет'])
})

test('parseRussianVoices: только ru_RU, премиум и улучшенные первыми, без повторов', () => {
  const list = [
    'Alex                en_US    # Most people recognize me by my voice.',
    'Milena (Russian (Russia)) ru_RU    # Здравствуйте! Меня зовут Милена.',
    'Milena (Russian (Russia)) ru_RU    # Здравствуйте! Меня зовут Милена.',
    'Yuri                ru_RU    # Здравствуйте!',
    'Milena (Enhanced)   ru_RU    # Здравствуйте!',
    'Katya (Premium)     ru_RU    # Здравствуйте!'
  ].join('\n')
  assert.deepEqual(parseRussianVoices(list), [
    'Katya (Premium)',
    'Milena (Enhanced)',
    'Milena (Russian (Russia))',
    'Yuri'
  ])
  assert.deepEqual(parseRussianVoices('Alex                en_US    # Hi'), [])
})

test('hasLiveVoice: только компактные голоса — нет, улучшенный или премиум — да', () => {
  assert.equal(hasLiveVoice(['Milena (Russian (Russia))', 'Yuri']), false)
  assert.equal(hasLiveVoice([]), false)
  assert.equal(hasLiveVoice(['Milena (Russian (Russia))', 'Milena (Enhanced)']), true)
  assert.equal(hasLiveVoice(['Милена (премиум)']), true)
})

test('VoiceCatalog: выбранный голос, если установлен, иначе лучший; refresh перечитывает', async () => {
  let installed = ['Milena (Russian (Russia))']
  let reads = 0
  const catalog = new VoiceCatalog(async () => {
    reads++
    return installed
  })
  assert.equal(await catalog.resolve('Katya (Premium)'), 'Milena (Russian (Russia))')
  installed = ['Katya (Premium)', 'Milena (Russian (Russia))']
  assert.equal(await catalog.resolve(null), 'Milena (Russian (Russia))', 'без refresh список прежний')
  await catalog.refresh()
  assert.equal(await catalog.resolve(null), 'Katya (Premium)')
  assert.equal(await catalog.resolve('Milena (Russian (Russia))'), 'Milena (Russian (Russia))')
  assert.equal(reads, 2)
  assert.equal(await new VoiceCatalog(async () => []).resolve(null), null)
})

// ───────────── WindowVoice: звук играет окно ─────────────

function windowVoice(ready = true, synthOk = true): {
  voice: WindowVoice
  played: { id: number; text: string }[]
  cancelled: number[]
  synthesized: string[]
  fallback: string[]
} {
  const played: { id: number; text: string }[] = []
  const cancelled: number[] = []
  const synthesized: string[] = []
  const fallback: string[] = []
  const voice = new WindowVoice(
    {
      ready: () => ready,
      play: (id, _wav, text) => played.push({ id, text }),
      cancel: (id) => cancelled.push(id)
    },
    async () => ({ voice: null, rate: null }),
    (text) => {
      fallback.push(text)
      return { done: Promise.resolve(), kill: () => {} }
    },
    async (text) => {
      synthesized.push(text)
      return synthOk ? Buffer.from('RIFF') : null
    }
  )
  return { voice, played, cancelled, synthesized, fallback }
}

test('WindowVoice: фраза кончается, когда окно сообщит ended', async () => {
  const { voice, played } = windowVoice()
  let finished = false
  const proc = voice.run('Готово.')
  void proc.done.then(() => (finished = true))
  await flush()
  assert.deepEqual(played.map((p) => p.text), ['Готово.'])
  assert.equal(finished, false)
  voice.ended(played[0]!.id)
  await flush()
  assert.equal(finished, true)
})

test('WindowVoice: kill отменяет воспроизведение в окне и завершает фразу', async () => {
  const { voice, played, cancelled } = windowVoice()
  const proc = voice.run('Длинный ответ.')
  await flush()
  proc.kill()
  await proc.done
  assert.deepEqual(cancelled, [played[0]!.id])
})

test('WindowVoice: kill до конца синтеза — в окно ничего не уходит', async () => {
  const { voice, played } = windowVoice()
  const proc = voice.run('Фраза.')
  proc.kill()
  await proc.done
  assert.deepEqual(played, [])
})

test('WindowVoice: заготовленная фраза не синтезируется второй раз, reset забывает заготовки', async () => {
  const { voice, synthesized } = windowVoice()
  voice.hooks.prepare?.('Вторая.')
  voice.hooks.prepare?.('Вторая.')
  void voice.run('Вторая.')
  await flush()
  assert.deepEqual(synthesized, ['Вторая.'])
  voice.hooks.prepare?.('Третья.')
  voice.hooks.reset?.()
  void voice.run('Третья.')
  await flush()
  assert.deepEqual(synthesized, ['Вторая.', 'Третья.', 'Третья.'])
})

test('WindowVoice: без окна говорит прямо через say, endAll отпускает зависшие фразы', async () => {
  const noWindow = windowVoice(false)
  await noWindow.voice.run('Привет.').done
  assert.deepEqual(noWindow.fallback, ['Привет.'])

  const { voice } = windowVoice()
  const proc = voice.run('Окно перезагрузили.')
  await flush()
  voice.endAll()
  await proc.done
})

test('WindowVoice: синтез в файл не удался — фраза звучит через say, а не пропадает', async () => {
  const { voice, played, fallback } = windowVoice(true, false)
  await voice.run('Готово.').done
  assert.deepEqual(played, [])
  assert.deepEqual(fallback, ['Готово.'])
})

test('Speaker готовит следующую фразу, пока звучит текущая', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const prepared: string[] = []
  const finishers: (() => void)[] = []
  const speaker = new Speaker(
    () => {
      let finish = (): void => {}
      const done = new Promise<void>((resolve) => (finish = resolve))
      finishers.push(finish)
      return { done, kill: finish }
    },
    { prepare: (text) => prepared.push(text) }
  )
  speaker.say('Первая.')
  speaker.say('Вторая.')
  speaker.say('Третья.')
  assert.deepEqual(prepared, ['Вторая.'])
  finishers[0]!()
  await flush()
  assert.deepEqual(prepared, ['Вторая.', 'Третья.'])
})

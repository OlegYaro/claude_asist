/**
 * Плагины Claude Code, которые по умолчанию выключены: их описания инструментов
 * уходят в каждый запрос и раздувают расход токенов. Claude просит нужный
 * маркером в ответе, приложение показывает кнопку и перезапускает сессию с ним.
 */
export interface PluginInfo {
  /** Короткий id, который Claude пишет в маркере. */
  id: string
  /** Ключ в `enabledPlugins` настроек Claude Code. */
  key: string
  title: string
  /** Для чего нужен — показывается в карточке и в протоколе. */
  purpose: string
}

export const PLUGINS: readonly PluginInfo[] = [
  {
    id: 'playwright',
    key: 'playwright@claude-plugins-official',
    title: 'Playwright',
    purpose: 'управление браузером: открыть страницу, нажать, сделать снимок экрана'
  },
  {
    id: 'context7',
    key: 'context7@claude-plugins-official',
    title: 'Context7',
    purpose: 'актуальная документация библиотек и фреймворков'
  },
  {
    id: 'pr-review-toolkit',
    key: 'pr-review-toolkit@claude-plugins-official',
    title: 'PR Review Toolkit',
    purpose: 'специализированные агенты для ревью кода и тестов'
  },
  {
    id: 'feature-dev',
    key: 'feature-dev@claude-plugins-official',
    title: 'Feature Dev',
    purpose: 'агенты для исследования кода и проектирования крупной функции'
  }
]

export function findPlugin(id: string): PluginInfo | null {
  return PLUGINS.find((p) => p.id === id) ?? null
}

const MARKER = /\[\[\s*подключить\s*:\s*([a-z0-9-]+)\s*\]\]/gi

/**
 * Ищет в ответе Claude маркер `[[подключить: playwright]]`. Возвращает первый
 * известный плагин (неизвестные id игнорируются) и текст без маркеров.
 */
export function parsePluginRequest(text: string): { plugin: PluginInfo | null; text: string } {
  let plugin: PluginInfo | null = null
  for (const match of text.matchAll(MARKER)) {
    plugin ??= findPlugin((match[1] ?? '').toLowerCase())
  }
  if (!MARKER.test(text)) return { plugin, text }
  MARKER.lastIndex = 0
  return { plugin, text: text.replace(MARKER, '').replace(/\n{3,}/g, '\n\n').trim() }
}

/** Фрагмент `enabledPlugins` для `--settings`: только перечисленные id, включёнными. */
export function enabledPluginsSetting(ids: Iterable<string>): Record<string, true> {
  const out: Record<string, true> = {}
  for (const id of ids) {
    const plugin = findPlugin(id)
    if (plugin) out[plugin.key] = true
  }
  return out
}

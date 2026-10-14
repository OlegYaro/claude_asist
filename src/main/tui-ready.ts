/**
 * Признаки того, что TUI Claude Code запущен и принимает ввод. Экран приходит
 * без ANSI и пробелов (см. `flatten` в assistant.ts).
 *
 * Нижняя подсказка («? for shortcuts», «shift+tab to cycle») не годится как
 * единственный признак: нашу статус-строку Claude Code рисует на её месте.
 * Поэтому ещё смотрим на рамку поля ввода — строку «│ > …».
 */
const FOOTER_HINTS = ['shift+tabtocycle', 'forshortcuts']
// «(?!\d+\.)»: в стартовых диалогах курсор «❯» тоже стоит у рамки, но перед номером пункта.
const INPUT_BOX = /[│┃][>❯](?!\d+\.)/

export function isTuiReady(flatScreen: string): boolean {
  return FOOTER_HINTS.some((hint) => flatScreen.includes(hint)) || INPUT_BOX.test(flatScreen)
}

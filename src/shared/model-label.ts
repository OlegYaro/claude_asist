/**
 * Читаемое имя модели для шапки: `claude-sonnet-5-5` → «Sonnet 5.5». Незнакомый id
 * показываем как есть, служебный `<synthetic>` (его пишет сам Claude Code) — не модель.
 */
export function modelLabel(id: string): string | null {
  if (id.startsWith('<')) return null
  // Алиас из input.model вызова Agent: версии в нём нет.
  if (/^(opus|sonnet|haiku)$/.test(id)) return id.charAt(0).toUpperCase() + id.slice(1)
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/.exec(id)
  if (!m) return id
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1)
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
}

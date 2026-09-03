import type { Replay, ReplayPath } from './city/model'

export const FINAL_LOC_REPORT_LIMIT = 1_000

function reportNumber(value: number) {
  return value.toLocaleString('en-US')
}

function markdownCode(value: string) {
  const escaped = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\n', '&#10;')
  return `<code>${escaped}</code>`
}

function compareFinalLoc(left: ReplayPath, right: ReplayPath) {
  const locDifference = right.finalLoc - left.finalLoc
  if (locDifference) return locDifference
  if (left.path < right.path) return -1
  if (left.path > right.path) return 1
  return left.id - right.id
}

export function finalCityPaths(paths: ReplayPath[]) {
  return paths
    .filter((path) => (path.category === 'source' || path.category === 'test') && path.finalLoc > 0)
    .sort(compareFinalLoc)
}

export function buildFinalLocMarkdown(
  replay: Replay,
  limit = FINAL_LOC_REPORT_LIMIT,
) {
  const allPaths = finalCityPaths(replay.paths)
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : FINAL_LOC_REPORT_LIMIT
  const selectedPaths = allPaths.slice(0, safeLimit)
  const finalCityLoc = allPaths.reduce((sum, path) => sum + path.finalLoc, 0)
  const listedLoc = selectedPaths.reduce((sum, path) => sum + path.finalLoc, 0)
  const lines = [
    `# Final LOC report for ${markdownCode(replay.repo)}`,
    '',
    `- Replay tip: ${markdownCode(replay.tip)}`,
    `- Replay end: ${markdownCode(replay.end)}`,
    '- Scope: non-empty source and test files in the final city state',
    `- Files listed: ${reportNumber(selectedPaths.length)} of ${reportNumber(allPaths.length)}`,
    `- Final city LOC: ${reportNumber(finalCityLoc)}`,
    `- LOC represented below: ${reportNumber(listedLoc)}`,
    '',
    '| Rank | LOC | Category | Path |',
    '| ---: | ---: | --- | --- |',
    ...selectedPaths.map((path, index) => (
      `| ${index + 1} | ${reportNumber(path.finalLoc)} | ${path.category} | ${markdownCode(path.path)} |`
    )),
    '',
  ]
  return lines.join('\n')
}

export function finalLocMarkdownFilename(repo: string) {
  const slug = repo
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return `${slug || 'repository'}-top-loc.md`
}

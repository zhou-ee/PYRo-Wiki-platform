export type NavigationIndex = Record<string, string | null>

export type SnapshotNavigationEntry = {
  document_path: string
  sidebar_label: string | null
  deleted: number
}

export const NAVIGATION_HELPER_PATH = '.vitepress/pyro-wiki-sidebar.ts'
export const NAVIGATION_INDEX_PATH = '.vitepress/pyro-wiki-sidebar-labels.json'
export const NAVIGATION_BASELINE_PATH = '.vitepress/pyro-wiki-sidebar-baseline.ts'

const IMPORT_LINE = "import { pyroWikiSidebar } from './pyro-wiki-sidebar'"
const BASELINE_IMPORT_LINE = "import { sidebarBaseline } from './pyro-wiki-sidebar-baseline'"

function removeMigratedStaticEntries(source: string): string {
  return source.replace(/\{\s*text:\s*(['"])GPIO\1\s*,\s*link:\s*(['"])\/PYRo-uCtrl-Unity\/Peripheral\/GPIO\2\s*\}\s*,?/g, '')
}

function normalizeSidebarCalls(source: string): string {
  let retained = false
  return source.replace(/\bsidebar\s*:\s*pyroWikiSidebar\s*\(\s*(?:sidebarBaseline)?\s*\)\s*,?/g, () => {
    if (retained) return ''
    retained = true
    return 'sidebar: pyroWikiSidebar(sidebarBaseline),'
  })
}

function skipTrivia(source: string, start: number): number {
  let index = start
  while (index < source.length) {
    if (/\s/.test(source[index])) { index += 1; continue }
    if (source[index] === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2)
      if (index < 0) return source.length
      continue
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      return end < 0 ? source.length : skipTrivia(source, end + 2)
    }
    break
  }
  return index
}

function findCodeWord(source: string, word: string): number {
  let quote = ''
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index <= source.length - word.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) { if (character === '\n') lineComment = false; continue }
    if (blockComment) { if (character === '*' && next === '/') { blockComment = false; index += 1 }; continue }
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '/' && next === '/') { lineComment = true; index += 1; continue }
    if (character === '/' && next === '*') { blockComment = true; index += 1; continue }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue }
    if (source.slice(index, index + word.length) !== word) continue
    const before = source[index - 1]
    const after = source[index + word.length]
    if ((!before || !/[\w$]/.test(before)) && (!after || !/[\w$]/.test(after))) return index
  }
  return -1
}

function matchingBrace(source: string, open: number): number {
  let depth = 0
  let quote = ''
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) { if (character === '\n') lineComment = false; continue }
    if (blockComment) { if (character === '*' && next === '/') { blockComment = false; index += 1 }; continue }
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '/' && next === '/') { lineComment = true; index += 1; continue }
    if (character === '/' && next === '*') { blockComment = true; index += 1; continue }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue }
    if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return index
  }
  return -1
}

export function ensureNavigationConfig(source: string): { content: string; baselineContent?: string; changed: boolean } {
  if (source.includes(IMPORT_LINE) && source.includes(BASELINE_IMPORT_LINE) && /\bsidebar\s*:\s*pyroWikiSidebar\s*\(\s*sidebarBaseline\s*\)/.test(source)) {
    const content = normalizeSidebarCalls(source)
    return { content, changed: content !== source }
  }
  const sidebar = findCodeWord(source, 'sidebar')
  if (sidebar < 0) throw new Error('Could not locate VitePress sidebar configuration')
  const colon = skipTrivia(source, sidebar + 'sidebar'.length)
  if (source[colon] !== ':') throw new Error('VitePress sidebar property is malformed')
  const open = skipTrivia(source, colon + 1)
  if (source[open] !== '{') throw new Error('VitePress sidebar baseline must be an object')
  const close = matchingBrace(source, open)
  if (close < 0) throw new Error('VitePress sidebar object is not balanced')
  const baseline = removeMigratedStaticEntries(source.slice(open, close + 1))
  let updated = normalizeSidebarCalls(`${source.slice(0, open)}pyroWikiSidebar(sidebarBaseline)${source.slice(close + 1)}`)
  if (!updated.includes(BASELINE_IMPORT_LINE)) updated = `${BASELINE_IMPORT_LINE}\n${updated}`
  if (!updated.includes(IMPORT_LINE)) updated = `${IMPORT_LINE}\n${updated}`
  return { content: updated, baselineContent: `export const sidebarBaseline = ${baseline}\n`, changed: true }
}

export function parseNavigationIndex(source: string | undefined): NavigationIndex {
  if (!source?.trim()) return {}
  try {
    const value = JSON.parse(source) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).flatMap(([path, label]) => label === null || typeof label === 'string' ? [[path, label]] : []))
  } catch {
    return {}
  }
}

export function mergeNavigationIndex(existing: NavigationIndex, snapshot: SnapshotNavigationEntry[]): NavigationIndex {
  const merged: NavigationIndex = { ...existing }
  for (const item of snapshot) {
    if (item.deleted) merged[item.document_path] = null
    else if (item.sidebar_label?.trim()) merged[item.document_path] = item.sidebar_label.trim()
  }
  return Object.fromEntries(Object.entries(merged).sort(([left], [right]) => left.localeCompare(right)))
}

export const NAVIGATION_HELPER_SOURCE = `import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

type SidebarItem = { text: string; link?: string; items?: SidebarItem[]; collapsed?: boolean }
type Sidebar = Record<string, SidebarItem[]>
type NavigationIndex = Record<string, string | null>

function normalizePath(value: string): string { return value.replaceAll('\\\\', '/') }
function routeFor(documentPath: string): string {
  const route = normalizePath(documentPath).replace(/\\.md$/i, '')
  return route.endsWith('/index') ? '/' + route.slice(0, -6) : '/' + route
}
function directoryForRoute(route: string): string { return route.slice(0, Math.max(1, route.lastIndexOf('/'))) }
function links(items: SidebarItem[]): string[] { return items.flatMap((item) => [...(item.link ? [item.link] : []), ...(item.items ? links(item.items) : [])]) }
function commonDirectory(items: SidebarItem[]): string | undefined {
  const values = links(items).map(directoryForRoute)
  if (!values.length) return undefined
  const parts = values[0].split('/')
  while (parts.length && values.some((value) => value !== parts.join('/') && !value.startsWith(parts.join('/') + '/'))) parts.pop()
  return parts.join('/') || '/'
}
function findByLink(items: SidebarItem[], link: string): SidebarItem | undefined {
  for (const item of items) {
    if (item.link === link) return item
    const nested = item.items && findByLink(item.items, link)
    if (nested) return nested
  }
  return undefined
}
function removeByLink(items: SidebarItem[], link: string): void {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.link === link && !item.items?.length) items.splice(index, 1)
    else if (item.items) {
      removeByLink(item.items, link)
      if (item.link === link) item.link = links(item.items)[0]
    }
  }
}
function sectionFor(sidebar: Sidebar, route: string): string | undefined {
  return Object.keys(sidebar).filter((section) => route === section || route.startsWith(section + '/')).sort((left, right) => right.length - left.length)[0]
}
function rootItems(items: SidebarItem[], section: string): SidebarItem[] {
  if (items.length === 1 && items[0].items && links(items[0].items).every((link) => link === section || link.startsWith(section + '/'))) return items[0].items
  return items
}
function deepestContainer(items: SidebarItem[], targetDirectory: string, section: string): { items: SidebarItem[]; prefix: string; depth: number } {
  let best = { items, prefix: section, depth: 0 }
  for (const item of items) {
    if (!item.items?.length) continue
    const prefix = commonDirectory(item.items)
    if (!prefix || (targetDirectory !== prefix && !targetDirectory.startsWith(prefix + '/'))) continue
    const nested = deepestContainer(item.items, targetDirectory, prefix)
    const candidate = nested.depth > 0 ? nested : { items: item.items, prefix, depth: 1 }
    if (candidate.prefix.length > best.prefix.length || candidate.depth > best.depth) best = candidate
  }
  return best
}
function add(items: SidebarItem[], section: string, documentPath: string, label: string): void {
  const link = routeFor(documentPath)
  const existing = findByLink(items, link)
  if (existing) { existing.text = label; return }
  const targetDirectory = directoryForRoute(link)
  const root = rootItems(items, section)
  const container = deepestContainer(root, targetDirectory, section)
  let target = container.items
  const remainder = targetDirectory.slice(container.prefix.length).replace(/^\\//, '')
  for (const segment of remainder.split('/').filter(Boolean)) {
    let group = target.find((item) => item.items && item.text === segment)
    if (!group) { group = { text: segment, collapsed: true, items: [] }; target.push(group) }
    target = group.items!
  }
  target.push({ text: label, link })
}

export function pyroWikiSidebar(baseline: Sidebar, root = process.cwd()): Sidebar {
  const sidebar = JSON.parse(JSON.stringify(baseline)) as Sidebar
  const indexPath = path.join(root, '.vitepress', 'pyro-wiki-sidebar-labels.json')
  const index: NavigationIndex = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8').replace(/^\\uFEFF/, '')) : {}
  for (const [documentPath, label] of Object.entries(index)) {
    const route = routeFor(documentPath)
    const section = sectionFor(sidebar, route)
    if (!section) continue
    if (label === null) removeByLink(sidebar[section], route)
    else if (label.trim()) add(sidebar[section], section, documentPath, label.trim())
  }
  return sidebar
}
`

export interface Member {
  id: string
  name: string
  avatar?: string
  title?: string
  description?: string
  links?: Array<{ icon?: string; link: string }>
}

export interface PreviewOptions {
  members?: Record<string, Member>
  theme?: 'light' | 'dark'
  documentUri?: string
}

const COMPONENT_MARKER = '@@PYRO_COMPONENT_'

type ComponentChild = string | ComponentNode

interface ComponentNode {
  name: string
  attributes: string
  children: ComponentChild[]
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character)
}

function stripFrontmatter(markdown: string): string {
  const source = markdown.replace(/^\uFEFF/, '')
  if (!/^---\s*(?:\r?\n|$)/.test(source)) return source
  const firstLineEnd = source.indexOf('\n')
  if (firstLineEnd < 0) return ''
  const rest = source.slice(firstLineEnd + 1)
  const closingOffset = rest.search(/^---\s*$/m)
  if (closingOffset < 0) return source
  const closing = firstLineEnd + 1 + closingOffset
  const lineEnd = source.indexOf('\n', closing)
  return lineEnd < 0 ? '' : source.slice(lineEnd + 1)
}

function splitProtected(markdown: string): string[] {
  const parts: string[] = []
  let cursor = 0
  // Vue-like tags inside fenced or inline code are literal source and must never be parsed.
  const protectedPattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\r\n]+`)/g
  let match: RegExpExecArray | null
  while ((match = protectedPattern.exec(markdown))) {
    if (match.index > cursor) parts.push(markdown.slice(cursor, match.index))
    parts.push(match[0])
    cursor = match.index + match[0].length
  }
  if (cursor < markdown.length) parts.push(markdown.slice(cursor))
  return parts.length ? parts : ['']
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /(?:^|\s)([:#@]?[-\w]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw))) {
    attributes[match[1]] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return attributes
}

function field(objectText: string, key: string): string | undefined {
  const pattern = new RegExp(`(?:^|[,\\n])\\s*${key}\\s*:\\s*([\\"'])([\\s\\S]*?)\\1`)
  return pattern.exec(objectText)?.[2]
}

function findObjectEnd(source: string, start: number): number {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return index
  }
  return -1
}

export function parseStaticMembers(source: string): Record<string, Member> {
  const members: Record<string, Member> = {}
  const declarationPattern = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g
  let match: RegExpExecArray | null
  while ((match = declarationPattern.exec(source))) {
    const objectStart = declarationPattern.lastIndex - 1
    const objectEnd = findObjectEnd(source, objectStart)
    if (objectEnd < 0) continue
    const id = match[1]
    const body = source.slice(objectStart + 1, objectEnd)
    const name = field(body, 'name')
    if (!name) continue
    const linksBody = /links\s*:\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? ''
    const links = [...linksBody.matchAll(/(?:icon\s*:\s*['"]([^'"]+)['"]\s*,?\s*)?link\s*:\s*['"]([^'"]+)['"]/g)]
      .map((link) => ({ icon: link[1], link: link[2] }))
    members[id] = {
      id,
      name,
      avatar: field(body, 'avatar'),
      title: field(body, 'title'),
      description: field(body, 'desc') ?? field(body, 'description'),
      links
    }
    declarationPattern.lastIndex = objectEnd + 1
  }
  return members
}

function parseSetup(setup: string): { aliases: Record<string, string>; arrays: Record<string, string[]> } {
  const aliases: Record<string, string> = {}
  const arrays: Record<string, string[]> = {}
  for (const match of setup.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]*member_list\/members[^'"]*['"]/g)) {
    for (const name of match[1].split(',').map((item) => item.trim()).filter(Boolean)) {
      const [original, alias] = name.split(/\s+as\s+/)
      aliases[(alias ?? original).trim()] = original.trim()
    }
  }
  for (const match of setup.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([^\]]*)\]/g)) {
    arrays[match[1]] = match[2].split(',').map((item) => item.trim()).filter(Boolean)
  }
  return { aliases, arrays }
}

function findTagEnd(source: string, start: number): number {
  let quote = ''
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === "'" || character === '"') quote = character
    else if (character === '>') return index
  }
  return -1
}

function parseComponentNodes(source: string, start = 0, closingName?: string): { nodes: ComponentChild[]; cursor: number } {
  const nodes: ComponentChild[] = []
  let cursor = start
  while (cursor < source.length) {
    const tagStart = source.indexOf('<', cursor)
    if (tagStart < 0) {
      nodes.push(source.slice(cursor))
      return { nodes, cursor: source.length }
    }
    if (tagStart > cursor) nodes.push(source.slice(cursor, tagStart))

    const closing = source.slice(tagStart).match(/^<\/([A-Za-z][\w-]*)\s*>/)
    if (closing) {
      if (closingName && closing[1] === closingName) {
        return { nodes, cursor: tagStart + closing[0].length }
      }
      nodes.push(closing[0])
      cursor = tagStart + closing[0].length
      continue
    }

    const opening = source.slice(tagStart).match(/^<([A-Z][A-Za-z0-9-]*|template)\b/)
    if (!opening) {
      nodes.push('<')
      cursor = tagStart + 1
      continue
    }
    const end = findTagEnd(source, tagStart + opening[0].length)
    if (end < 0) {
      nodes.push(source.slice(tagStart))
      return { nodes, cursor: source.length }
    }
    const fullTag = source.slice(tagStart, end + 1)
    const name = opening[1]
    const attributes = fullTag.slice(1 + name.length, -1).replace(/\/\s*$/, '')
    const selfClosing = /\/\s*>$/.test(fullTag)
    if (selfClosing) {
      nodes.push({ name, attributes, children: [] })
      cursor = end + 1
      continue
    }
    const childResult = parseComponentNodes(source, end + 1, name)
    nodes.push({ name, attributes, children: childResult.nodes })
    cursor = childResult.cursor
  }
  return { nodes, cursor }
}

function card(member: Member): string {
  const avatar = member.avatar ? `<img class="pyro-member-avatar" src="${escapeHtml(member.avatar)}" alt="${escapeHtml(member.name)}" />` : '<div class="pyro-member-avatar pyro-member-avatar-placeholder"></div>'
  const links = (member.links ?? []).map((link) => `<a href="${escapeHtml(link.link)}" target="_blank" rel="noreferrer">${escapeHtml(link.icon ?? 'link')}</a>`).join(' ')
  return `<article class="pyro-member-card">${avatar}<div><strong>${escapeHtml(member.name)}</strong>${member.title ? `<div class="pyro-member-title">${escapeHtml(member.title)}</div>` : ''}${member.description ? `<p>${escapeHtml(member.description)}</p>` : ''}${links ? `<div class="pyro-member-links">${links}</div>` : ''}</div></article>`
}

function slotName(node: ComponentNode): string | undefined {
  const attrs = parseAttributes(node.attributes)
  const slot = Object.keys(attrs).find((key) => key.startsWith('#'))
  return slot?.slice(1) || undefined
}

function renderChildren(children: ComponentChild[], render: (node: ComponentNode) => string): string {
  return children.map((child) => typeof child === 'string' ? escapeHtml(child) : render(child)).join('')
}

function renderComponent(node: ComponentNode, members: Record<string, Member>, setup: { aliases: Record<string, string>; arrays: Record<string, string[]> }, render: (node: ComponentNode) => string): string {
  const attrs = parseAttributes(node.attributes)
  const children = renderChildren(node.children, render)
  const defaultChildren = renderChildren(node.children.filter((child) => typeof child === 'string' || !slotName(child)), render)
  const slots: Record<string, string> = {}
  for (const child of node.children) {
    if (typeof child === 'string') continue
    const name = slotName(child)
    if (name) slots[name] = renderChildren(child.children, render)
  }

  if (node.name === 'Badge') {
    const type = attrs.type ?? 'tip'
    const text = attrs.text
    if (!text) return '<div class="pyro-preview-error">Badge requires a static text attribute</div>'
    return `<span class="pyro-badge pyro-badge-${escapeHtml(type)}">${escapeHtml(text)}</span>`
  }
  if (node.name === 'AuthorCard') {
    const author = attrs.author
    if (!author) return '<div class="pyro-preview-error">AuthorCard requires a static author attribute</div>'
    const member = Object.values(members).find((item) => item.name === author || item.id === author)
    return member ? `<div class="pyro-author-card">${card(member)}</div>` : `<div class="pyro-preview-error">Unknown author: ${escapeHtml(author)}</div>`
  }
  if (node.name === 'VPTeamMembers') {
    const expression = attrs[':members'] ?? ''
    const names = expression.match(/\[([^\]]*)\]/)?.[1]?.split(',').map((item) => item.trim()).filter(Boolean)
      ?? setup.arrays[expression]?.flatMap((item) => item.split(',').map((value) => value.trim()).filter(Boolean))
      ?? Object.keys(members)
    const resolved = names.map((name) => members[setup.aliases[name] ?? name] ?? members[name]).filter(Boolean)
    if (!resolved.length) return '<div class="pyro-preview-error">VPTeamMembers has no resolvable static members</div>'
    return `<section class="pyro-team-members">${resolved.map(card).join('')}</section>`
  }
  if (node.name === 'VPTeamPage') return `<div class="pyro-team-page">${children}</div>`
  if (node.name === 'VPTeamPageTitle') {
    const title = slots.title ?? defaultChildren
    return `<header class="pyro-team-page-title">${title ? `<h1>${title}</h1>` : ''}</header>`
  }
  if (node.name === 'VPTeamPageSection') {
    const title = slots.title ? `<h2>${slots.title}</h2>` : ''
    const lead = slots.lead ? `<p class="pyro-team-page-lead">${slots.lead}</p>` : ''
    const content = slots.members ?? defaultChildren
    return `<section class="pyro-team-page-section">${title}${lead}<div class="pyro-team-page-content">${content}</div></section>`
  }
  if (node.name === 'template') return children
  if (node.name === 'RecentUpdates') return '<div class="pyro-preview-placeholder">RecentUpdates is available in the VitePress site but has no local data source.</div>'
  return `<div class="pyro-preview-error">Unsupported component: ${escapeHtml(node.name)}</div>`
}

function isBlockComponent(name: string): boolean {
  return name === 'AuthorCard' || name === 'VPTeamPage' || name === 'VPTeamPageTitle' || name === 'VPTeamPageSection' || name === 'VPTeamMembers' || name === 'RecentUpdates'
}

function transformSegment(segment: string, members: Record<string, Member>, setup: { aliases: Record<string, string>; arrays: Record<string, string[]> }, markers: Map<string, string>): string {
  const withoutSetup = segment.replace(/<script\s+setup(?:\s+[^>]*)?>[\s\S]*?<\/script>/gi, '')
  const parsed = parseComponentNodes(withoutSetup)
  const render = (node: ComponentNode): string => renderComponent(node, members, setup, render)
  return parsed.nodes.map((child) => {
    if (typeof child === 'string') return child
    const marker = `${COMPONENT_MARKER}${markers.size}@@`
    markers.set(marker, render(child))
    return isBlockComponent(child.name) ? `\n\n${marker}\n\n` : marker
  }).join('')
}

function transformComponents(markdown: string, members: Record<string, Member>): { transformed: string; markers: Map<string, string> } {
  const source = stripFrontmatter(markdown)
  const setupText = [...source.matchAll(/<script\s+setup(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join('\n')
  const setup = parseSetup(setupText)
  const markers = new Map<string, string>()
  const transformed = splitProtected(source).map((segment) => {
    const first = segment[0]
    return first === '`' || segment.startsWith('```') || segment.startsWith('~~~') ? segment : transformSegment(segment, members, setup, markers)
  }).join('')
  return { transformed, markers }
}

export function preprocessComponents(markdown: string, members: Record<string, Member> = {}): string {
  const { transformed, markers } = transformComponents(markdown, members)
  let result = transformed
  for (const [marker, value] of markers) result = result.split(marker).join(value)
  return result
}

export function installPyroWikiMarkdownIt(md: any, getMembers: () => Record<string, Member>): any {
  md.core.ruler.before('block', 'pyro-wiki-components', (state: any) => {
    state.src = preprocessComponents(state.src, getMembers())
  })
  return md
}

export function renderMarkdown(markdown: string, options: PreviewOptions = {}): string {
  const { transformed, markers } = transformComponents(markdown, options.members ?? {})
  const MarkdownIt = require('markdown-it') as typeof import('markdown-it')
  const md = new (MarkdownIt as any)({ html: false, linkify: true, typographer: true })
  let html = md.render(transformed)
  for (const [marker, value] of markers) html = html.split(marker).join(value)
  return html
}

export function previewDocument(markdown: string, options: PreviewOptions = {}): string {
  const body = renderMarkdown(markdown, options)
  const dark = options.theme === 'dark' ? ' dark' : ''
  const nonce = Math.random().toString(36).slice(2)
  const script = `const vscode=acquireVsCodeApi();let programmatic=false;const scrolling=()=>document.scrollingElement||document.documentElement;const ratio=()=>{const element=scrolling();const max=Math.max(1,element.scrollHeight-window.innerHeight);return Math.max(0,Math.min(1,element.scrollTop/max))};window.addEventListener('scroll',()=>{if(!programmatic)vscode.postMessage({type:'previewScroll',ratio:ratio()})},{passive:true});window.addEventListener('message',event=>{if(event.data?.type==='sourceScroll'){programmatic=true;const element=scrolling();const max=Math.max(1,element.scrollHeight-window.innerHeight);element.scrollTop=Math.max(0,Math.min(1,event.data.ratio))*max;window.setTimeout(()=>{programmatic=false},180)}});window.addEventListener('load',()=>vscode.postMessage({type:'previewReady'}));`
  return `<!doctype html><html class="${dark}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>${previewStyles()}</style></head><body><main class="pyro-preview">${body}</main><script nonce="${nonce}">${script}</script></body></html>`
}

function previewStyles(): string {
  return `:root{color-scheme:light;background:#fff;color:#213547;font-family:var(--vscode-font-family,Inter,system-ui,sans-serif)}html.dark{color-scheme:dark;background:#1b1b1f;color:#ddd}body{margin:0;padding:24px 64px 176px 32px}.pyro-preview{max-width:900px;margin:auto;line-height:1.7}.pyro-preview h1,.pyro-preview h2{line-height:1.25}.pyro-badge{display:inline-block;border-radius:8px;padding:0 8px;font-size:.8em;line-height:1.6;margin:0 3px;border:1px solid transparent}.pyro-badge-tip{color:#3451b2;background:#e8edff;border-color:#b7c4ff}.pyro-badge-info{color:#18794e;background:#e6f6ed;border-color:#a6dfbd}.dark .pyro-badge-tip{color:#c4d0ff;background:#27315f}.dark .pyro-badge-info{color:#a6e3bc;background:#173b28}.pyro-team-page{margin:20px 0}.pyro-team-page-title{margin:28px 0 12px}.pyro-team-page-title h1{margin:0}.pyro-team-page-section{margin:28px 0}.pyro-team-page-section h2{margin:0 0 6px}.pyro-team-page-lead{margin:0 0 16px;color:#666}.dark .pyro-team-page-lead{color:#aaa}.pyro-team-page-content{margin-top:12px}.pyro-team-members{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:20px 0}.pyro-member-card,.pyro-author-card{display:flex;gap:14px;align-items:flex-start;padding:16px;border:1px solid #e2e2e3;border-radius:12px;background:#fff;box-shadow:0 2px 8px #0000000d}.dark .pyro-member-card,.dark .pyro-author-card{border-color:#3b3b43;background:#242429}.pyro-author-card .pyro-member-card{border:0;padding:0;box-shadow:none;background:transparent}.pyro-member-avatar{width:52px;height:52px;border-radius:50%;object-fit:cover;flex:0 0 auto;background:#ddd}.pyro-member-avatar-placeholder{background:linear-gradient(135deg,#42d392,#647eff)}.pyro-member-title,.pyro-member-card p{font-size:.86em;color:#777;margin:2px 0}.dark .pyro-member-title,.dark .pyro-member-card p{color:#aaa}.pyro-member-links{font-size:.8em;display:flex;gap:8px}.pyro-preview-error,.pyro-preview-placeholder{color:#b42318;background:#fff1f0;border:1px solid #f5b5af;border-radius:6px;padding:8px;margin:8px 0}.pyro-preview-placeholder{color:#8a5a00;background:#fff8df;border-color:#e4c76a}.dark .pyro-preview-error,.dark .pyro-preview-placeholder{color:#ffb4ab;background:#4c1d1a;border-color:#8c3028}.dark .pyro-preview-placeholder{color:#f3d27a;background:#4a3b16;border-color:#806a2e}pre{overflow:auto;padding:14px;border-radius:8px;background:#f6f6f7}.dark pre{background:#26262c}code{font-family:var(--vscode-editor-font-family,ui-monospace,monospace)}`
}

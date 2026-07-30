import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import MarkdownIt from 'markdown-it'
import { installPyroWikiMarkdownIt, parseStaticMembers, previewDocument, renderMarkdown } from '../src/preview/parser'

function docsRoot(): string {
  const candidates = [
    process.env.PYRO_WIKI_DOCS_ROOT,
    resolve(__dirname, '../../../'),
    resolve(__dirname, '../../../../PYRo-Wiki')
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, '.vitepress')) && existsSync(resolve(candidate, 'package.json'))) return candidate
  }
  throw new Error('Could not locate the PYRo Wiki documentation workspace.')
}

const membersSource = `export const mem1 = { avatar: 'https://example.com/a.png', name: 'Lucky', title: 'Lead', desc: 'Robot', links: [{ icon: 'github', link: 'https://github.com/lucky' }] }\nexport const mem2 = { name: 'MekCraftLi', title: 'Engineer' }`

describe('safe preview parser', () => {
  it('renders supported components and static member arrays', () => {
    const members = parseStaticMembers(membersSource)
    const html = renderMarkdown(`<script setup>\nimport { mem1, mem2 } from '../../../public/member_list/members'\nconst core = [mem1, mem2]\n</script>\n# Preview\n\nVersion<Badge type="tip" text="1.0.0"/>\n\nFile<Badge type="info" text="a.h"/><Badge type="info" text="b.cpp"/>\n\n<VPTeamMembers size="small" :members="[mem1, mem2]" />\n\n<AuthorCard author="Lucky" />`, { members })
    expect(html).toContain('1.0.0')
    expect(html).toContain('a.h')
    expect(html).toContain('Lucky')
    expect(html).toContain('MekCraftLi')
    expect(html).not.toContain('script setup')
  })

  it('accepts VitePress spacing and renders the exact Wiki component syntax', () => {
    const members = parseStaticMembers(membersSource)
    const html = renderMarkdown(`Version<Badge type ="tip" text="1.0.0"/>\nFile<Badge type = "info" text="pyro_mutex.h"/><Badge type = "info" text="pyro_mutex.cpp"/>\n\n<script setup>\nimport { mem1 } from '../../../public/member_list/members'\n</script>\n<VPTeamMembers size="small" :members="[mem1]" />`, { members })
    expect(html).toContain('pyro_mutex.h')
    expect(html).toContain('pyro_mutex.cpp')
    expect(html).toContain('Lucky')
    expect(html).toContain('pyro-team-members')
  })

  it('works as a VS Code native Markdown-it plugin', () => {
    const members = parseStaticMembers(membersSource)
    const md = new (MarkdownIt as any)({ html: true })
    installPyroWikiMarkdownIt(md, () => members)
    const html = md.render(`Version<Badge type ="tip" text="1.0.0"/>\n<script setup>\nimport { mem1 } from '../../../public/member_list/members'\n</script>\n<VPTeamMembers size="small" :members="[mem1]" />`)
    expect(html).toContain('pyro-badge-tip')
    expect(html).toContain('Lucky')
    expect(html).toContain('pyro-team-members')
  })

  it('resolves a static array variable used by VPTeamMembers', () => {
    const members = parseStaticMembers(membersSource)
    const html = renderMarkdown(`<script setup>\nimport { mem2 } from '../../../public/member_list/members'\nconst author = [\n  mem2,\n]\n</script>\n<VPTeamMembers size="small" :members="author" />`, { members })
    expect(html).toContain('MekCraftLi')
    expect(html).not.toContain('Lucky')
  })

  it('strips VitePress frontmatter and renders nested team-page slots', () => {
    const members = parseStaticMembers(membersSource)
    const html = renderMarkdown(`---\ntoc: true\nlayout: page\n---\n\n<VPTeamPage>\n  <VPTeamPageTitle>\n    <template #title>北洋机甲管理人员</template>\n  </VPTeamPageTitle>\n  <VPTeamPageSection>\n    <template #title>现役队员</template>\n    <template #lead>本赛季在队的主力队员</template>\n    <template #members>\n      <VPTeamMembers size="small" :members="[mem1, mem2]" />\n    </template>\n  </VPTeamPageSection>\n</VPTeamPage>`, { members })
    expect(html).toContain('北洋机甲管理人员')
    expect(html).toContain('现役队员')
    expect(html).toContain('本赛季在队的主力队员')
    expect(html).toContain('Lucky')
    expect(html).toContain('MekCraftLi')
    expect(html).not.toContain('toc: true')
    expect(html).not.toContain('layout: page')
    expect(html).not.toContain('&lt;template')
  })

  it('renders the checked-in administrator page without leaking frontmatter or Vue tags', () => {
    const membersSource = readFileSync(resolve(docsRoot(), 'public/member_list/members.ts'), 'utf8')
    const document = readFileSync(resolve(docsRoot(), 'about_us/administrator_list.md'), 'utf8')
    const html = renderMarkdown(document, { members: parseStaticMembers(membersSource) })
    expect(html).not.toContain('layout: page')
    expect(html).not.toContain('&lt;VPTeamPage')
    expect(html).not.toContain('&lt;template')
    expect(html).toContain('pyro-team-page')
    expect(html).toContain('pyro-team-members')
  })

  it('does not render components inside fenced or inline code', () => {
    const html = renderMarkdown(`<script setup>throw new Error('must not execute')</script>\n\n\`<Badge type="tip" text="inline"/>\`\n\n\`\`\`vue\n<Badge type="tip" text="not-rendered"/>\n<AuthorCard author="not-rendered"/>\n\`\`\``)
    expect(html).toContain('&lt;Badge')
    expect(html).toContain('inline')
    expect(html).toContain('not-rendered')
    expect(html).not.toContain('pyro-badge')
  })

  it('reports unknown and invalid components', () => {
    const html = renderMarkdown('<UnknownThing />\n<Badge />')
    expect(html).toContain('Unsupported component')
    expect(html).toContain('Badge requires a static text')
  })

  it('escapes component attributes', () => {
    const html = renderMarkdown('<Badge type="tip" text="&lt;script&gt;" />')
    expect(html).not.toContain('<script>')
  })
})

describe('preview document shell', () => {
  it('contains dark theme, a restrictive CSP, and bidirectional scroll hooks', () => {
    const html = previewDocument('# title', { theme: 'dark' })
    expect(html).toContain('<html class=" dark">')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('previewScroll')
    expect(html).toContain('sourceScroll')
    expect(html).toContain('script-src')
  })
})

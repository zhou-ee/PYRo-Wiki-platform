import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => {
  class Range {
    constructor(public startLine: number, public startCharacter: number, public endLine: number, public endCharacter: number) {}
  }
  class CompletionItem {
    detail?: string
    filterText?: string
    range?: Range
    insertText: unknown
    command?: unknown
    constructor(public label: string, public kind: number) {}
  }
  class SnippetString {
    constructor(public value: string) {}
  }
  return {
    CompletionItem,
    CompletionItemKind: { Keyword: 1, Reference: 2 },
    Range,
    SnippetString
  }
})

vi.mock('../src/workspace', () => ({ isWikiDocument: () => true }))

import { PyroCompletionProvider } from '../src/completion'

const member = { id: 'alice', name: 'Alice', title: 'Maintainer' }

function documentWith(line: string): any {
  return {
    lineAt: () => ({ text: line }),
  }
}

describe('author completion', () => {
  it('turns /author plus a name query into a complete AuthorCard', () => {
    const provider = new PyroCompletionProvider(() => ({ alice: member }))
    const items = provider.provideCompletionItems(documentWith('/author Ali'), { line: 0, character: 10 } as any)
    expect(items).toHaveLength(1)
    expect(items[0].insertText).toBe('<AuthorCard author="Alice" />')
  })

  it('reopens author suggestions after selecting /author', () => {
    const provider = new PyroCompletionProvider(() => ({ alice: member }))
    const items = provider.provideCompletionItems(documentWith('/author'), { line: 0, character: 7 } as any)
    const author = items.find((item) => item.label === '/author') as any
    expect(author).toBeDefined()
    expect(author.insertText.value).toBe('<AuthorCard author="${1}" />')
    expect(author.command).toEqual({ command: 'editor.action.triggerSuggest', title: 'Select PYRo Wiki author' })
  })

  it('completes an author inside an existing AuthorCard tag', () => {
    const provider = new PyroCompletionProvider(() => ({ alice: member }))
    const items = provider.provideCompletionItems(documentWith('<AuthorCard author="Ali'), { line: 0, character: 25 } as any)
    expect(items).toHaveLength(1)
    expect(items[0].insertText).toBe('Alice')
  })
})


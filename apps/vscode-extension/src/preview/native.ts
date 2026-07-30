import { installPyroWikiMarkdownIt, Member } from './parser'

export function extendMarkdownIt(md: any, getMembers: () => Record<string, Member>): any {
  return installPyroWikiMarkdownIt(md, getMembers)
}

import * as vscode from 'vscode'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { Member, parseStaticMembers } from './parser'

export async function loadMembers(workspaceRoot: string | undefined, context: vscode.ExtensionContext): Promise<Record<string, Member>> {
  const candidates = workspaceRoot ? [
    path.join(workspaceRoot, 'public', 'member_list', 'members.ts'),
    path.join(workspaceRoot, 'member_list', 'members.ts')
  ] : []
  for (const candidate of candidates) {
    try {
      const source = await fs.readFile(candidate, 'utf8')
      const members = parseStaticMembers(source)
      if (Object.keys(members).length) {
        await context.globalState.update('pyroWiki.membersCache', members)
        await context.globalState.update('pyroWiki.membersCacheAt', Date.now())
        return members
      }
    } catch { /* use cache/fallback */ }
  }
  return context.globalState.get<Record<string, Member>>('pyroWiki.membersCache', {})
}

export function workspaceRootFor(document: vscode.TextDocument): string | undefined {
  return vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
}

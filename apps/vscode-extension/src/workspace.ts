import * as vscode from 'vscode'
import * as path from 'node:path'

export function workspaceRoot(document: vscode.TextDocument | undefined): string | undefined {
  if (!document) return undefined
  return vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
}

export function configuredWikiRoot(document: vscode.TextDocument): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)
  if (!folder) return undefined
  const configured = vscode.workspace.getConfiguration('pyroWiki', folder.uri).get<string>('wikiRoot', '').trim()
  if (!configured) return folder.uri.fsPath
  return path.isAbsolute(configured) ? path.normalize(configured) : path.normalize(path.join(folder.uri.fsPath, configured))
}

export function isWikiDocument(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file' || document.languageId !== 'markdown') return false
  const root = configuredWikiRoot(document)
  if (!root) return false
  const file = path.normalize(document.uri.fsPath)
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export async function selectWikiRoot(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) {
    void vscode.window.showWarningMessage('Open a workspace before selecting a PYRo Wiki root.')
    return
  }
  const selected = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use as PYRo Wiki root' })
  if (!selected?.[0]) return
  const relative = path.relative(folder.uri.fsPath, selected[0].fsPath)
  const value = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : selected[0].fsPath
  await vscode.workspace.getConfiguration('pyroWiki', folder.uri).update('wikiRoot', value, vscode.ConfigurationTarget.Workspace)
  void vscode.window.showInformationMessage(`PYRo Wiki root set to ${value || '.'}`)
}

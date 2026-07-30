import type * as vscode from 'vscode'

const suppressed = new Set<string>()

export function suppressNextDraftSave(document: vscode.TextDocument): void {
  suppressed.add(document.uri.toString())
}

export function consumeSuppressedDraftSave(document: vscode.TextDocument): boolean {
  return suppressed.delete(document.uri.toString())
}

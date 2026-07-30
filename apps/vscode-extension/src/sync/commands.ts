import * as vscode from 'vscode'
import * as path from 'node:path'
import { ApiClient, ApiError, type ConflictResponse } from './api'
import { enqueueSync, pendingSyncItems, removeSync } from './queue'
import { suppressNextDraftSave } from './autoSave'
import type { AuthManager } from '../auth/session'
import { isWikiDocument, workspaceRoot } from '../workspace'
import { mergeThreeWay } from './merge'

const DEFAULT_API_BASE_URL = 'https://pyro-wiki-api.luckyy.ccwu.cc'

export function makeClient(document: vscode.TextDocument, auth?: AuthManager): ApiClient | undefined {
  const root = workspaceRoot(document)
  if (!root) return undefined
  const baseUrl = vscode.workspace.getConfiguration('pyroWiki').get<string>('apiBaseUrl', DEFAULT_API_BASE_URL)
  const workspaceId = path.basename(root).replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase() || 'default'
  return new ApiClient(baseUrl, workspaceId, auth)
}

export function documentPath(document: vscode.TextDocument): string {
  return path.relative(workspaceRoot(document)!, document.uri.fsPath).replaceAll('\\', '/')
}

function revisionKey(document: vscode.TextDocument): string { return `pyroWiki.revision.${document.uri.toString()}` }
function isTransient(error: unknown): boolean {
  const status = error instanceof ApiError ? error.status : (error as { status?: number }).status
  return status === undefined || status === 408 || status === 429 || (status !== undefined && status >= 500)
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

async function replaceDocument(document: vscode.TextDocument, content: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit()
  const endLine = Math.max(0, document.lineCount - 1)
  edit.replace(document.uri, new vscode.Range(0, 0, endLine, document.lineAt(endLine).text.length), content)
  await vscode.workspace.applyEdit(edit)
}

async function resolveConflict(context: vscode.ExtensionContext, document: vscode.TextDocument, client: ApiClient, conflict: ConflictResponse): Promise<void> {
  const remote = conflict.remote
  const common = conflict.common
  const choice = await vscode.window.showQuickPick([
    { label: 'Keep local and push again', value: 'local', description: `Use remote revision ${remote.revision} as the new base.` },
    { label: 'Keep remote', value: 'remote', description: 'Replace the local file with the current cloud version.' },
    { label: 'Open three-way comparison', value: 'manual', description: 'Review common ancestor, local content and remote content.' },
    { label: 'Cancel', value: 'cancel' }
  ], { placeHolder: 'Resolve the cloud document conflict' })
  if (!choice || choice.value === 'cancel') return
  await context.workspaceState.update(revisionKey(document), remote.revision)
  if (choice.value === 'remote') {
    await replaceDocument(document, remote.content ?? '')
    suppressNextDraftSave(document)
  await document.save()
    void vscode.window.showInformationMessage(`Kept cloud revision ${remote.revision}.`)
    return
  }
  if (choice.value === 'local') {
    try {
      const result = await client.putDocument(documentPath(document), document.getText(), remote.revision)
      await context.workspaceState.update(revisionKey(document), result.revision)
      void vscode.window.showInformationMessage(`Uploaded merged local revision ${result.revision}.`)
    } catch (error) {
      void vscode.window.showWarningMessage(`The document changed again; review the conflict once more. ${errorMessage(error)}`)
    }
    return
  }
  if (!common) {
    const conflictChoice = await vscode.window.showWarningMessage('No common cloud ancestor is available. Apply explicit conflict markers to the local file for manual resolution?', { modal: true }, 'Apply conflict markers')
    if (conflictChoice !== 'Apply conflict markers') return
    await replaceDocument(document, mergeThreeWay('', conflict.local.content, remote.content ?? '').content)
    suppressNextDraftSave(document)
  await document.save()
    void vscode.window.showWarningMessage(`Conflict markers were inserted into ${document.fileName}. Resolve them, then Push using cloud revision ${remote.revision} as the base.`)
    return
  }

  const merged = mergeThreeWay(common.content, conflict.local.content, remote.content ?? '')
  if (merged.conflicts === 0) {
    const mergeChoice = await vscode.window.showInformationMessage('The local and remote changes can be merged automatically.', 'Apply and push', 'Apply only', 'Cancel')
    if (mergeChoice === 'Cancel' || !mergeChoice) return
    await replaceDocument(document, merged.content)
    suppressNextDraftSave(document)
  await document.save()
    await context.workspaceState.update(revisionKey(document), remote.revision)
    if (mergeChoice === 'Apply only') {
      void vscode.window.showInformationMessage(`Applied the merged content locally. Cloud revision ${remote.revision} is now the push base.`)
      return
    }
    try {
      const result = await client.putDocument(documentPath(document), merged.content, remote.revision)
      await context.workspaceState.update(revisionKey(document), result.revision)
      void vscode.window.showInformationMessage(`Merged and uploaded revision ${result.revision}.`)
    } catch (error) {
      void vscode.window.showWarningMessage(`The cloud document changed again; review the conflict once more. ${errorMessage(error)}`)
    }
    return
  }

  const conflictChoice = await vscode.window.showWarningMessage(`The three-way merge contains ${merged.conflicts} conflict${merged.conflicts === 1 ? '' : 's'}. Apply conflict markers to the local file?`, { modal: true }, 'Apply conflict markers')
  if (conflictChoice !== 'Apply conflict markers') return
  await replaceDocument(document, merged.content)
  suppressNextDraftSave(document)
  await document.save()
  await context.workspaceState.update(revisionKey(document), remote.revision)
  void vscode.window.showWarningMessage(`Applied ${merged.conflicts} conflict marker${merged.conflicts === 1 ? '' : 's'} to ${document.fileName}. Resolve them, then Push using cloud revision ${remote.revision} as the base.`)
}

export async function pushCurrent(context: vscode.ExtensionContext, auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Current document is outside the PYRo Wiki root.')
  const client = makeClient(document, auth)
  if (!client) return
  const baseRevision = context.workspaceState.get<number>(revisionKey(document), 0)
  try {
    const result = await client.putDocument(documentPath(document), document.getText(), baseRevision)
    await context.workspaceState.update(revisionKey(document), result.revision)
    void vscode.window.showInformationMessage(`Uploaded revision ${result.revision}.`)
  } catch (error) {
    if ((error as { status?: number }).status === 409) {
      const body = (error instanceof ApiError ? error.body : (error as { body?: unknown }).body) as Partial<ConflictResponse> | undefined
      if (body?.remote) await resolveConflict(context, document, client, body as ConflictResponse)
      else void vscode.window.showWarningMessage('Remote document changed. Pull the latest version before pushing again.')
    } else if ((error as { status?: number }).status === 401) {
      void vscode.window.showWarningMessage('Sign in with Feishu before pushing a document.')
    } else if (isTransient(error)) {
      await enqueueSync(context, { uri: document.uri.toString(), path: documentPath(document), workspaceId: path.basename(workspaceRoot(document)!).replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase() || 'default', content: document.getText(), baseRevision })
      void vscode.window.showWarningMessage('Network unavailable. The document was added to the PYRo Wiki sync queue.')
    } else void vscode.window.showErrorMessage(`PYRo Wiki upload failed: ${errorMessage(error)}`)
  }
}

export async function retryQueued(context: vscode.ExtensionContext, auth: AuthManager, silent = false): Promise<void> {
  const queued = await pendingSyncItems(context)
  if (!queued.length) {
    if (!silent) void vscode.window.showInformationMessage('PYRo Wiki sync queue is empty.')
    return
  }
  let uploaded = 0
  for (const item of queued) {
    let document: vscode.TextDocument
    try { document = await vscode.workspace.openTextDocument(vscode.Uri.parse(item.uri)) }
    catch { await removeSync(context, item.id); continue }
    const client = makeClient(document, auth)
    if (!client) continue
    try {
      const result = item.kind === 'draft'
        ? await client.saveDraft(item.path, item.content, item.baseRevision)
        : await client.putDocument(item.path, item.content, item.baseRevision)
      await context.workspaceState.update(revisionKey(document), result.revision)
      await removeSync(context, item.id)
      uploaded += 1
    } catch (error) {
      if ((error as { status?: number }).status === 401) {
        if (!silent) void vscode.window.showWarningMessage('Sign in with Feishu before retrying the sync queue.')
        return
      }
      if ((error as { status?: number }).status === 409) {
        if (!silent) void vscode.window.showWarningMessage(`Queued document ${item.path} has a cloud conflict. Open it and resolve the conflict manually.`)
      }
      else if (!isTransient(error)) await removeSync(context, item.id)
      break
    }
  }
  if (uploaded && !silent) void vscode.window.showInformationMessage(`Uploaded ${uploaded} queued document${uploaded === 1 ? '' : 's'}.`)
}

export async function pullCurrent(context: vscode.ExtensionContext, auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Current document is outside the PYRo Wiki root.')
  const client = makeClient(document, auth)
  if (!client) return
  try {
    const remote = await client.getDocument(documentPath(document))
    await replaceDocument(document, remote.content ?? '')
    suppressNextDraftSave(document)
  await document.save()
    await context.workspaceState.update(revisionKey(document), remote.revision)
    void vscode.window.showInformationMessage(`Pulled revision ${remote.revision}.`)
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 401) void vscode.window.showWarningMessage('Sign in with Feishu before pulling a document.')
    else if (status === 404) {
      const choice = await vscode.window.showWarningMessage(`Cloud document ${documentPath(document)} does not exist yet. Upload the current local content as a new cloud document?`, 'Push as new cloud document')
      if (choice !== 'Push as new cloud document') return
      try {
        const result = await client.putDocument(documentPath(document), document.getText(), 0)
        await context.workspaceState.update(revisionKey(document), result.revision)
        void vscode.window.showInformationMessage(`Created cloud document ${documentPath(document)} at revision ${result.revision}.`)
      } catch (pushError) {
        void vscode.window.showErrorMessage(`Could not create cloud document: ${errorMessage(pushError)}`)
      }
    } else if (isTransient(error)) void vscode.window.showWarningMessage('PYRo Wiki is temporarily unreachable. Try Pull again when the network is available.')
    else void vscode.window.showErrorMessage(`PYRo Wiki pull failed: ${errorMessage(error)}`)
  }
}

export async function saveDraftCurrent(context: vscode.ExtensionContext, auth: AuthManager, document = vscode.window.activeTextEditor?.document, options: { silent?: boolean } = {}): Promise<number | undefined> {
  if (!document || !isWikiDocument(document)) {
    if (!options.silent) void vscode.window.showWarningMessage('Current document is outside the PYRo Wiki root.')
    return undefined
  }
  const client = makeClient(document, auth)
  if (!client) return undefined
  const baseRevision = context.workspaceState.get<number>(revisionKey(document), 0)
  try {
    const result = await client.saveDraft(documentPath(document), document.getText(), baseRevision)
    await context.workspaceState.update(revisionKey(document), result.revision)
    if (!options.silent) void vscode.window.showInformationMessage(`Saved cloud draft revision ${result.revision}.`)
    return result.revision
  } catch (error) {
    if ((error as { status?: number }).status === 401) {
      if (!options.silent) void vscode.window.showWarningMessage('Sign in with Feishu before saving a cloud draft.')
    } else if (isTransient(error)) {
      await enqueueSync(context, { uri: document.uri.toString(), path: documentPath(document), workspaceId: path.basename(workspaceRoot(document)!).replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase() || 'default', content: document.getText(), baseRevision, kind: 'draft' })
      if (!options.silent) void vscode.window.showWarningMessage('PYRo Wiki is temporarily unreachable. The draft was added to the sync queue.')
    } else if (!options.silent) {
      void vscode.window.showErrorMessage(`PYRo Wiki draft save failed: ${errorMessage(error)}`)
    }
    return undefined
  }
}

export async function viewCurrentRevisions(auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Current document is outside the PYRo Wiki root.')
  const client = makeClient(document, auth)
  if (!client) return
  try {
    const revisions = (await client.revisions(documentPath(document))).revisions
    if (!revisions.length) return void vscode.window.showInformationMessage('This document has no cloud revisions yet.')
    const picked = await vscode.window.showQuickPick(revisions.map((revision) => ({
      label: `Revision ${revision.revision}`,
      description: revision.updatedAt,
      revision
    })), { placeHolder: `Select a cloud revision of ${document.fileName}` })
    if (!picked) return
    const remote = await vscode.workspace.openTextDocument({ content: picked.revision.content, language: 'markdown' })
    await vscode.commands.executeCommand('vscode.diff', document.uri, remote.uri, `PYRo: ${document.fileName} revision ${picked.revision.revision}`)
  } catch (error) {
    if ((error as { status?: number }).status === 401) void vscode.window.showWarningMessage('Sign in with Feishu before viewing cloud revisions.')
    else void vscode.window.showErrorMessage(`Could not load cloud revisions: ${errorMessage(error)}`)
  }
}

export async function createWorkspacePublishBatch(auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Open a Markdown document inside the PYRo Wiki workspace first.')
  const client = makeClient(document, auth)
  if (!client) return
  try {
    const checkpoint = await client.checkpointWorkspace(true)
    const result = await client.createWorkspacePublishBatch()
    void vscode.window.showInformationMessage(`Workspace publish batch created for the complete workspace (${checkpoint.manifestCount} Markdown documents; ${checkpoint.changedCount} changed): ${result.batch.id}`)
  } catch (error) { void vscode.window.showErrorMessage(`Could not create workspace publish batch: ${errorMessage(error)}`) }
}

export async function approveWorkspacePublishBatch(auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Open a Markdown document inside the PYRo Wiki workspace first.')
  const client = makeClient(document, auth)
  if (!client) return
  try {
    const checkpoint = await client.checkpointWorkspace()
    const batches = await client.workspacePublishBatches()
    const eligible = batches.batches.filter((batch) => ['submitted', 'failed'].includes(batch.status))
    const automatedApproval = vscode.workspace.getConfiguration('pyroWiki', document.uri).get<boolean>('automationApproval', false)
    let batch = eligible[0]
    if (eligible.length > 1 && !automatedApproval) {
      const selected = await vscode.window.showQuickPick(eligible.map((candidate) => ({ label: `${candidate.status}: ${candidate.id}`, description: candidate.createdAt, candidate })), { placeHolder: 'Select an incremental workspace publish batch' })
      if (!selected) return
      batch = selected.candidate
    }
    if (!batch) {
      if (!checkpoint.manifestCount && !(checkpoint.changedCount ?? 0)) return void vscode.window.showWarningMessage('No unpublished Markdown changes have reached the cloud checkpoint yet. Keep the workspace connected, make sure the active workspace is correct, and try again after synchronization completes.')
      batch = (await client.createWorkspacePublishBatch()).batch
    }
    if (!automatedApproval) {
      const changedCount = batch.changedCount ?? checkpoint.changedCount ?? checkpoint.manifestCount
      const confirmation = await vscode.window.showWarningMessage(`Approve the workspace incrementally (${changedCount} changed Markdown document${changedCount === 1 ? '' : 's'}; ${checkpoint.manifestCount} total in workspace)?`, { modal: true }, 'Approve Changed Files')
      if (confirmation !== 'Approve Changed Files') return
    }
    const message = automatedApproval ? 'Codex-authorized duplicate-content cleanup publish' : await vscode.window.showInputBox({ prompt: 'Optional approval message', ignoreFocusOut: true })
    let result = await client.approveWorkspacePublishBatch(batch.id, message)
    if (result.batch.status === 'publishing') {
      for (let attempt = 0; attempt < 30 && result.batch.status === 'publishing'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        result = await client.getWorkspacePublishBatch(batch.id)
      }
    }
    void vscode.window.showInformationMessage(`Workspace publish batch ${result.batch.status}: ${result.batch.id}`)
  } catch (error) { void vscode.window.showErrorMessage(`Could not approve workspace publish batch: ${errorMessage(error)}`) }
}

export async function rejectWorkspacePublishBatch(auth: AuthManager, document = vscode.window.activeTextEditor?.document): Promise<void> {
  if (!document || !isWikiDocument(document)) return void vscode.window.showWarningMessage('Open a Markdown document inside the PYRo Wiki workspace first.')
  const client = makeClient(document, auth)
  if (!client) return
  try {
    const batches = await client.workspacePublishBatches()
    const selected = await vscode.window.showQuickPick(batches.batches.filter((batch) => batch.status === 'submitted').map((batch) => ({ label: `${batch.status}: ${batch.id}`, description: batch.createdAt, batch })), { placeHolder: 'Select a workspace publish batch' })
    if (!selected) return
    const message = await vscode.window.showInputBox({ prompt: 'Rejection reason', ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : 'A rejection reason is required' })
    if (message === undefined) return
    const result = await client.rejectWorkspacePublishBatch(selected.batch.id, message)
    void vscode.window.showInformationMessage(`Workspace publish batch ${result.batch.status}: ${result.batch.id}`)
  } catch (error) { void vscode.window.showErrorMessage(`Could not reject workspace publish batch: ${errorMessage(error)}`) }
}

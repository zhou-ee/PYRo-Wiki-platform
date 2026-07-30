import { suppressNextDraftSave } from '../sync/autoSave'
﻿import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { VitePressPreviewServer } from './vitepress'
import { configuredWikiRoot, isWikiDocument } from '../workspace'

interface PreviewMessage {
  type?: string
  ratio?: number
  pageKey?: string
  hash?: string
  activeHeading?: string
  atBottom?: boolean
}

interface PersistedPreviewState {
  documentUri: string
}

export class PreviewController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined
  private readonly disposables: vscode.Disposable[] = []
  private currentDocument: vscode.TextDocument | undefined
  private sourceEditor: vscode.TextEditor | undefined
  private movingSource = false
  private suppressSourceScroll = false
  private suppressSourceScrollTimer: NodeJS.Timeout | undefined
  private pendingRenderTimer: NodeJS.Timeout | undefined
  private renderGeneration = 0
  private renderQueue: Promise<void> = Promise.resolve()
  private readonly vitePress = new VitePressPreviewServer()
  private readonly previewStateKey = 'pyroWiki.previewState'
  private webviewInitialized = false
  private currentPreviewUrl: string | undefined

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.panel && this.currentDocument?.uri.toString() === event.document.uri.toString()) this.scheduleDocumentRender(event.document)
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (this.panel && editor?.document) void this.followEditor(editor)
        else if (editor?.document?.languageId === 'markdown') void this.warmup(editor.document)
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        if (this.panel && this.currentDocument && event.textEditor.document.uri.toString() === this.currentDocument.uri.toString()) this.sendSourceScroll(event.textEditor)
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (this.panel && this.currentDocument) void this.queueRender(this.currentDocument, true)
      }),
      vscode.window.registerWebviewPanelSerializer('pyroWikiPreview', {
        deserializeWebviewPanel: async (panel, state) => this.restorePanel(panel, state)
      })
    )
  }

  private get lockLayout(): boolean {
    return vscode.workspace.getConfiguration('pyroWiki').get<boolean>('lockPreviewLayout', true)
  }

  private get followActiveMarkdown(): boolean {
    return vscode.workspace.getConfiguration('pyroWiki').get<boolean>('followActiveMarkdown', true)
  }

  private get syncUnsavedPreview(): boolean {
    return vscode.workspace.getConfiguration('pyroWiki').get<boolean>('syncUnsavedPreview', true)
  }

  private attachPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel
    this.webviewInitialized = false
    this.currentPreviewUrl = undefined
    panel.webview.options = { enableScripts: true }
    panel.webview.html = this.vitePress.loadingDocument(panel.webview.cspSource)
    this.disposables.push(panel.webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message)))
    panel.onDidDispose(() => {
      if (this.panel !== panel) return
      this.panel = undefined
      this.currentDocument = undefined
      this.sourceEditor = undefined
      this.currentPreviewUrl = undefined
      this.webviewInitialized = false
      void this.context.workspaceState.update(this.previewStateKey, undefined)
      if (this.pendingRenderTimer) clearTimeout(this.pendingRenderTimer)
      if (this.suppressSourceScrollTimer) clearTimeout(this.suppressSourceScrollTimer)
      void this.vitePress.disposeAsync()
    }, null, this.disposables)
  }

  private async restorePanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    this.attachPanel(panel)
    const stateDocumentUri = typeof state === 'object' && state !== null && 'documentUri' in state
      ? (state as { documentUri?: unknown }).documentUri
      : undefined
    const persisted = this.context.workspaceState.get<PersistedPreviewState>(this.previewStateKey)
    const documentUri = typeof stateDocumentUri === 'string'
      ? stateDocumentUri
      : persisted?.documentUri
    if (!documentUri) return

    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(documentUri))
      if (!isWikiDocument(document)) throw new Error('The restored Markdown document is outside the configured PYRo Wiki root.')
      const editor = await this.showSourceLeft(document, true)
      await this.setDocument(document, editor)
      panel.reveal(vscode.ViewColumn.Two, true)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await this.context.workspaceState.update(this.previewStateKey, undefined)
      panel.webview.html = `<!doctype html><html><body><h2>PYRo Wiki preview could not be restored</h2><pre>${escapeHtml(detail)}</pre></body></html>`
      void vscode.window.showWarningMessage(`PYRo Wiki preview could not be restored: ${detail}`)
    }
  }

  private async persistPreviewState(document: vscode.TextDocument): Promise<void> {
    await this.context.workspaceState.update(this.previewStateKey, { documentUri: document.uri.toString() } satisfies PersistedPreviewState)
  }

  /** Start VitePress before the user opens the panel when a Markdown editor is already active. */
  async warmup(document = vscode.window.activeTextEditor?.document): Promise<void> {
    if (!document || !isWikiDocument(document)) return
    const root = configuredWikiRoot(document)
    if (!root) return
    try {
      await this.vitePress.start(root)
    } catch {
      // Keep warmup best-effort. The normal render path reports actionable errors.
    }
  }

  private async showSourceLeft(document: vscode.TextDocument, preserveFocus: boolean): Promise<vscode.TextEditor> {
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus,
      preview: false
    })
    await this.closeDuplicateSourceTabs(document.uri, editor)
    return editor
  }

  private async closeDuplicateSourceTabs(uri: vscode.Uri, keep: vscode.TextEditor): Promise<void> {
    const duplicates: vscode.Tab[] = []
    for (const group of vscode.window.tabGroups.all) {
      if (group.viewColumn === vscode.ViewColumn.One) continue
      for (const tab of group.tabs) {
        const input = tab.input
        const isSource = input instanceof vscode.TabInputText && input.uri.toString() === uri.toString()
        const isNativeMarkdownPreview = input instanceof vscode.TabInputWebview && /markdown\.preview|vscode\.markdown\.preview/i.test(input.viewType)
        if (isSource || isNativeMarkdownPreview) duplicates.push(tab)
      }
    }
    if (duplicates.length) await vscode.window.tabGroups.close(duplicates, true)
    this.sourceEditor = keep
  }

  private scheduleDocumentRender(document: vscode.TextDocument): void {
    if (this.pendingRenderTimer) clearTimeout(this.pendingRenderTimer)
    this.pendingRenderTimer = setTimeout(() => {
      this.pendingRenderTimer = undefined
      // Vite's HMR updates the current Vue page in place. Do not replace the iframe
      // on every keystroke, otherwise the page flashes blank and loses its scroll.
      void this.queueRender(document, false)
    }, 180)
  }

  private queueRender(document: vscode.TextDocument, reload = false): Promise<void> {
    if (this.pendingRenderTimer) {
      clearTimeout(this.pendingRenderTimer)
      this.pendingRenderTimer = undefined
    }
    const generation = ++this.renderGeneration
    const task = this.renderQueue.then(async () => {
      if (generation !== this.renderGeneration || !this.panel) return
      await this.render(document, reload, generation)
    })
    this.renderQueue = task.catch(() => undefined)
    return task
  }

  private async setDocument(document: vscode.TextDocument, editor?: vscode.TextEditor): Promise<void> {
    this.currentDocument = document
    this.sourceEditor = editor ?? this.sourceEditor
    // Persist before starting the potentially slow server so an immediate
    // window reload can still recover the document being previewed.
    void this.persistPreviewState(document)
    await this.queueRender(document)
    if (this.sourceEditor) this.sendSourceScroll(this.sourceEditor)
  }

  private async followEditor(editor: vscode.TextEditor): Promise<void> {
    if (!this.panel || !this.followActiveMarkdown || !isWikiDocument(editor.document)) {
      if (this.panel && editor?.document) void this.queueRender(editor.document)
      return
    }
    let sourceEditor = editor
    if (this.lockLayout && editor.viewColumn !== vscode.ViewColumn.One && !this.movingSource) {
      this.movingSource = true
      try {
        sourceEditor = await this.showSourceLeft(editor.document, true)
      } finally {
        this.movingSource = false
      }
    }
    await this.setDocument(sourceEditor.document, sourceEditor)
  }

  private currentPageKey(): string | undefined {
    if (!this.currentPreviewUrl) return undefined
    try { return new URL(this.currentPreviewUrl).pathname } catch { return undefined }
  }

  private isCurrentPage(message: PreviewMessage): boolean {
    const currentPage = this.currentPageKey()
    return !message.pageKey || !currentPage || message.pageKey === currentPage
  }

  private documentForPageKey(pageKey: string, root: string): vscode.Uri | undefined {
    let decoded: string
    try {
      decoded = decodeURIComponent(pageKey.split('?')[0])
    } catch {
      return undefined
    }
    const routePath = decoded.split('#')[0].split('?')[0]
    const relativeStem = routePath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.(?:html?|md)$/i, '')
    const stems = relativeStem.endsWith('/index') ? [relativeStem, relativeStem.slice(0, -('/index'.length))] : [relativeStem]
    const candidates = stems.flatMap((stem) => stem
      ? [path.join(root, `${stem}.md`), path.join(root, stem, 'index.md')]
      : [path.join(root, 'index.md')])
    for (const candidate of candidates) {
      const absolute = path.resolve(candidate)
      const relative = path.relative(root, absolute)
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue
      if (fs.existsSync(absolute)) return vscode.Uri.file(absolute)
    }
    return undefined
  }

  private headingLine(document: vscode.TextDocument, hash: string): number | undefined {
    const target = decodeURIComponent(hash.replace(/^#/, '')).trim().toLowerCase()
    if (!target) return undefined
    const normalizedTarget = target.replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
    for (let line = 0; line < document.lineCount; line += 1) {
      const text = document.lineAt(line).text
      const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(text)
      if (!match) continue
      const heading = match[1].replace(/[`*_~]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
      const slug = heading.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
      if (slug === target || slug.replace(/-/g, ' ') === normalizedTarget || heading.toLowerCase() === normalizedTarget) return line
    }
    return undefined
  }

  private async handlePreviewNavigate(message: PreviewMessage): Promise<void> {
    if (!message.pageKey || !this.currentDocument) return
    const root = configuredWikiRoot(this.currentDocument)
    if (!root) return
    const targetUri = this.documentForPageKey(message.pageKey, root)
    if (!targetUri) return
    try {
      const targetDocument = await vscode.workspace.openTextDocument(targetUri)
      const sameDocument = targetDocument.uri.toString() === this.currentDocument.uri.toString()
      const editor = sameDocument && this.sourceEditor ? this.sourceEditor : await this.showSourceLeft(targetDocument, true)
      await this.setDocument(targetDocument, editor)
      if (message.hash) {
        const line = this.headingLine(targetDocument, message.hash)
        if (line !== undefined) {
          editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop)
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      void vscode.window.showWarningMessage(`Could not open the Markdown document for this preview link: ${detail}`)
    }
  }

  private sendSourceScroll(editor: vscode.TextEditor): void {
    if (!this.panel || this.suppressSourceScroll || !this.currentDocument || editor.document.uri.toString() !== this.currentDocument.uri.toString()) return
    const visible = editor.visibleRanges[0]
    const lineCount = Math.max(1, editor.document.lineCount)
    const startLine = Math.max(0, Math.min(lineCount - 1, visible?.start.line ?? 0))
    const endLineExclusive = Math.min(lineCount, Math.max(startLine + 1, (visible?.end.line ?? startLine) + 1))
    const visibleLines = Math.max(1, endLineExclusive - startLine)
    const maxStart = Math.max(0, lineCount - visibleLines)
    const ratio = maxStart === 0 ? 0 : Math.max(0, Math.min(1, startLine / maxStart))
    void this.panel.webview.postMessage({
      type: 'sourceScroll',
      ratio,
      sourceLine: startLine,
      sourceLineCount: lineCount,
      sourceVisibleLines: visibleLines
    })
  }

  private async handleWebviewMessage(message: PreviewMessage): Promise<void> {
    if (message.type === 'previewNavigate') {
      await this.handlePreviewNavigate(message)
      return
    }
    if (message.type === 'previewReady') {
      if (this.isCurrentPage(message) && this.sourceEditor) this.sendSourceScroll(this.sourceEditor)
      return
    }
    if (message.type !== 'previewScroll' || typeof message.ratio !== 'number' || !this.isCurrentPage(message) || !this.sourceEditor || !this.currentDocument) return
    const editor = this.sourceEditor
    const visible = editor.visibleRanges[0]
    const visibleLines = Math.max(1, visible ? visible.end.line - visible.start.line + 1 : 1)
    const maxStart = Math.max(0, editor.document.lineCount - visibleLines)
    const ratio = Math.max(0, Math.min(1, message.ratio))
    const headingLine = message.activeHeading ? this.headingLine(editor.document, message.activeHeading) : undefined
    const targetLine = message.atBottom
      ? maxStart
      : headingLine !== undefined
        ? Math.min(maxStart, headingLine)
        : (ratio >= 0.999 ? maxStart : Math.round(ratio * maxStart))
    this.suppressSourceScroll = true
    if (this.suppressSourceScrollTimer) clearTimeout(this.suppressSourceScrollTimer)
    try {
      editor.revealRange(new vscode.Range(targetLine, 0, targetLine, 0), vscode.TextEditorRevealType.AtTop)
    } finally {
      this.suppressSourceScrollTimer = setTimeout(() => {
        this.suppressSourceScroll = false
        this.suppressSourceScrollTimer = undefined
      }, 450)
    }
  }

  async open(document = vscode.window.activeTextEditor?.document): Promise<void> {
    if (!document || !isWikiDocument(document)) {
      void vscode.window.showInformationMessage('Open a Markdown file inside the configured PYRo Wiki root first.')
      return
    }
    const sourceEditor = await this.showSourceLeft(document, false)
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('pyroWikiPreview', 'PYRo Wiki Preview', vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true })
      this.attachPanel(panel)
    }
    await this.setDocument(sourceEditor.document, sourceEditor)
    this.panel?.reveal(vscode.ViewColumn.Two, true)
  }

  async refresh(): Promise<void> {
    if (this.currentDocument) await this.queueRender(this.currentDocument, true)
  }

  private async render(document: vscode.TextDocument, reload: boolean, generation: number): Promise<void> {
    if (!this.panel || !isWikiDocument(document)) {
      if (this.panel) this.panel.webview.html = '<!doctype html><html><body><p>PYRo Wiki preview is disabled for this file.</p></body></html>'
      return
    }
    const root = configuredWikiRoot(document)
    if (!root) return
    try {
      if (this.syncUnsavedPreview && document.isDirty) {
        suppressNextDraftSave(document)
        const saved = await document.save()
        if (!saved) throw new Error('The Markdown file could not be saved before preview synchronization.')
      }
      if (generation !== this.renderGeneration || !this.panel) return
      await this.vitePress.start(root)
      if (generation !== this.renderGeneration || !this.panel) return
      const url = this.vitePress.urlFor(document)
      this.currentDocument = document
      this.panel.title = `PYRo Wiki: ${document.fileName.split(/[\\/]/).pop() ?? 'Preview'}`
      if (!this.webviewInitialized) {
        this.panel.webview.html = this.vitePress.document(url, this.panel.webview.cspSource, document.uri.toString())
        this.webviewInitialized = true
      } else {
        if (url !== this.currentPreviewUrl) await this.panel.webview.postMessage({ type: 'navigatePreview', url })
        else if (reload) await this.panel.webview.postMessage({ type: 'navigatePreview', url: `${url}?pyroWikiReload=${document.version}-${Date.now()}` })
      }
      this.currentPreviewUrl = url
      await this.persistPreviewState(document)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.panel) return
      this.panel.webview.html = `<!doctype html><html><body><h2>VitePress preview failed</h2><pre>${escapeHtml(message)}</pre></body></html>`
      this.webviewInitialized = false
      void vscode.window.showErrorMessage(`PYRo Wiki VitePress preview failed: ${message}`)
    }
  }

  dispose(): void {
    // Do not dispose the panel here: VS Code can serialize and restore it during
    // an extension host/window reload. The serializer rebinds the restored panel
    // to the new controller and replaces its iframe with a fresh local URL.
    if (this.pendingRenderTimer) clearTimeout(this.pendingRenderTimer)
    if (this.suppressSourceScrollTimer) clearTimeout(this.suppressSourceScrollTimer)
    this.vitePress.dispose()
    for (const disposable of this.disposables) disposable.dispose()
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character)
}

import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as path from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import type { Disposable, TextDocument } from 'vscode'

export interface VitePressPreviewServerOptions {
  extensionPath?: string
}

function findVitePressBin(workspaceRoot: string): string {
  let packageEntry: string
  try {
    packageEntry = require.resolve('vitepress', { paths: [workspaceRoot] })
  } catch {
    throw new Error('VitePress is not installed in this Wiki workspace. Install vitepress before opening the full preview.')
  }
  let directory = path.dirname(packageEntry)
  while (directory !== path.dirname(directory)) {
    const candidate = path.join(directory, 'bin', 'vitepress.js')
    if (fs.existsSync(candidate)) return candidate
    directory = path.dirname(directory)
  }
  throw new Error('The installed VitePress package does not contain its CLI entrypoint.')
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local preview port.')
  return address.port
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, '')
}

async function waitForHttp(port: number, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 500 }, (response) => {
          response.resume()
          response.statusCode && response.statusCode < 500 ? resolve() : reject(new Error(`HTTP ${response.statusCode}`))
        })
        request.once('error', reject)
        request.once('timeout', () => request.destroy(new Error('request timeout')))
      })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error('VitePress preview server did not become ready in time.')
}

function bridgeScript(): string {
  return String.raw`<script>(function(){
var parentWindow=window.parent;
var pageKey=location.pathname;
var storageKey=function(){return 'pyroWikiScroll:'+location.pathname};
var candidateCache=[];
var headingCache=[];
var scrollCandidates=function(){return candidateCache};
var frameState=function(){var root=document.documentElement;var body=document.body;var viewport=Math.max(1,window.innerHeight||root.clientHeight);var top=Math.max(window.scrollY||0,root.scrollTop||0,body&&body.scrollTop||0);var max=Math.max(0,Math.max(root.scrollHeight,body?body.scrollHeight:0)-viewport);scrollCandidates().forEach(function(element){var elementViewport=element===body?viewport:Math.max(1,element.clientHeight||viewport);var elementMax=Math.max(0,(element.scrollHeight||0)-elementViewport);var elementTop=element.scrollTop||0;if(elementMax>max||elementTop>top){max=Math.max(max,elementMax);top=Math.max(top,elementTop)}});var boundedRatio=max===0?0:Math.max(0,Math.min(1,top/max));return {top:top,max:max,ratio:boundedRatio,atBottom:max===0||top>=max-16}};
var applyRatio=function(value){var state=frameState();var top=Math.max(0,Math.min(1,Number(value)||0))*state.max;window.scrollTo(0,top);scrollCandidates().forEach(function(element){try{element.scrollTop=top}catch(_error){}})};
var restore=function(){var saved=sessionStorage.getItem(storageKey());if(saved!==null){sessionStorage.removeItem(storageKey());window.requestAnimationFrame(function(){window.requestAnimationFrame(function(){applyRatio(saved)})})}};
var headingState=function(){var state=frameState();var cutoff=state.top+Math.max(24,window.innerHeight*0.35);var active='';headingCache.forEach(function(heading){if(heading.getBoundingClientRect().top+(window.scrollY||0)<=cutoff)active=heading.id});return {ratio:state.ratio,active:active,atBottom:state.atBottom}};
var lastNavigation=location.pathname+location.hash;
var publishNavigation=function(force){var next=location.pathname+location.hash;if(!force&&next===lastNavigation)return;lastNavigation=next;pageKey=location.pathname;parentWindow.postMessage({type:'previewNavigate',pageKey:pageKey,hash:location.hash||''},'*')};
var isInternalRoute=function(url){if(url.origin!==location.origin)return false;var last=url.pathname.split('/').pop()||'';return url.pathname==='/'||url.pathname.endsWith('/')||url.pathname.endsWith('.html')||url.pathname.endsWith('.htm')||!last.includes('.')};
var programmatic=false;var raf=0;var lastScrollPost=0;
var publishScroll=function(){if(programmatic||raf)return;raf=window.requestAnimationFrame(function(){raf=0;if(!programmatic){var now=Date.now();if(now-lastScrollPost<50)return;lastScrollPost=now;var state=headingState();parentWindow.postMessage({type:'previewScroll',ratio:state.ratio,pageKey:pageKey,activeHeading:state.active,atBottom:state.atBottom},'*')}})};
var attachScrollListeners=function(){scrollCandidates().forEach(function(element){if(!element.__pyroScrollBound){element.__pyroScrollBound=true;element.addEventListener('scroll',publishScroll,{passive:true})}})};
var refreshDomCache=function(){var result=[document.scrollingElement,document.documentElement,document.body];document.querySelectorAll('.VPApp,.VPContent,.VPDoc,main').forEach(function(element){result.push(element)});candidateCache=result.filter(function(element,index){return element&&result.indexOf(element)===index});headingCache=Array.prototype.slice.call(document.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]'));attachScrollListeners()};
var cacheRefreshRaf=0;var scheduleDomCacheRefresh=function(){if(cacheRefreshRaf)return;cacheRefreshRaf=window.requestAnimationFrame(function(){cacheRefreshRaf=0;refreshDomCache()})};
var scheduleNavigation=function(){window.setTimeout(function(){publishNavigation(true)},0)};
['pushState','replaceState'].forEach(function(method){var original=history[method];history[method]=function(){var result=original.apply(this,arguments);scheduleNavigation();return result}});
window.addEventListener('scroll',publishScroll,{passive:true});
window.addEventListener('message',function(event){if(event.data&&event.data.type==='sourceScroll'){programmatic=true;applyRatio(event.data.ratio);window.setTimeout(function(){programmatic=false},250)}});
document.addEventListener('click',function(event){var target=event.target instanceof Element?event.target.closest('a[href]'):null;if(!target||target.target==='_blank'||event.defaultPrevented)return;var href=target.getAttribute('href');if(!href)return;var url;try{url=new URL(href,location.href)}catch(_error){return}if(isInternalRoute(url))scheduleNavigation()},true);
window.addEventListener('popstate',function(){publishNavigation(true)});window.addEventListener('hashchange',function(){publishNavigation(true)});
window.addEventListener('beforeunload',function(){sessionStorage.setItem(storageKey(),String(frameState().ratio))});
window.addEventListener('load',function(){refreshDomCache();restore();parentWindow.postMessage({type:'previewReady',pageKey:pageKey},'*')});
new MutationObserver(scheduleDomCacheRefresh).observe(document.documentElement,{childList:true,subtree:true});
})();</script>`
}

function webviewDocument(url: string, cspSource: string, documentUri?: string): string {
  const escapedUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const nonce = Math.random().toString(36).slice(2)
  const serializedState = JSON.stringify(documentUri ? { documentUri } : {}).replace(/</g, '\\u003c')
  const script = `const vscode=acquireVsCodeApi();const frame=document.getElementById('vitepress-frame');const initialState=${serializedState};if(initialState.documentUri)vscode.setState(Object.assign({},vscode.getState()||{},initialState));let pendingSourceScroll=null;window.addEventListener('message',event=>{if(event.source===frame.contentWindow&&event.data){if(event.data.type==='previewReady'&&pendingSourceScroll){frame.contentWindow.postMessage(pendingSourceScroll,'*');pendingSourceScroll=null}vscode.postMessage(event.data);return}if(event.data?.type==='sourceScroll'){pendingSourceScroll=event.data;frame.contentWindow?.postMessage(event.data,'*')}if(event.data?.type==='navigatePreview'){frame.src=event.data.url;vscode.setState(Object.assign({},vscode.getState()||{},{previewUrl:event.data.url}))}});`
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:*; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#1b1b1f}#vitepress-frame{display:block;width:100%;height:100%;border:0;background:transparent}</style></head><body><iframe id="vitepress-frame" title="PYRo Wiki VitePress Preview" loading="eager" src="${escapedUrl}"></iframe><script nonce="${nonce}">${script}</script></body></html>`.replace('<meta charset="UTF-8">', `<meta charset="UTF-8"><meta name="vscode-webview-resource-origin" content="${cspSource}">`)
}

function loadingDocument(cspSource: string): string {
  const nonce = Math.random().toString(36).slice(2)
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="vscode-webview-resource-origin" content="${cspSource}"><style>html,body{width:100%;height:100%;margin:0;background:#1b1b1f;color:#c9c9d1;font:13px system-ui,sans-serif}body{display:grid;place-items:center}.loading{display:flex;align-items:center;gap:10px;opacity:.8}.spinner{width:14px;height:14px;border:2px solid #555;border-top-color:#8ab4f8;border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="loading"><span class="spinner"></span><span>Starting PYRo Wiki preview...</span></div><script nonce="${nonce}">void 0</script></body></html>`
}

export class VitePressPreviewServer implements Disposable {
  private workspaceRoot: string | undefined
  private vitePort: number | undefined
  private proxyPort: number | undefined
  private viteProcess: childProcess.ChildProcess | undefined
  private proxyServer: http.Server | undefined
  private readonly proxyWebSocketServer = new WebSocketServer({ noServer: true })
  private readonly proxyWebSockets = new Set<WebSocket>()
  private starting: Promise<void> | undefined
  private viteBasePath = '/'
  private viteOutput = ''

  get root(): string | undefined {
    return this.workspaceRoot
  }

  get ready(): boolean {
    return Boolean(this.workspaceRoot && this.vitePort && this.proxyPort)
  }

  async start(workspaceRoot: string): Promise<void> {
    if (this.ready && this.workspaceRoot === workspaceRoot) return
    if (this.starting) {
      const starting = this.starting
      try {
        await starting
      } catch {
        // The caller below will retry and report a fresh startup error.
      }
      if (this.ready && this.workspaceRoot === workspaceRoot) return
    }
    if (this.ready && this.workspaceRoot !== workspaceRoot) await this.disposeAsync()

    const starting = this.startInternal(workspaceRoot)
    this.starting = starting
    try {
      await starting
    } catch (error) {
      await this.disposeAsync()
      throw error
    } finally {
      if (this.starting === starting) this.starting = undefined
    }
  }

  private async startInternal(workspaceRoot: string): Promise<void> {
    const vitepressBin = findVitePressBin(workspaceRoot)
    const vitePort = await freePort()
    const viteProcess = childProcess.spawn(process.execPath, [vitepressBin, 'dev', workspaceRoot, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      cwd: workspaceRoot,
      env: { ...process.env, BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.viteProcess = viteProcess
    this.viteBasePath = '/'
    this.viteOutput = ''
    const captureViteOutput = (chunk: Buffer | string): void => {
      this.viteOutput = (this.viteOutput + chunk.toString()).slice(-16_384)
      const clean = stripAnsi(this.viteOutput)
      const local = clean.match(/Local:\s+(https?:\/\/[^\s]+)/)
      if (!local) return
      try {
        const pathname = new URL(local[1]).pathname
        this.viteBasePath = pathname.endsWith('/') ? pathname : `${pathname}/`
      } catch {
        this.viteBasePath = '/'
      }
    }
    viteProcess.stdout?.on('data', captureViteOutput)
    viteProcess.stderr?.on('data', captureViteOutput)
    viteProcess.once('exit', () => {
      if (this.viteProcess === viteProcess) {
        this.viteProcess = undefined
        this.vitePort = undefined
        this.viteBasePath = '/'
        this.viteOutput = ''
      }
    })
    this.vitePort = vitePort
    await waitForHttp(vitePort)

    const proxyServer = http.createServer((request, response) => this.proxyRequest(request, response))
    proxyServer.on('upgrade', (request, socket, head) => this.proxyUpgrade(request, socket, head))
    await new Promise<void>((resolve, reject) => {
      proxyServer.once('error', reject)
      proxyServer.listen(0, '127.0.0.1', () => resolve())
    })
    const address = proxyServer.address()
    if (!address || typeof address === 'string') {
      proxyServer.close()
      throw new Error('Could not allocate the VitePress preview bridge port.')
    }
    this.workspaceRoot = workspaceRoot
    this.proxyServer = proxyServer
    this.proxyPort = address.port
  }

  private proxyRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (!this.vitePort) {
      response.writeHead(503)
      response.end('VitePress preview is not ready')
      return
    }
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: this.vitePort,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `127.0.0.1:${this.vitePort}` }
    }, (upstreamResponse) => {
      const contentType = String(upstreamResponse.headers['content-type'] ?? '')
      if (!contentType.includes('text/html')) {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
        return
      }
      const chunks: Buffer[] = []
      upstreamResponse.on('data', (chunk: Buffer) => chunks.push(chunk))
      upstreamResponse.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8')
        body = body.replace('</head>', `${bridgeScript()}</head>`)
        const headers = { ...upstreamResponse.headers }
        delete headers['content-length']
        delete headers['content-encoding']
        response.writeHead(upstreamResponse.statusCode ?? 200, headers)
        response.end(body)
      })
    })
    upstream.once('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end('Unable to reach VitePress preview server')
    })
    request.pipe(upstream)
  }

  private proxyUpgrade(request: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    if (!this.vitePort) {
      socket.destroy()
      return
    }
    this.proxyWebSocketServer.handleUpgrade(request, socket as import('node:net').Socket, head, (client) => {
      const protocol = request.headers['sec-websocket-protocol']
      const target = new WebSocket(`ws://127.0.0.1:${this.vitePort}${request.url ?? '/'}`, protocol ? String(protocol).split(',').map((value) => value.trim()) : undefined)
      this.proxyWebSockets.add(client)
      this.proxyWebSockets.add(target)
      const cleanup = () => {
        this.proxyWebSockets.delete(client)
        this.proxyWebSockets.delete(target)
      }
      target.once('open', () => {
        client.on('message', (data, isBinary) => {
          if (target.readyState === WebSocket.OPEN) target.send(data, { binary: isBinary })
        })
        target.on('message', (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
        })
      })
      target.once('error', () => client.close())
      client.once('error', () => target.close())
      target.once('close', () => { cleanup(); client.close() })
      client.once('close', () => { cleanup(); target.close() })
    })
  }

  urlFor(document: TextDocument): string {
    if (!this.workspaceRoot || !this.proxyPort) throw new Error('VitePress preview server is not ready.')
    const relative = path.relative(this.workspaceRoot, document.uri.fsPath).replace(/\\/g, '/')
    const withoutExtension = relative.replace(/\.md$/i, '')
    const route = withoutExtension.toLowerCase() === 'index'
      ? ''
      : withoutExtension.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    const basePath = this.viteBasePath.endsWith('/') ? this.viteBasePath : `${this.viteBasePath}/`
    return `http://127.0.0.1:${this.proxyPort}${basePath}${route}`
  }

  document(url: string, cspSource: string, documentUri?: string): string {
    return webviewDocument(url, cspSource, documentUri)
  }

  loadingDocument(cspSource: string): string {
    return loadingDocument(cspSource)
  }

  async disposeAsync(): Promise<void> {
    if (this.starting) {
      try { await this.starting } catch { /* continue cleanup */ }
    }
    for (const socket of this.proxyWebSockets) socket.terminate()
    this.proxyWebSockets.clear()
    const proxyServer = this.proxyServer
    this.proxyServer = undefined
    this.proxyPort = undefined
    this.workspaceRoot = undefined
    this.vitePort = undefined
    if (proxyServer) await new Promise<void>((resolve) => proxyServer.close(() => resolve()))
    const viteProcess = this.viteProcess
    this.viteProcess = undefined
    if (viteProcess && !viteProcess.killed) {
      viteProcess.kill()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000)
        viteProcess.once('exit', () => { clearTimeout(timer); resolve() })
      })
    }
  }

  dispose(): void {
    void this.disposeAsync()
  }
}

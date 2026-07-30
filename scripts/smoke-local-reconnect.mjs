import { runReconnect } from './smoke-local-realtime-scenario.mjs'
runReconnect().catch((error) => { console.error(`PYRo Wiki reconnect smoke failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })

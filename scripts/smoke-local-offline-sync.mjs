import { runOfflineSync } from './smoke-local-realtime-scenario.mjs'
runOfflineSync().catch((error) => { console.error(`PYRo Wiki offline sync smoke failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })

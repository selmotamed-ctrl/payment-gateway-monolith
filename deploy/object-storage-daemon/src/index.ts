import { startObjectStorageDaemon } from './server'

const daemon = await startObjectStorageDaemon()
console.log(`[object-storage-daemon] listening on ${daemon.baseUrl} (rootDir=${daemon.store.rootDir})`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    console.log(`[object-storage-daemon] received ${signal}, shutting down...`)
    await daemon.close()
    process.exit(0)
  })
}

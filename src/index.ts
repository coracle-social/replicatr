import crypto from 'node:crypto'

// Polyfill crypto for @welshman/net
// The library expects both Web Crypto API and Node.js crypto methods
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto as any
}

// Add Node.js crypto methods to global crypto
Object.assign(globalThis.crypto, {
  createHash: crypto.createHash.bind(crypto),
  createHmac: crypto.createHmac.bind(crypto),
  randomBytes: crypto.randomBytes.bind(crypto),
})

import {Mutex} from 'async-mutex'
import {call, uniqBy, identity, batch, difference, TaskQueue} from '@welshman/lib'
import {TrustedEvent, isSignedEvent, RELAYS, normalizeRelayUrl, displayRelayUrl, getAddress, readList, asDecryptedEvent, getRelaysFromList, RelayMode} from '@welshman/util'
import {request, pull, push, Repository, mergeRepositoryUpdates} from '@welshman/net'
import * as fs from 'fs'
import * as path from 'path'

if (!process.env.INDEXER_RELAYS) throw new Error("INDEXER_RELAYS not provided")
if (!process.env.DATA_DIRECTORY) throw new Error("DATA_DIRECTORY not provided")

const INDEXER_RELAYS = process.env.INDEXER_RELAYS.split(',').map(normalizeRelayUrl)

const storage = path.join(process.env.DATA_DIRECTORY, "events.jsonl")

const storageMutex = new Mutex()

const repository = Repository.get()

const queue = new TaskQueue<TrustedEvent>({
  batchSize: 100,
  processItem: async (current: TrustedEvent) => {
    const previous = repository.getEvent(getAddress(current))

    repository.publish(current)

    if (!previous || previous.id === current.id) {
      return
    }

    const pubkey = current.pubkey
    const currentList = readList(asDecryptedEvent(current))
    const previousList = readList(asDecryptedEvent(previous))

    const currentWriteRelays = getRelaysFromList(currentList, RelayMode.Write)
    const previousWriteRelays = getRelaysFromList(previousList, RelayMode.Write)
    const newWriteRelays = difference(currentWriteRelays, previousWriteRelays)
    const writeFilters = [{authors: [pubkey]}]

    if (newWriteRelays.length > 0) {
      console.log("Synchronizing events to new write relays", {pubkey, relays: newWriteRelays})

      const events = uniqBy(
        e => e.id,
        await pull({
          filters: writeFilters,
          relays: previousWriteRelays,
          events: repository.query(writeFilters).filter(isSignedEvent),
        })
      )

      console.log(`${events.length} unsynchronized events found`, {pubkey, relays: newWriteRelays})

      if (events.length > 0) {
        await push({events, filters: writeFilters, relays: newWriteRelays})
      }

      console.log("Finished synchronizing events to new write relays", {pubkey, relays: newWriteRelays})
    }

    const currentReadRelays = getRelaysFromList(currentList, RelayMode.Read)
    const previousReadRelays = getRelaysFromList(previousList, RelayMode.Read)
    const newReadRelays = difference(currentReadRelays, previousReadRelays)
    const readRelayDisplay = newReadRelays.map(displayRelayUrl).join(', ')
    const readFilters = [{'#p': [pubkey]}]

    if (newReadRelays.length > 0) {
      console.log("Synchronizing events to new read relays", {pubkey, relays: newReadRelays})

      const events = uniqBy(
        e => e.id,
        await pull({
          filters: readFilters,
          relays: previousReadRelays,
          events: repository.query(writeFilters).filter(isSignedEvent),
        })
      )

      console.log(`${events.length} unsynchronized events found`, {pubkey, relays: newWriteRelays})

      if (events.length > 0) {
        await push({events, filters: readFilters, relays: newReadRelays})
      }

      console.log("Finished synchronizing events to new read relays", {pubkey, relays: newReadRelays})
    }
  }
})

const getStoredEvents = async () => {
  if (!fs.existsSync(storage)) {
    return []
  }

  const content = await storageMutex.runExclusive(() => fs.promises.readFile(storage, 'utf-8'))
  const events = content.split('\n').filter(identity).map(line => JSON.parse(line))

  return uniqBy(e => e.id, events)
}

call(async () => {
  console.log("Loading saved relay selection events...")

  repository.load(await getStoredEvents())

  repository.on('update', batch(1000, async updates => {
    const {added} = mergeRepositoryUpdates(updates)

    // Skip removing old events to avoid re-writing the whole file (to avoid oom errors)
    for (const event of added) {
      await storageMutex.runExclusive(() => fs.promises.appendFile(storage, JSON.stringify(event) + '\n'))
    }
  }))

  console.log("Listening for updates from indexer relays...")

  request({
    relays: INDEXER_RELAYS,
    // filters: [{kinds: [RELAYS], authors: ["97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322"], limit: 0}],
    filters: [{kinds: [RELAYS], limit: 0}],
    onEvent: (event: TrustedEvent) => {
      queue.push(event)
    },
  })

  console.log("Synchronizing relay selections from indexer relays...")

  const events = await pull({
    relays: INDEXER_RELAYS,
    filters: [{kinds: [RELAYS]}],
    // filters: [{kinds: [RELAYS], authors: ["97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322"]}],
    events: repository.query([{kinds: [RELAYS]}]).filter(isSignedEvent),
  })

  console.log(`Synchronized ${events.length} relay selections from indexer relays`)

  for (const event of events) {
    queue.push(event)
  }
})

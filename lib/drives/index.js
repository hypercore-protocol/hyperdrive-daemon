const crypto = require('crypto')
const { EventEmitter } = require('events')

const hyperdrive = require('hyperdrive')
const collectStream = require('stream-collector')
const sub = require('subleveldown')
const bjson = require('buffer-json-encoding')
const datEncoding = require('dat-encoding')
const pump = require('pump')
const { Transform } = require('streamx')

const {
  fromHyperdriveOptions,
  fromStat,
  fromMount,
  fromMetadata,
  fromNetworkConfiguration,
  toHyperdriveOptions,
  toStat,
  toMount,
  toMountInfo,
  toDriveStats,
  toDiffEntry,
  toNetworkConfiguration,
  setFileStats,
  toChunks
} = require('hyperdrive-daemon-client/lib/common')
const { rpc } = require('hyperdrive-daemon-client')
const ArrayIndex = require('./array-index.js')

const log = require('../log').child({ component: 'drive-manager' })

const TRIE_UPDATER_SYMBOL = Symbol('hyperdrive-daemon-trie-updater')

class DriveManager extends EventEmitter {
  constructor (corestore, networking, db, opts = {}) {
    super()

    this.corestore = corestore
    this.networking = networking
    this.db = db
    this.opts = opts
    this.watchLimit = opts.watchLimit
    this.noAnnounce = !!opts.noAnnounce
    this.memoryOnly = !!opts.memoryOnly

    this._driveIndex = sub(this.db, 'drives', { valueEncoding: bjson })
    this._seedIndex = sub(this.db, 'seeding', { valueEncoding: 'json' })
    this._namespaceIndex = sub(this.db, 'namespaces', { valueEncoding: 'utf8' })

    this._drives = new Map()
    this._checkouts = new Map()
    this._watchers = new Map()
    this._sessionsByKey = new Map()
    this._transientSeedIndex = new Map()
    this._configuredMounts = new Set()
    this._sessions = new ArrayIndex()
    this._downloads = new ArrayIndex()
    this._watchCount = 0

    this._readyPromise = null

    this.ready = () => {
      if (this._readyPromise) return this._readyPromise
      this._readyPromise = Promise.all([
        this._rejoin()
      ])
      return this._readyPromise
    }
  }

  async _rejoin () {
    if (this.noAnnounce) return
    const driveList = await collect(this._seedIndex)
    for (const { key: discoveryKey, value: networkOpts } of driveList) {
      const opts = networkOpts && networkOpts.opts
      if (!opts || !opts.announce) continue
      this.networking.join(discoveryKey, { ...networkOpts.opts })
    }
  }

  _generateKeyString (key, opts) {
    var keyString = (key instanceof Buffer) ? key.toString('hex') : key
    if (opts && opts.version) keyString = keyString + '+' + opts.version
    if (opts && opts.hash) keyString = keyString + '+' + opts.hash
    return keyString
  }

  async _getNamespace (keyString) {
    if (!keyString) return null
    try {
      const namespace = await this._namespaceIndex.get('by-drive/' + keyString)
      return namespace
    } catch (err) {
      if (!err.notFound) throw err
      return null
    }
  }

  async _createNamespace (keyString) {
    const namespace = crypto.randomBytes(32).toString('hex')
    try {
      var existing = await this._namespaceIndex.get('by-namespace/' + namespace)
    } catch (err) {
      if (!err.notFound) throw err
      existing = null
    }
    if (existing) return this._createNamespace(keyString)
    return namespace
  }

  driveForSession (sessionId) {
    const drive = this._sessions.get(sessionId)
    if (!drive) throw new Error('Session does not exist.')
    return drive
  }

  async createSession (drive, key, opts) {
    if (!drive) drive = await this.get(key, opts)
    key = drive.key.toString('hex')

    const sessionId = this._sessions.insert(drive)
    var driveSessions = this._sessionsByKey.get(key)

    if (!driveSessions) {
      driveSessions = []
      this._sessionsByKey.set(key, driveSessions)
    }
    driveSessions.push(sessionId)

    return { drive, session: sessionId }
  }

  closeSession (id) {
    const drive = this._sessions.get(id)
    if (!drive) return null

    const driveKey = drive.key.toString('hex')
    const driveDKey = drive.discoveryKey.toString('hex')
    const driveSessions = this._sessionsByKey.get(driveKey)
    this._sessions.delete(id)
    const idx = driveSessions.indexOf(id)
    if (idx !== -1) driveSessions.splice(idx, 1)

    // If there are still active sessions, don't close the drive.
    if (driveSessions.length) return null

    log.debug({ id, discoveryKey: driveDKey }, 'closing drive because all associated sessions have closed')
    this._sessionsByKey.delete(driveKey)

    // If a drive is closed in memory-only mode, its storage will be deleted, so don't actually close.
    if (this.memoryOnly) {
      log.debug({ id, discoveryKey: driveDKey }, 'aborting drive close because we\'re in memory-only mode')
      return null
    }

    const watchers = this._watchers.get(driveKey)
    if (watchers && watchers.length) {
      for (const watcher of watchers) {
        watcher.destroy()
      }
    }
    this._watchers.delete(driveKey)

    this._drives.delete(driveKey)
    const checkouts = this._checkouts.get(driveKey)
    if (checkouts && checkouts.length) {
      for (const keyString of checkouts) {
        this._drives.delete(keyString)
      }
    }
    this._checkouts.delete(driveKey)

    return new Promise((resolve, reject) => {
      drive.close(err => {
        if (err) return reject(err)
        log.debug({ id, discoveryKey: driveDKey }, 'closed drive and cleaned up any remaining watchers')
        return resolve()
      })
    })
  }

  async getAllStats (opts) {
    const allStats = []
    for (const [, drive] of this._drives) {
      const driveStats = await this.getDriveStats(drive, opts)
      allStats.push(driveStats)
    }
    return allStats
  }

  async getDriveStats (drive, opts = {}) {
    const mounts = await new Promise((resolve, reject) => {
      drive.getAllMounts({ memory: true, recursive: !!opts.recursive }, (err, mounts) => {
        if (err) return reject(err)
        return resolve(mounts)
      })
    })
    const stats = []

    for (const [path, { metadata, content }] of mounts) {
      stats.push({
        path,
        metadata: await getCoreStats(metadata),
        content: await getCoreStats(content)
      })
    }

    return stats

    async function getCoreStats (core) {
      if (!core) return {}
      const stats = core.stats
      const openedPeers = core.peers.filter(p => p.remoteOpened)
      const networkingStats = {
        key: core.key,
        discoveryKey: core.discoveryKey,
        peerCount: core.peers.length,
        peers: openedPeers.map(p => {
          return {
            ...p.stats,
            remoteAddress: p.remoteAddress
          }
        })
      }
      if (opts.networkingOnly) return networkingStats
      return {
        ...networkingStats,
        uploadedBytes: stats.totals.uploadedBytes,
        uploadedBlocks: stats.totals.uploadedBlocks,
        downloadedBytes: stats.totals.downloadedBytes,
        downloadedBlocks: core.downloaded(),
        totalBlocks: core.length
      }
    }
  }

  listDrives () {
    return collect(this._driveIndex)
  }

  async getAllNetworkConfigurations () {
    const storedConfigurations = (await collect(this._seedIndex)).map(({ key, value }) => [key, value])
    const transientConfigurations = [...this._transientSeedIndex]
    return new Map([...storedConfigurations, ...transientConfigurations])
  }

  async get (key, opts = {}) {
    key = (key instanceof Buffer) ? datEncoding.decode(key) : key
    var keyString = this._generateKeyString(key, opts)
    const version = opts.version

    if (key) {
      // TODO: cache checkouts
      const existing = this._drives.get(keyString)
      if (existing) return existing
    }

    const driveOpts = {
      ...opts,
      version: null,
      key: null,
      sparse: opts.sparse !== false,
      sparseMetadata: opts.sparseMetadata !== false
    }
    var drive = this._drives.get(key)
    var checkout = null
    var unlisteners = []

    if (!drive) {
      var namespace = await this._getNamespace(keyString)
      if (!namespace) namespace = await this._createNamespace(keyString)
      drive = hyperdrive(this.corestore, key, {
        ...driveOpts,
        namespace
      })

      const errorListener = err => log.error(err)
      const metadataFeedListener = feed => {
        if (feed[TRIE_UPDATER_SYMBOL]) return
        feed[TRIE_UPDATER_SYMBOL] = true
        // Periodically update the trie.
        // TODO: This is to give the writer a bit of time between update requests, but we should do deferred HAVEs instead.
        let updateTimeout = null
        const loop = () => {
          updateTimeout = setTimeout(() => {
            feed.update(loop)
          }, 5000)
        }
        loop()
        const closeListener = () => clearTimeout(updateTimeout)
        feed.once('close', closeListener)
        unlisteners.push(() => {
          closeListener()
          feed.removeListener('close', closeListener)
        })
      }
      drive.on('error', errorListener)
      drive.on('metadata-feed', metadataFeedListener)
      unlisteners.push(() => drive.removeListener('error', errorListener))
      unlisteners.push(() => drive.removeListener('metadata-feed', metadataFeedListener))
    }

    await new Promise((resolve, reject) => {
      drive.ready(err => {
        if (err) return reject(err)
        return resolve()
      })
    })

    if (version || (version === 0)) checkout = drive.checkout(version)

    key = datEncoding.encode(drive.key)
    keyString = this._generateKeyString(key, opts)

    if (namespace) {
      await this._namespaceIndex.batch([
        { type: 'put', key: 'by-namespace/' + namespace, value: keyString },
        { type: 'put', key: 'by-drive/' + keyString, value: namespace }
      ])
    }

    var initialConfig
    // TODO: Need to fully work through all the default networking behaviors.
    if (opts.fuseNetwork) {
      // TODO: The Network drive does not announce or remember any settings for now.
      initialConfig = { lookup: true, announce: false, remember: false }
      await this.configureNetwork(drive.metadata, initialConfig)
    } else if (!drive.writable || opts.seed) {
      initialConfig = { lookup: true, announce: false, remember: true }
      await this.configureNetwork(drive.metadata, initialConfig)
    }

    // Make sure that any inner mounts are recorded in the drive index.
    const mountListener = async (trie) => {
      const feed = trie.feed
      const mountInfo = { version: trie.version }
      const mountKey = feed.key.toString('hex')

      log.info({ discoveryKey: feed.discoveryKey.toString('hex') }, 'registering mountpoint in drive index')
      const parentConfig = (await this.getNetworkConfiguration(drive)) || initialConfig || {}
      const existingMountConfig = (await this.getNetworkConfiguration(feed)) || {}
      const mountConfig = {
        lookup: (existingMountConfig.lookup !== false) && (parentConfig.lookup !== false),
        announce: !!(existingMountConfig.announce || parentConfig.announce),
        remember: true
      }

      if (mountConfig) await this.configureNetwork(feed, mountConfig)
      this.emit('configured-mount', feed.key)
      this._configuredMounts.add(mountKey)
      try {
        await this._driveIndex.get(mountKey)
      } catch (err) {
        if (err && !err.notFound) log.error({ error: err }, 'error registering mountpoint in drive index')
        try {
          await this._driveIndex.put(mountKey, mountInfo)
        } catch (err) {
          log.error({ error: err }, 'could not register mountpoint in drive index')
        }
      }
    }
    drive.on('mount', mountListener)
    unlisteners.push(() => drive.removeAllListeners('mount'))

    drive.once('close', () => {
      for (const unlisten of unlisteners) {
        unlisten()
      }
      unlisteners = []
    })

    // TODO: This should all be in one batch.
    await Promise.all([
      this._driveIndex.put(key, driveOpts)
    ])
    this._drives.set(key, drive)
    if (checkout) {
      var checkouts = this._checkouts.get(key)
      if (!checkouts) {
        checkouts = []
        this._checkouts.set(key, checkouts)
      }
      checkouts.push(keyString)
      this._drives.set(keyString, checkout)
    }

    return checkout || drive
  }

  async configureNetwork (feed, opts = {}) {
    const self = this
    const encodedKey = datEncoding.encode(feed.discoveryKey)
    const networkOpts = {
      lookup: !!opts.lookup,
      announce: !!opts.announce,
      remember: !!opts.remember
    }
    const seeding = opts.lookup || opts.announce
    var networkingPromise

    const sameConfig = sameNetworkConfig(feed.discoveryKey, opts)
    // If all the networking options are the same, exit early.
    if (sameConfig) return

    const networkConfig = { key: datEncoding.encode(feed.key), opts: networkOpts }
    if (opts.remember) {
      if (seeding) await this._seedIndex.put(encodedKey, networkConfig)
      else await this._seedIndex.del(encodedKey)
    } else {
      this._transientSeedIndex.set(encodedKey, networkConfig)
    }

    // Failsafe
    if (networkOpts.announce && this.noAnnounce) networkOpts.announce = false

    try {
      if (seeding) {
        networkingPromise = this.networking.join(feed.discoveryKey, networkOpts)
      } else {
        networkingPromise = this.networking.leave(feed.discoveryKey)
      }
      networkingPromise.then(configurationSuccess)
      networkingPromise.catch(configurationError)
    } catch (err) {
      configurationError(err)
    }

    function sameNetworkConfig (discoveryKey, opts = {}) {
      const swarmStatus = self.networking.status(discoveryKey)
      if (!swarmStatus) return opts.lookup === false && opts.announce === false
      return swarmStatus.announce === opts.announce && swarmStatus.lookup === opts.lookup
    }

    function configurationError (err) {
      log.error({ err, discoveryKey: encodedKey }, 'network configuration error')
    }

    function configurationSuccess () {
      log.debug({ discoveryKey: encodedKey }, 'network configuration succeeded')
    }
  }

  async getNetworkConfiguration (drive) {
    const encodedKey = datEncoding.encode(drive.discoveryKey)
    const networkOpts = this._transientSeedIndex.get(encodedKey)
    if (networkOpts) return networkOpts.opts
    try {
      const persistentOpts = await this._seedIndex.get(encodedKey)
      return persistentOpts.opts
    } catch (err) {
      return null
    }
  }

  download (drive, path) {
    const dl = drive.download(path)
    return this._downloads.insert(dl)
  }

  getHandlers () {
    return {
      version: async (call) => {
        const id = call.request.getId()

        if (!id) throw new Error('A version request must specify a session ID.')
        const drive = this.driveForSession(id)

        const rsp = new rpc.drive.messages.DriveVersionResponse()
        rsp.setVersion(drive.version)

        return rsp
      },

      get: async (call) => {
        var driveOpts = fromHyperdriveOptions(call.request.getOpts())

        const { drive, session } = await this.createSession(null, driveOpts.key, driveOpts)
        driveOpts.key = drive.key
        driveOpts.discoveryKey = drive.discoveryKey
        driveOpts.version = drive.version
        driveOpts.writable = drive.writable

        const rsp = new rpc.drive.messages.GetDriveResponse()
        rsp.setId(session)
        rsp.setOpts(toHyperdriveOptions(driveOpts))

        return rsp
      },

      allStats: async (call) => {
        const networkingOnly = call.request.getNetworkingonly()
        var stats = await this.getAllStats({ networkingOnly })
        stats = stats.map(driveStats => toDriveStats(driveStats))

        const rsp = new rpc.drive.messages.StatsResponse()
        rsp.setStatsList(stats)

        return rsp
      },

      allNetworkConfigurations: async (call) => {
        const networkConfigurations = await this.getAllNetworkConfigurations()

        const rsp = new rpc.drive.messages.NetworkConfigurationsResponse()
        rsp.setConfigurationsList([...networkConfigurations].map(([, value]) => toNetworkConfiguration({
          ...value.opts,
          key: Buffer.from(value.key, 'hex')
        })))

        return rsp
      },

      peerCounts: async (call) => {
        const rsp = new rpc.drive.messages.PeerCountsResponse()
        const keys = call.request.getKeysList()
        if (!keys) return rsp

        const counts = []
        for (let key of keys) {
          key = Buffer.from(key)
          if (this.corestore.isLoaded(key)) {
            const core = this.corestore.get(key)
            const openPeers = core.peers.filter(p => p.remoteOpened)
            counts.push(openPeers.length)
          } else {
            counts.push(0)
          }
        }

        rsp.setPeercountsList(counts)
        return rsp
      },

      configureNetwork: async (call) => {
        const id = call.request.getId()

        if (!id) throw new Error('A network configuration request must specify a session ID.')
        const drive = this.driveForSession(id)
        const opts = fromNetworkConfiguration(call.request.getNetwork())

        await this.configureNetwork(drive.metadata, { ...opts })

        const rsp = new rpc.drive.messages.ConfigureNetworkResponse()
        return rsp
      },

      stats: async (call) => {
        const id = call.request.getId()

        if (!id) throw new Error('A stats request must specify a session ID.')
        const drive = this.driveForSession(id)

        const recursive = call.request.getRecursive()
        const networkingOnly = call.request.getNetworkingonly()
        const driveStats = await this.getDriveStats(drive, { recursive, networkingOnly })
        const networkConfig = await this.getNetworkConfiguration(drive)

        const rsp = new rpc.drive.messages.DriveStatsResponse()
        rsp.setStats(toDriveStats(driveStats))
        if (networkConfig) rsp.setNetwork(toNetworkConfiguration(networkConfig))
        return rsp
      },

      download: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()

        if (!id) throw new Error('A download request must specify a session ID.')
        const drive = this.driveForSession(id)
        const downloadId = this.download(drive, path)

        const rsp = new rpc.drive.messages.DownloadResponse()
        rsp.setDownloadid(downloadId)
        return rsp
      },

      undownload: async (call) => {
        const id = call.request.getId()
        const downloadId = call.request.getDownloadid()

        if (!id) throw new Error('An undownload request must specify a session ID.')
        if (!downloadId) throw new Error('An undownload request must specify a download ID.')

        const dl = this._downloads.get(downloadId)
        if (dl) dl.destroy()
        this._downloads.delete(downloadId)

        return new rpc.drive.messages.UndownloadResponse()
      },

      createDiffStream: async (call) => {
        const id = call.request.getId()
        const prefix = call.request.getPrefix()
        const otherVersion = call.request.getOther()

        if (!id) throw new Error('A diff stream request must specify a session ID.')
        const drive = this.driveForSession(id)

        const stream = drive.createDiffStream(otherVersion, prefix)

        const rspMapper = new Transform({
          transform (chunk, cb) {
            const rsp = new rpc.drive.messages.DiffStreamResponse()
            if (!chunk) return rsp

            const { name, type, value } = chunk
            rsp.setType(type)
            rsp.setName(name)
            if (type === 'put') {
              rsp.setValue(toDiffEntry({ stat: value }))
            } else {
              rsp.setValue(toDiffEntry({ mount: value }))
            }

            return cb(null, rsp)
          }
        })

        pump(stream, rspMapper, call, err => {
          if (err) {
            log.error({ id, err }, 'createDiffStream error')
            call.destroy(err)
          }
        })
      },

      createReadStream: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()
        const start = call.request.getStart()
        var end = call.request.getEnd()
        const length = call.request.getLength()

        if (!id) throw new Error('A createReadStream request must specify a session ID.')
        if (!path) throw new Error('A createReadStream request must specify a path.')
        const drive = this.driveForSession(id)

        const streamOpts = {}
        if (end !== 0) streamOpts.end = end
        if (length !== 0) streamOpts.length = length
        streamOpts.start = start

        const stream = drive.createReadStream(path, streamOpts)

        const rspMapper = new Transform({
          transform (chunk, cb) {
            const rsp = new rpc.drive.messages.ReadStreamResponse()
            rsp.setChunk(chunk)
            return cb(null, rsp)
          }
        })

        pump(stream, rspMapper, call, err => {
          if (err) {
            log.error({ id, err }, 'createReadStream error')
            call.destroy(err)
          }
        })
      },

      readFile: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()

        if (!id) throw new Error('A readFile request must specify a session ID.')
        if (!path) throw new Error('A readFile request must specify a path.')
        const drive = this.driveForSession(id)

        const content = await new Promise((resolve, reject) => {
          drive.readFile(path, (err, content) => {
            if (err) return reject(err)
            return resolve(content)
          })
        })

        const chunks = toChunks(content)
        for (const chunk of chunks) {
          const rsp = new rpc.drive.messages.ReadFileResponse()
          rsp.setChunk(chunk)
          call.write(rsp)
        }
        call.end()
      },

      createWriteStream: async (call) => {
        const unpack = new Transform({
          transform (msg, cb) {
            const chunk = msg.getChunk()
            return cb(null, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
          }
        })

        return new Promise((resolve, reject) => {
          call.once('data', req => {
            const id = req.getId()
            const path = req.getPath()
            const opts = fromStat(req.getOpts())

            if (!id) throw new Error('A readFile request must specify a session ID.')
            if (!path) throw new Error('A readFile request must specify a path.')
            const drive = this.driveForSession(id)

            const stream = drive.createWriteStream(path, { mode: opts.mode, uid: opts.uid, gid: opts.gid, metadata: opts.metadata })

            return onstream(resolve, reject, stream)
          })
        })

        function onstream (resolve, reject, stream) {
          pump(call, unpack, stream, err => {
            if (err) return reject(err)
            const rsp = new rpc.drive.messages.WriteStreamResponse()
            return resolve(rsp)
          })
        }
      },

      writeFile: async (call) => {
        return new Promise((resolve, reject) => {
          call.once('data', req => {
            const id = req.getId()
            const path = req.getPath()
            const opts = fromStat(req.getOpts())

            if (!id) throw new Error('A writeFile request must specify a session ID.')
            if (!path) throw new Error('A writeFile request must specify a path.')
            const drive = this.driveForSession(id)

            return loadContent(resolve, reject, path, drive, opts)
          })
        })

        function loadContent (resolve, reject, path, drive, opts) {
          return collectStream(call, (err, reqs) => {
            if (err) return reject(err)
            const chunks = reqs.map(req => {
              const chunk = req.getChunk()
              return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            })
            return drive.writeFile(path, Buffer.concat(chunks), opts, err => {
              if (err) return reject(err)
              const rsp = new rpc.drive.messages.WriteFileResponse()
              return resolve(rsp)
            })
          })
        }
      },

      updateMetadata: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()
        const metadata = fromMetadata(call.request.getMetadataMap())

        if (!id) throw new Error('A metadata update request must specify a session ID.')
        if (!path) throw new Error('A metadata update request must specify a path.')
        if (!metadata) throw new Error('A metadata update request must specify metadata.')
        const drive = this.driveForSession(id)

        return new Promise((resolve, reject) => {
          drive._update(path, { metadata }, err => {
            if (err) return reject(err)
            return resolve(new rpc.drive.messages.UpdateMetadataResponse())
          })
        })
      },

      deleteMetadata: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()
        const keys = call.request.getKeysList()

        if (!id) throw new Error('A metadata update request must specify a session ID.')
        if (!path) throw new Error('A metadata update request must specify a path.')
        if (!keys) throw new Error('A metadata update request must specify metadata keys.')
        const drive = this.driveForSession(id)

        const metadata = {}
        for (const key of keys) {
          metadata[key] = null
        }

        return new Promise((resolve, reject) => {
          drive._update(path, { metadata }, err => {
            if (err) return reject(err)
            return resolve(new rpc.drive.messages.DeleteMetadataResponse())
          })
        })
      },

      stat: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()
        const lstat = call.request.getLstat()

        if (!id) throw new Error('A stat request must specify a session ID.')
        if (!path) throw new Error('A stat request must specify a path.')
        const drive = this.driveForSession(id)

        const method = lstat ? drive.lstat.bind(drive) : drive.stat.bind(drive)

        return new Promise((resolve, reject) => {
          method(path, (err, stat) => {
            if (err) return reject(err)

            const rsp = new rpc.drive.messages.StatResponse()
            rsp.setStat(toStat(stat))

            return resolve(rsp)
          })
        })
      },

      unlink: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()

        if (!id) throw new Error('An unlink request must specify a session ID.')
        if (!path) throw new Error('An unlink request must specify a path. ')
        const drive = this.driveForSession(id)

        return new Promise((resolve, reject) => {
          drive.unlink(path, err => {
            if (err) return reject(err)
            const rsp = new rpc.drive.messages.UnlinkResponse()
            return resolve(rsp)
          })
        })
      },

      readdir: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()
        const recursive = call.request.getRecursive()
        const noMounts = call.request.getNomounts()
        const includeStats = call.request.getIncludestats()

        if (!id) throw new Error('A readdir request must specify a session ID.')
        if (!path) throw new Error('A readdir request must specify a path.')
        const drive = this.driveForSession(id)

        return new Promise((resolve, reject) => {
          drive.readdir(path, { recursive, noMounts, includeStats }, (err, files) => {
            if (err) return reject(err)

            const rsp = new rpc.drive.messages.ReadDirectoryResponse()
            if (!includeStats) {
              rsp.setFilesList(files)
            } else {
              const names = []
              const stats = []
              const mounts = []
              const innerPaths = []
              for (const { name, stat, mount, innerPath } of files) {
                names.push(name)
                stats.push(toStat(stat))
                mounts.push(toMount(mount))
                innerPaths.push(innerPath)
              }
              rsp.setFilesList(names)
              rsp.setStatsList(stats)
              rsp.setMountsList(mounts)
              rsp.setInnerpathsList(innerPaths)
            }
            return resolve(rsp)
          })
        })
      },

      mkdir: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()
        const opts = fromStat(call.request.getOpts())

        if (!id) throw new Error('A mkdir request must specify a session ID.')
        if (!path) throw new Error('A mkdir request must specify a directory path.')
        const drive = this.driveForSession(id)

        const mkdirOpts = {}
        if (opts.uid) mkdirOpts.uid = opts.uid
        if (opts.gid) mkdirOpts.gid = opts.gid
        if (opts.mode) mkdirOpts.mode = opts.mode

        return new Promise((resolve, reject) => {
          drive.mkdir(path, mkdirOpts, err => {
            if (err) return reject(err)

            const rsp = new rpc.drive.messages.MkdirResponse()
            return resolve(rsp)
          })
        })
      },

      rmdir: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()

        if (!id) throw new Error('A rmdir request must specify a session ID.')
        if (!path) throw new Error('A rmdir request must specify a directory path.')
        const drive = this.driveForSession(id)

        return new Promise((resolve, reject) => {
          drive.rmdir(path, err => {
            if (err) return reject(err)

            const rsp = new rpc.drive.messages.RmdirResponse()
            return resolve(rsp)
          })
        })
      },

      mount: async (call) => {
        const id = call.request.getId()
        const mountInfo = call.request.getInfo()

        const path = mountInfo.getPath()
        const opts = fromMount(mountInfo.getOpts())

        if (!id) throw new Error('A mount request must specify a session ID.')
        if (!path) throw new Error('A mount request must specify a path.')
        if (!opts) throw new Error('A mount request must specify mount options.')
        const drive = this.driveForSession(id)

        return new Promise((resolve, reject) => {
          let error = null
          const mountListener = key => {
            if (!opts.key || key.equals(opts.key)) {
              this.removeListener('configured-mount', mountListener)
              if (error) return
              const rsp = new rpc.drive.messages.MountDriveResponse()
              return resolve(rsp)
            }
          }
          this.on('configured-mount', mountListener)
          drive.mount(path, opts.key, opts, err => {
            if (err) {
              error = err
              return reject(err)
            }
            if (opts.key && this._configuredMounts.has(opts.key.toString('hex'))) {
              return mountListener(opts.key)
            }
          })
        })
      },

      unmount: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()

        if (!id) throw new Error('An unmount request must specify a session ID.')
        if (!path) throw new Error('An unmount request must specify a path.')
        const drive = this.driveForSession(id)

        return new Promise((resolve, reject) => {
          drive.unmount(path, err => {
            if (err) return reject(err)
            const rsp = new rpc.drive.messages.UnmountDriveResponse()
            return resolve(rsp)
          })
        })
      },

      watch: async (call) => {
        const self = this
        var watcher = null
        var closed = false
        var driveWatchers = null
        var keyString = null

        call.once('data', req => {
          const id = req.getId()
          var path = req.getPath()

          if (!id) throw new Error('A watch request must specify a session ID.')
          if (!path) path = '/'
          const drive = this.driveForSession(id)
          keyString = drive.key.toString('hex')

          driveWatchers = this._watchers.get(keyString)
          if (!driveWatchers) {
            driveWatchers = []
            this._watchers.set(keyString, driveWatchers)
          }

          watcher = drive.watch(path, () => {
            const rsp = new rpc.drive.messages.WatchResponse()
            call.write(rsp)
          })

          const close = onclose.bind(null, id, path, driveWatchers)

          watcher.once('ready', subWatchers => {
            // Add one in order to include the root watcher.
            this._watchCount += subWatchers.length + 1
            if (this._watchCount > this.watchLimit) {
              return close('Watch limit reached. Please close watch connections then try again.')
            }
            driveWatchers.push(watcher)

            // Any subsequent messages are considered cancellations.
            call.on('data', close)
            call.on('close', close)
            call.on('finish', close)
            call.on('error', close)
            call.on('end', close)
          })
        })

        function onclose (id, path, driveWatchers, err) {
          if (closed) return
          closed = true
          log.debug({ id, path }, 'unregistering watcher')
          if (watcher) {
            watcher.destroy()
            if (watcher.watchers) self._watchCount -= (watcher.watchers.length + 1)
            driveWatchers.splice(driveWatchers.indexOf(watcher), 1)
            if (!driveWatchers.length) self._watchers.delete(keyString)
          }
          call.end()
        }
      },

      symlink: async (call) => {
        const id = call.request.getId()
        const target = call.request.getTarget()
        const linkname = call.request.getLinkname()

        if (!id) throw new Error('A symlink request must specify a session ID.')
        if (!target) throw new Error('A symlink request must specify a target.')
        if (!linkname) throw new Error('A symlink request must specify a linkname.')
        const drive = this.driveForSession(id)

        return new Promise((resolve, reject) => {
          drive.symlink(target, linkname, err => {
            if (err) return reject(err)

            const rsp = new rpc.drive.messages.SymlinkResponse()
            return resolve(rsp)
          })
        })
      },

      close: async (call) => {
        const id = call.request.getId()

        this.driveForSession(id)
        await this.closeSession(id)
        const rsp = new rpc.drive.messages.CloseSessionResponse()

        return rsp
      },

      fileStats: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()

        if (!id) throw new Error('A fileStats request must specify a session ID.')
        if (!path) throw new Error('A fileStats request must specify a path.')
        const drive = this.driveForSession(id)

        return new Promise((resolve, reject) => {
          drive.stats(path, (err, stats) => {
            if (err) return reject(err)

            if (!(stats instanceof Map)) {
              const fileStats = stats
              stats = new Map()
              stats.set(path, fileStats)
            }
            const rsp = new rpc.drive.messages.FileStatsResponse()
            setFileStats(rsp.getStatsMap(), stats)

            return resolve(rsp)
          })
        })
      },

      mounts: async (call) => {
        const id = call.request.getId()
        const memory = call.request.getMemory()
        const recursive = call.request.getRecursive()

        if (!id) throw new Error('A mounts request must specify a session ID.')
        const drive = this.driveForSession(id)

        return new Promise((resolve, reject) => {
          drive.getAllMounts({ memory, recursive }, (err, mounts) => {
            if (err) return reject(err)
            const rsp = new rpc.drive.messages.DriveMountsResponse()
            if (!mounts) return resolve(rsp)

            const mountsList = []
            for (const [path, { metadata }] of mounts) {
              mountsList.push(toMountInfo({
                path,
                opts: {
                  key: metadata.key,
                  version: metadata.version
                }
              }))
            }
            rsp.setMountsList(mountsList)
            return resolve(rsp)
          })
        })
      }
    }
  }
}

function collect (index, opts) {
  return new Promise((resolve, reject) => {
    collectStream(index.createReadStream(opts), (err, list) => {
      if (err) return reject(err)
      return resolve(list)
    })
  })
}

module.exports = DriveManager

const hyperdrive = require('hyperdrive')
const hypercoreCrypto = require('hypercore-crypto')
const datEncoding = require('dat-encoding')
const pump = require('pump')
const sub = require('subleveldown')
const bjson = require('buffer-json-encoding')
const collectStream = require('stream-collector')
const { NanoresourcePromise: Nanoresource } = require('nanoresource-promise/emitter')
const { Transform } = require('streamx')

const {
  fromHyperdriveOptions,
  fromStat,
  fromMount,
  fromMetadata,
  fromDriveConfiguration,
  fromNetworkConfiguration,
  toNetworkConfiguration,
  toHyperdriveOptions,
  toStat,
  toMount,
  toMountInfo,
  toDriveStats,
  toDiffEntry,
  setFileStats,
  toChunks
} = require('hyperdrive-daemon-client/lib/common')
const { rpc } = require('hyperdrive-daemon-client')

const ArrayIndex = require('./array-index')
const { dbCollect, dbGet } = require('../common')
const log = require('../log').child({ component: 'drive-manager' })

const TRIE_UPDATER_SYMBOL = Symbol('hyperdrive-daemon-trie-updater')

class DriveManager extends Nanoresource {
  constructor (corestore, networking, db, opts = {}) {
    super()

    this.corestore = corestore
    this.networking = networking
    this.db = db
    this.opts = opts
    this.watchLimit = opts.watchLimit
    this.memoryOnly = !!opts.memoryOnly

    const dbs = DriveManager.generateSubDbs(db)

    this._driveIndex = dbs.drives
    this._mirrorIndex = dbs.mirrors

    this._drives = new Map()
    this._checkouts = new Map()
    this._watchers = new Map()
    this._sessionsByKey = new Map()
    this._configuredMounts = new Set()
    this._sessions = new ArrayIndex()
    this._downloads = new ArrayIndex()
    this._mirrors = new Map()
    this._watchCount = 0
  }

  ready () {
    return this.open()
  }

  async _open () {
    return Promise.all([
      this._rejoin(),
      this._remirror()
    ])
  }

  async _rejoin () {
    if (this.noAnnounce) return
    const seedList = await dbCollect(this._seedIndex)
    for (const { key: discoveryKey, value: networkOpts } of seedList) {
      const opts = networkOpts && networkOpts.opts
      if (!opts || !opts.announce) continue
      this.networking.join(discoveryKey, { ...networkOpts.opts })
    }
  }

  async _remirror () {
    const mirrorList = await dbCollect(this._mirrorIndex)
    for (const { key } of mirrorList) {
      const drive = await this.get(key)
      await this._startMirroring(drive)
    }
  }

  _generateKeyString (key, opts) {
    var keyString = (key instanceof Buffer) ? key.toString('hex') : key
    if (opts && opts.version) keyString = keyString + '+' + opts.version
    if (opts && opts.hash) keyString = keyString + '+' + opts.hash
    return keyString
  }

  async _startMirroring (drive) {
    // A mirrored drive should never be closed.
    const { session: mirrorSession } = await this.createSession(drive)
    const unmirror = drive.mirror()
    const driveKey = drive.key.toString('hex')
    this._mirrors.set(driveKey, {
      session: mirrorSession,
      unmirror
    })
    // Only the key is relevant, but gets for valid keys shouldn't return null.
    await this._mirrorIndex.put(driveKey, 'mirroring')
    log.info({ discoveryKey: drive.discoveryKey.toString('hex') }, 'mirroring drive')
  }

  async _stopMirroring (drive) {
    const driveKey = drive.key.toString('hex')
    const mirrorInfo = this._mirrors.get(driveKey)
    if (!mirrorInfo) return null
    this._mirrors.delete(driveKey)
    mirrorInfo.unmirror()
    this.closeSession(mirrorInfo.session)
    return this._mirrorIndex.del(driveKey)
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

  async configureNetwork (discoveryKey, opts = {}) {
    const self = this
    const encodedKey = datEncoding.encode(discoveryKey)
    const networkOpts = {
      lookup: !!opts.lookup,
      announce: !!opts.announce,
    }
    const seeding = opts.lookup || opts.announce
    var networkingPromise

    const sameConfig = sameNetworkConfig(discoveryKey, opts)
    // If all the networking options are the same, exit early.
    if (sameConfig) return

    const networkConfig = { opts: networkOpts }
    if (seeding) await this._seedIndex.put(encodedKey, networkConfig)
    else await this._seedIndex.del(encodedKey)

    // Failsafe
    if (networkOpts.announce && this.noAnnounce) networkOpts.announce = false

    try {
      if (seeding) {
        networkingPromise = this.networking.join(discoveryKey, networkOpts)
      } else {
        networkingPromise = this.networking.leave(discoveryKey)
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

  async getNetworkConfiguration (discoveryKey) {
    const networkOpts = await dbGet(this._seedIndex, datEncoding.encode(discoveryKey))
    return networkOpts ? networkOpts.opts : null
  }

  async getAllNetworkConfigurations () {
    const storedConfigurations = (await dbCollect(this._seedIndex)).map(({ key, value }) => [key, value])
    return new Map(storedConfigurations)
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
    return dbCollect(this._driveIndex)
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
      const randomNamespace = hypercoreCrypto.randomBytes(32).toString('hex')
      drive = hyperdrive(this.corestore, key, {
        namespace: randomNamespace,
        ...driveOpts
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
      const parentConfig = (await this.getNetworkConfiguration(drive.discoveryKey)) || initialConfig || {}
      const existingMountConfig = (await this.getNetworkConfiguration(feed.discoveryKey)) || {}
      const mountConfig = {
        lookup: (existingMountConfig.lookup !== false) && (parentConfig.lookup !== false),
        announce: !!(existingMountConfig.announce || parentConfig.announce),
        remember: true
      }

      if (mountConfig) await this.configureNetwork(feed.discoveryKey, mountConfig)
      this.emit('configured-mount', feed.key)
      this._configuredMounts.add(mountKey)

      const existingConfig = await dbGet(this._driveIndex, mountKey)
      if (!existingConfig) await this._driveIndex.put(mountKey, mountInfo)
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

  download (drive, path) {
    const dl = drive.download(path)
    return this._downloads.insert(dl)
  }

  // RPC Methods
  async _rpcVersion (call) {
    const id = call.request.getId()

    if (!id) throw new Error('A version request must specify a session ID.')
    const drive = this.driveForSession(id)

    const rsp = new rpc.drive.messages.DriveVersionResponse()
    rsp.setVersion(drive.version)

    return rsp
  }

  async _rpcGet (call) {
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
  }

  async _rpcAllStats (call) {
    const networkingOnly = call.request.getNetworkingonly()
    var stats = await this.getAllStats({ networkingOnly })
    stats = stats.map(driveStats => toDriveStats(driveStats))

    const rsp = new rpc.drive.messages.StatsResponse()
    rsp.setStatsList(stats)

    return rsp
  }

  async _rpcAllNetworkConfigurations (call) {
    const networkConfigurations = await this.getAllNetworkConfigurations()

    const rsp = new rpc.drive.messages.NetworkConfigurationsResponse()
    rsp.setConfigurationsList([...networkConfigurations].map(([, value]) => toNetworkConfiguration({
      ...value.opts,
      key: Buffer.from(value.key, 'hex')
    })))

    return rsp
  }

  async _rpcPeerCounts (call) {
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
  }

  async _rpcConfigureNetwork (call) {
    const id = call.request.getId()

    if (!id) throw new Error('A network configuration request must specify a session ID.')
    const drive = this.driveForSession(id)
    const opts = fromNetworkConfiguration(call.request.getNetwork())

    await this.configureNetwork(drive.metadata.discoveryKey, { ...opts })

    const rsp = new rpc.drive.messages.ConfigureNetworkResponse()
    return rsp
  }

  async _rpcStats (call) {
    const id = call.request.getId()

    if (!id) throw new Error('A stats request must specify a session ID.')
    const drive = this.driveForSession(id)

    const recursive = call.request.getRecursive()
    const networkingOnly = call.request.getNetworkingonly()
    const driveStats = await this.getDriveStats(drive, { recursive, networkingOnly })
    const networkConfig = await this.networking.getConfiguration(drive.discoveryKey)

    const rsp = new rpc.drive.messages.DriveStatsResponse()
    rsp.setStats(toDriveStats(driveStats))
    if (networkConfig) rsp.setNetwork(toNetworkConfiguration(networkConfig))
    return rsp
  }

  async _rpcDownload (call) {
    const id = call.request.getId()
    const path = call.request.getPath()

    if (!id) throw new Error('A download request must specify a session ID.')
    const drive = this.driveForSession(id)
    const downloadId = this.download(drive, path)

    const rsp = new rpc.drive.messages.DownloadResponse()
    rsp.setDownloadid(downloadId)
    return rsp
  }

  async _rpcUndownload (call) {
    const id = call.request.getId()
    const downloadId = call.request.getDownloadid()

    if (!id) throw new Error('An undownload request must specify a session ID.')
    if (!downloadId) throw new Error('An undownload request must specify a download ID.')

    const dl = this._downloads.get(downloadId)
    if (dl) dl.destroy()
    this._downloads.delete(downloadId)

    return new rpc.drive.messages.UndownloadResponse()
  }

  async _rpcCreateDiffStream (call) {
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
  }

  async _rpcCreateReadStream (call) {
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
  }

  async _rpcReadFile (call) {
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
  }

  async _rpcCreateWriteStream (call) {
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
  }

  async _rpcWriteFile (call) {
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
  }

  async _rpcUpdateMetadata (call) {
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
  }

  async _rpcDeleteMetadata (call) {
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
  }

  async _rpcStat (call) {
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
  }

  async _rpcUnlink (call) {
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
  }

  async _rpcReaddir (call) {
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
  }

  async _rpcMkdir (call) {
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
  }

  async _rpcRmdir (call) {
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
  }

  async _rpcMount (call) {
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
  }

  async _rpcUnmount (call) {
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
  }

  async _rpcWatch (call) {
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
  }

  async _rpcSymlink (call) {
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
  }

  async _rpcClose (call) {
    const id = call.request.getId()

    this.driveForSession(id)
    await this.closeSession(id)
    const rsp = new rpc.drive.messages.CloseSessionResponse()

    return rsp
  }

  async _rpcFileStats (call) {
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
  }

  async _rpcMounts (call) {
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

DriveManager.generateSubDbs = function (db) {
  return {
    drives: sub(db, 'drives', { valueEncoding: 'bjson' }),
    mirrors: sub(db, 'mirrors', { valueEncoding: 'utf8' }),
    seeding: sub(db, 'seeding', { valueEncoding: 'json '})
  }
}

module.exports = DriveManager

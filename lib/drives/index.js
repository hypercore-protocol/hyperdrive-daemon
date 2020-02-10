const crypto = require('crypto')
const { EventEmitter } = require('events')

const hyperdrive = require('hyperdrive')
const sub = require('subleveldown')
const collectStream = require('stream-collector')
const bjson = require('buffer-json-encoding')
const datEncoding = require('dat-encoding')
const pump = require('pump')
const map = require('through2-map')

const {
  fromHyperdriveOptions,
  fromStat,
  fromMount,
  fromMetadata,
  fromNetworkConfiguration,
  toHyperdriveOptions,
  toStat,
  toMount,
  toDriveStats,
  toDownloadProgress,
  toDiffEntry,
  toNetworkConfiguration,
  setFileStats,
  toChunks
} = require('hyperdrive-daemon-client/lib/common')
const { rpc } = require('hyperdrive-daemon-client')
const ArrayIndex = require('./array-index.js')

const log = require('../log').child({ component: 'drive-manager' })

class DriveManager extends EventEmitter {
  constructor (corestore, networking, db, opts = {}) {
    super()

    this.corestore = corestore
    this.networking = networking
    this.db = db
    this.opts = opts
    this.watchLimit = opts.watchLimit
    this.noAnnounce = !!opts.noAnnounce

    this._driveIndex = sub(this.db, 'drives', { valueEncoding: bjson })
    this._seedIndex = sub(this.db, 'seeding', { valueEncoding: 'json' })
    this._namespaceIndex = sub(this.db, 'namespaces', { valueEncoding: 'utf8' })

    if (this.opts.stats) {
      this._statsIndex = sub(this.db, 'stats', { valueEncoding: 'json' })
      this._collecting = true
    }

    this._drives = new Map()
    this._checkouts = new Map()
    this._watchers = new Map()
    this._sessionsByKey = new Map()
    this._transientSeedIndex = new Map()
    this._sessions = new ArrayIndex()
    this._downloads = new ArrayIndex()
    this._watchCount = 0

    this._readyPromise = null

    this.ready = () => {
      if (this._readyPromise) return this._readyPromise
      this._readyPromise = new Promise(async resolve => {
        await this._reseed()
        return resolve()
      })
      return this._readyPromise
    }
  }

  async _reseed () {
    const driveList = await collect(this._seedIndex)
    for (const { key: discoveryKey, value: networkOpts } of driveList) {
      this.networking.seed(discoveryKey, networkOpts.opts)
    }
  }

  _updateStats (oldStats, drive) {
    // TODO: Gather stats from the drive
    return {}
  }

  _collectStats (key, drive) {
    setTimeout(async () => {
      // TODO: Store actual networking statistics.
      try {
        var oldStats = await this._statsIndex.get(key)
      } catch (err) {
        if (!err.notFound) this.emit('error', err)
        oldStats = {}
      }
      const updatedStats = this._updateStats(oldStats, drive)
      await this._statsIndex.put(key, updatedStats)
      if (this._collecting) this._collectStats(key, drive)
    }, this.opts.statsInterval || 2000)
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
    const driveSessions = this._sessionsByKey.get(driveKey)
    this._sessions.delete(id)
    driveSessions.splice(driveSessions.indexOf(id), 1)

    // TODO: Fix session management
    // All drives, once opened, will be kept open for now (this is a high-priority memory leak).
    // return null

    if (!driveSessions.length) {
      log.debug({ id, key: driveKey }, 'closing drive because all associated sessions have closed')
      this._sessionsByKey.delete(driveKey)
      const watchers = this._watchers.get(driveKey)
      if (watchers && watchers.length) {
        for (const watcher of watchers) {
          watcher.destroy()
        }
      }
      this._watchers.delete(driveKey)
      return new Promise((resolve, reject) => {
        drive.close(err => {
          if (err) return reject(err)
          this._drives.delete(driveKey)
          const checkouts = this._checkouts.get(driveKey)
          if (checkouts && checkouts.length) {
            for (const keyString of checkouts) {
              this._drives.delete(keyString)
            }
          }
          this._checkouts.delete(driveKey)
          log.debug({ id, key: driveKey }, 'closed drive and cleaned up any remaining watchers')
          return resolve()
        })
      })
    }
    return null
  }

  async getAllStats () {
    const allStats = []
    for (const [, drive] of this._drives) {
      const driveStats = await this.getDriveStats(drive)
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
      await new Promise(resolve => {
        core.update({ ifAvailable: true }, err => {
          return resolve()
        })
      })
      return {
        key: core.key,
        discoveryKey: core.discoveryKey,
        uploadedBytes: stats.totals.uploadedBytes,
        uploadedBlocks: stats.totals.uploadedBlocks,
        downloadedBytes: stats.totals.downloadedBytes,
        downloadedBlocks: core.downloaded(),
        totalBlocks: core.length,
        peerCount: core.peers.length,
        peers: core.peers.map(p => {
          return {
            ...p.stats,
            remoteAddress: p.remoteAddress,
          }
        })
      }
    }
  }

  listDrives () {
    return collect(this._driveIndex)
  }

  listSeedingDrives () {
    return collect(this._seedIndex)
  }

  async get (key, opts = {}) {
    log.debug({ key: key ? key.toString('hex') : null }, 'drive manager is getting a drive')
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

    if (!drive) {
      var namespace = await this._getNamespace(keyString)
      if (!namespace) namespace = await this._createNamespace(keyString)
      drive = hyperdrive(this.corestore, key, {
        ...driveOpts,
        namespace
      })
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

    if (opts.fuse) {
      // TODO: We shouldn't need to do any special configuration for FUSE drives or writable drives.
      // Ensure that there is always a session open for any FUSE-accessed drive so that it's not GC'd.
      // await this.createSession(drive, null)
    } else if (!drive.writable) {
      // TODO: All read-only drives are currently both lookup/announce for now. (Beaker requirement)
      await this.configureNetwork(drive, { lookup: true, announce: !this.noAnnounce, remember: true })
    }
    if (this.opts.stats) {
      this._collectStats(drive)
    }

    // Make sure that any inner mounts are recorded in the drive index.
    drive.on('mount', async (feed, mountInfo) => {
      log.info({ key: feed.key.toString('hex'), mount: mountInfo }, 'registering mountpoint in drive index')
      try {
        await this._driveIndex.get(key)
      } catch (err) {
        if (err && !err.notFound) log.error({ error: err }, 'error registering mountpoint in drive index')
        try {
          await this._driveIndex.put(key, mountInfo)
        } catch (err) {
          log.error({ error: err }, 'could not register mountpoint in drive index')
        }
      }
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

  async configureNetwork (drive, opts) {
    const encodedKey = datEncoding.encode(drive.discoveryKey)
    const networkOpts = {
      lookup: !!opts.lookup,
      announce: !!opts.announce,
      remember: !!opts.remember
    }
    const seeding = opts.lookup || opts.announce
    if (seeding) {
      this.networking.seed(drive.discoveryKey, networkOpts)
    } else {
      this.networking.unseed(drive.discoveryKey)
    }
    if (opts.remember) {
      if (seeding) await this._seedIndex.put(encodedKey, { key: datEncoding.encode(drive.key), opts: networkOpts })
      else await this._seedIndex.del(encodedKey)
    } else {
      this._transientSeedIndex.set(encodedKey, networkOpts)
    }
  }

  async getNetworkConfiguration (drive) {
    const encodedKey = datEncoding.encode(drive.discoveryKey)
    let networkOpts = this._transientSeedIndex.get(encodedKey)
    if (networkOpts) return networkOpts

    let persistentOpts = await this._seedIndex.get(encodedKey)
    if (!persistentOpts) return null
    return persistentOpts.opts
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
        driveOpts.version = drive.version
        driveOpts.writable = drive.writable

        const rsp = new rpc.drive.messages.GetDriveResponse()
        rsp.setId(session)
        rsp.setOpts(toHyperdriveOptions(driveOpts))

        return rsp
      },

      allStats: async (call) => {
        var stats = await this.getAllStats()
        stats = stats.map(driveStats => toDriveStats(driveStats))

        const rsp = new rpc.drive.messages.StatsResponse()
        rsp.setStatsList(stats)

        return rsp
      },

      configureNetwork: async (call) => {
        const id = call.request.getId()

        if (!id) throw new Error('A network configuration request must specify a session ID.')
        const drive = this.driveForSession(id)
        const opts = fromNetworkConfiguration(call.request.getNetwork())

        await this.configureNetwork(drive, opts)

        const rsp = new rpc.drive.messages.ConfigureNetworkResponse()
        return rsp
      },

      stats: async (call) => {
        const id = call.request.getId()

        if (!id) throw new Error('A stats request must specify a session ID.')
        const drive = this.driveForSession(id)

        const recursive = call.request.getRecursive()
        const driveStats = await this.getDriveStats(drive, { recursive })
        const networkConfig = await this.getNetworkConfiguration(drive)

        const rsp = new rpc.drive.messages.DriveStatsResponse()
        rsp.setStats(toDriveStats(driveStats))
        rsp.setNetwork(toNetworkConfiguration(networkConfig))
        return rsp
      },

      download: async (call) => {
        const self = this
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
        const drive = this.driveForSession(id)

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

        const rspMapper = map.obj(chunk => {
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

          return rsp
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

        if (!id) throw new Error('A readFile request must specify a session ID.')
        if (!path) throw new Error('A readFile request must specify a path.')
        const drive = this.driveForSession(id)

        const streamOpts = {}
        if (end !== 0) streamOpts.end = end
        if (length !== 0) streamOpts.length = length
        streamOpts.start = start

        const stream = drive.createReadStream(path, streamOpts)

        const rspMapper = map.obj(chunk => {
          const rsp = new rpc.drive.messages.ReadStreamResponse()
          rsp.setChunk(chunk)
          return rsp
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
          pump(call, map.obj(chunk => Buffer.from(chunk.getChunk())), stream, err => {
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
            const chunks = reqs.map(req => Buffer.from(req.getChunk()))
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
              for (let { name, stat, mount, innerPath } of files) {
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

      unlink: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()

        if (!id) throw new Error('An unlink request must specify a session ID.')
        if (!path) throw new Error('An unlink request must specify a path.')
        const drive = this.driveForSession(id)

        return new Promise((resolve, reject) => {
          drive.unlink(path, err => {
            if (err) return reject(err)

            const rsp = new rpc.drive.messages.UnlinkResponse()
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
          drive.mount(path, opts.key, opts, err => {
            if (err) return reject(err)
            const rsp = new rpc.drive.messages.MountDriveResponse()
            return resolve(rsp)
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
          if (err) log.error({ id, path, err }, 'watch stream errored')
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

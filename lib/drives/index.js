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
  toHyperdriveOptions,
  fromStat,
  toStat,
  fromMount,
  toDriveStats,
  toChunks
} = require('hyperdrive-daemon-client/lib/common')
const { rpc } = require('hyperdrive-daemon-client')

const log = require('../log').child({ component: 'drive-manager' })

class DriveManager extends EventEmitter {
  constructor (corestore, networking, db, opts) {
    super()

    this.corestore = corestore
    this.networking = networking
    this.db = db
    this.opts = opts || {}

    this._driveIndex = sub(this.db, 'drives', { valueEncoding: bjson })
    this._seedIndex = sub(this.db, 'seeding', { valueEncoding: 'utf8' })

    if (this.opts.stats) {
      this._statsIndex = sub(this.db, 'stats', { valueEncoding: 'json' })
      this._collecting = true
    }

    // TODO: Replace with an LRU cache.
    this._drives = new Map()
    this._sessions = new Map()
    this._watchers = new Map()
    this._sessionCounter = 0

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
    for (const { key: discoveryKey } of driveList) {
      this.networking.seed(discoveryKey)
    }
  }

  _configureDrive (drive, opts) {
    // TODO: Extract this into a separate, easily-modifiable script.
    return new Promise((resolve, reject) => {
      drive.readFile('.key', err => {
        if (err && !err.errno === 2) return reject(err)
        if (err) return configure()
        return resolve(0)
      })

      function configure () {
        drive.writeFile('.key', drive.key.toString('hex'), { uid: process.getuid(), gid: process.getgid() }, err => {
          if (err) return reject(err)
          if (opts && opts.rootDrive) {
            return drive.mkdir('/home', { uid: process.getuid(), gid: process.getgid() }, err => {
              if (err) return reject(err)
              return resolve(err)
            })
          } else {
            return resolve()
          }
        })
      }
    })
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

  driveForSession (sessionId) {
    const drive = this._sessions.get(sessionId)
    if (!drive) throw new Error('Session does not exist.')
    return drive
  }

  async createSession (key, opts) {
    const drive = await this.get(key, opts)
    this._sessions.set(++this._sessionCounter, drive)
    return { drive, session: this._sessionCounter }
  }

  async closeSession (id) {
    this._sessions.delete(id)
  }

  async getAllStats () {
    const allStats = []
    for (const [, drive] of this._drives) {
      const driveStats = await this.getDriveStats(drive)
      allStats.push(driveStats)
    }
    return allStats
  }

  async getDriveStats (drive) {
    const mounts = await new Promise((resolve, reject) => {
      drive.getAllMounts({ memory: true }, (err, mounts) => {
        if (err) return reject(err)
        return resolve(mounts)
      })
    })
    const stats = []

    for (const [path, { metadata, content }] of mounts) {
      stats.push({
        path,
        metadata: getCoreStats(metadata),
        content: getCoreStats(content)
      })
    }

    return stats

    function getCoreStats (core) {
      const stats = core.stats
      return {
        key: core.key,
        peers: stats.peers.length,
        uploadedBytes: stats.totals.uploadedBytes,
        downloadedBytes: stats.totals.downloadedBytes
        // TODO: Store comulative totals across restarts
      }
    }
  }

  async get (key, opts) {
    key = (key instanceof Buffer) ? datEncoding.decode(key) : key
    var keyString = this._generateKeyString(key, opts)

    if (key) {
      // TODO: cache checkouts
      const existing = this._drives.get(keyString)
      if (existing) return existing
    }

    const driveOpts = {
      ...opts,
      sparse: opts.sparse !== false,
      sparseMetadata: opts.sparseMetadata !== false
    }
    const drive = hyperdrive(this.corestore, key, driveOpts)
    await new Promise((resolve, reject) => {
      drive.ready(err => {
        if (err) return reject(err)
        return resolve()
      })
    })

    key = datEncoding.encode(drive.key)
    keyString = this._generateKeyString(key, opts)

    if (drive.writable) {
      await this._configureDrive(drive, opts && opts.configure)
    } else {
      // All read-only drives are currently published by default.
      await this.publish(drive)
    }
    if (this.opts.stats) {
      this._collectStats(drive)
    }

    // TODO: This should all be in one batch.
    await Promise.all([
      this._driveIndex.put(key, driveOpts)
    ])
    this._drives.set(key, drive)

    return drive
  }

  publish (drive) {
    const encodedKey = datEncoding.encode(drive.discoveryKey)
    this.networking.seed(drive.discoveryKey)
    return this._seedIndex.put(encodedKey, '')
  }

  unpublish (drive) {
    const encodedKey = datEncoding.encode(drive.discoveryKey)
    this.networking.unseed(drive.discoveryKey)
    return this._seedIndex.del(encodedKey)
  }

  getHandlers () {
    return {
      get: async (call) => {
        var driveOpts = call.request.getOpts()
        if (driveOpts) driveOpts = fromHyperdriveOptions(driveOpts)

        const { drive, session } = await this.createSession(driveOpts.key, driveOpts)
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

      publish: async (call) => {
        const id = call.request.getId()

        if (!id) throw new Error('A publish request must specify a session ID.')
        const drive = this.driveForSession(id)

        await this.publish(drive)

        const rsp = new rpc.drive.messages.PublishDriveResponse()
        return rsp
      },

      unpublish: async (call) => {
        const id = call.request.getId()

        if (!id) throw new Error('An unpublish request must specify a session ID.')
        const drive = this.driveForSession(id)

        await this.unpublish(drive)

        const rsp = new rpc.drive.messages.UnpublishDriveResponse()
        return rsp
      },

      stats: async (call) => {
        const id = call.request.getId()

        if (!id) throw new Error('A stats request must specify a session ID.')
        const drive = this.driveForSession(id)

        const stats = await this.getDriveStats(drive)

        const rsp = new rpc.drive.messages.DriveStatsResponse()
        rsp.setStats(toDriveStats(stats))
        return rsp
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
          if (err) log.error({ id, err }, 'createReadStream error')
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

            const stream = drive.createWriteStream(path, { mode: opts.mode, uid: opts.uid, gid: opts.gid })

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

            if (!id) throw new Error('A writeFile request must specify a session ID.')
            if (!path) throw new Error('A writeFile request must specify a path.')
            const drive = this.driveForSession(id)

            return loadContent(resolve, reject, path, drive)
          })
        })

        function loadContent (resolve, reject, path, drive) {
          return collectStream(call, (err, reqs) => {
            if (err) return reject(err)
            const chunks = reqs.map(req => Buffer.from(req.getChunk()))
            return drive.writeFile(path, Buffer.concat(chunks), err => {
              if (err) return reject(err)
              const rsp = new rpc.drive.messages.WriteFileResponse()
              return resolve(rsp)
            })
          })
        }
      },

      stat: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()
        const lstat = call.request.getLstat()

        if (!id) throw new Error('A stat request must specify a session ID.')
        if (!path) throw new Error('A stat request must specify a path. ')
        const drive = this.driveForSession(id)

        return new Promise((resolve, reject) => {
          drive.stat(path, { followLink: lstat }, (err, stat) => {
            if (err) return reject(err)

            const rsp = new rpc.drive.messages.StatResponse()
            rsp.setStat(toStat(stat))

            return resolve(rsp)
          })
        })
      },

      readdir: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()
        const recursive = call.request.getRecursive()

        if (!id) throw new Error('A readdir request must specify a session ID.')
        if (!path) throw new Error('A readdir request must specify a path.')
        const drive = this.driveForSession(id)

        return new Promise((resolve, reject) => {
          drive.readdir(path, { recursive }, (err, files) => {
            if (err) return reject(err)

            const rsp = new rpc.drive.messages.ReadDirectoryResponse()
            rsp.setFilesList(files)

            return resolve(rsp)
          })
        })
      },

      mkdir: async (call) => {
        const id = call.request.getId()
        const path = call.request.getPath()
        const mode = call.request.getMode()

        if (!id) throw new Error('A mkdir request must specify a session ID.')
        if (!path) throw new Error('A mkdir request must specify a directory path.')
        const drive = this.driveForSession(id)

        return new Promise((resolve, reject) => {
          drive.mkdir(path, mode, err => {
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
        var watcher = null

        call.once('data', req => {
          const id = req.getId()
          var path = req.getPath()

          if (!id) throw new Error('A watch request must specify a session ID.')
          if (!path) path = '/'
          const drive = this.driveForSession(id)

          watcher = drive.watch(path, () => {
            const rsp = new rpc.drive.messages.WatchResponse()
            call.write(rsp)
          })

          // Any subsequent messages are considered cancellations.
          const close = onclose.bind(id, path)
          call.on('data', close)
          call.on('close', close)
          call.on('finish', close)
          call.on('error', close)
        })

        var closed = false
        function onclose (id, path, err) {
          if (closed) return
          closed = true
          if (watcher) watcher.destroy()
          log.debug({ id, path }, 'unregistering watcher')
          if (err) log.error({ id, path, err }, 'watch stream errored')
          call.end()
        }
      },

      close: async (call) => {
        const id = call.request.getId()

        this.driveForSession(id)
        this.closeSession(id)
        const rsp = new rpc.drive.messages.CloseSessionResponse()

        return rsp
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

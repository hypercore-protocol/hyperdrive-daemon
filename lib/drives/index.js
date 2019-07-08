const crypto = require('crypto')
const { EventEmitter } = require('events')

const hyperdrive = require('hyperdrive')
const sub = require('subleveldown')
const collectStream = require('stream-collector')
const bjson = require('buffer-json-encoding')
const datEncoding = require('dat-encoding')

const {
  fromHyperdriveOptions,
  toHyperdriveOptions,
  fromStat,
  toStat,
  toMount,
  fromMount
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

    this._ready = new Promise(async resolve => {
      await this._reseed()
      return resolve()
    })
    this.ready = () => this._ready
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
        drive.writeFile('.key', drive.key.toString('hex'), err => {
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

  // TODO: Retrieving stats from managed hyperdrives is trickier with corestores/mounts.
  // - The megastore should be responsible for optionally maintaining networking stats (by corestore) in its db
  // - hypermount should maintain the mapping from hyperdrive to corestore
  async list () {
    const drives = this.rootDrive.list()
    const statList = []

    // TODO: This will not scale to a huge number of drives

    return new Promise((resolve, reject) => {
      const result = {}
      const stream = this.db.createReadStream()
      stream.on('data', ({ key: mnt, value: record }) => {
        const entry = result[record.key] = { mnt }
        const drive = this.drives.get(record.key)
        entry.networking = {
          metadata: {
            ...drive.metadata.stats,
            peers: drive.metadata.peers.length
          },
          content: drive.content && {
            ...drive.content.stats,
            peers: drive.content.peers.length
          }
        }
      })
      stream.on('end', () => {
        return resolve(result)
      })
      stream.on('error', reject)
    })
  }
}

function createDriveHandlers (driveManager) {
  return {
    get: async (call) => {
      var driveOpts = call.request.getOpts()
      if (driveOpts) driveOpts = fromHyperdriveOptions(driveOpts)

      const { drive, session } = await driveManager.createSession(driveOpts.key, driveOpts)
      driveOpts.key = drive.key
      driveOpts.version = drive.version

      const rsp = new rpc.drive.messages.GetDriveResponse()
      rsp.setId(session)
      rsp.setOpts(toHyperdriveOptions(driveOpts))

      return rsp
    },

    publish: async (call) => {
      const id = call.request.getId()

      if (!id) throw new Error('A publish request must specify a session ID.')
      const drive = driveManager.driveForSession(id)

      await driveManager.publish(drive)

      const rsp = new rpc.drive.messages.PublishDriveResponse()
      return rsp
    },

    unpublish: async (call) => {
      const id = call.request.getId()

      if (!id) throw new Error('An unpublish request must specify a session ID.')
      const drive = driveManager.driveForSession(id)

      await driveManager.unpublish(drive)

      const rsp = new rpc.drive.messages.UnpublishDriveResponse()
      return rsp
    },

    readFile: async (call) => {
      const id = call.request.getId()
      const path = call.request.getPath()

      if (!id) throw new Error('A readFile request must specify a session ID.')
      if (!path) throw new Error('A writeFile request must specify a path.')
      const drive = driveManager.driveForSession(id)

      return new Promise((resolve, reject) => {
        drive.readFile(path, (err, content) => {
          if (err) return reject(err)

          const rsp = new rpc.drive.messages.ReadFileResponse()
          rsp.setContent(content)

          return resolve(rsp)
        })
      })
    },

    writeFile: async (call) => {
      const id = call.request.getId()
      const path = call.request.getPath()
      const contents = Buffer.from(call.request.getContent())

      if (!id) throw new Error('A writeFile request must specify a session ID.')
      if (!path) throw new Error('A writeFile request must specify a path.')
      if (!contents) throw new Error('A writeFile request must specify contents.')
      const drive = driveManager.driveForSession(id)

      return new Promise((resolve, reject) => {
        drive.writeFile(path, contents, (err) => {
          if (err) return reject(err)
          const rsp = new rpc.drive.messages.WriteFileResponse()
          return resolve(rsp)
        })
      })
    },

    stat: async (call) => {
      const id = call.request.getId()
      const path = call.request.getPath()
      const lstat = call.request.getLstat()

      if (!id) throw new Error('A stat request must specify a session ID.')
      if (!path) throw new Error('A stat request must specify a path. ')
      const drive = driveManager.driveForSession(id)

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
      const drive = driveManager.driveForSession(id)

      return new Promise((resolve, reject) => {
        drive.readdir(path, { recursive }, (err, files) => {
          if (err) return reject(err)

          const rsp = new rpc.drive.messages.ReadDirectoryResponse()
          rsp.setFilesList(files)

          return resolve(rsp)
        })
      })
    },

    mount: async (call) => {
      const id = call.request.getId()
      const path = call.request.getPath()
      const opts = fromMount(call.request.getOpts())

      if (!id) throw new Error('A mount request must specify a session ID.')
      if (!path) throw new Error('A mount request must specify a path.')
      if (!opts) throw new Error('A mount request must specify mount options.')
      const drive = driveManager.driveForSession(id)

      return new Promise((resolve, reject) => {
        drive.mount(path, opts.key, opts, err => {
          if (err) return reject(err)
          const rsp = new rpc.drive.messages.MountDriveResponse()
          return resolve(rsp)
        })
      })
    },

    watch: async (call) => {

    },

    listen: async (call) => {

    },

    unwatch: async (call) => {

    },

    close: async (call) => {
      const id = call.request.getId()

      const drive = driveManager.driveForSession(id)
      driveManager.closeSession(id)
      const rsp = new rpc.drive.messages.CloseSessionResponse()

      return rsp
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

module.exports = {
  DriveManager,
  createDriveHandlers
}

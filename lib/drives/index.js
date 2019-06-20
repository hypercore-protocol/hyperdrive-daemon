const crypto = require('crypto')
const { EventEmitter } = require('events')

const hyperdrive = require('hyperdrive')
const sub = require('subleveldown')
const collect = require('stream-collector')
const datEncoding = require('dat-encoding')

const { fromHyperdriveOptions, toHyperdriveOptions } = require('hyperdrive-daemon-client/lib/common')
const log = require('../log').child({ component: 'drive-manager' })

class DriveManager extends EventEmitter {
  constructor (megastore, db, opts) {
    super()

    this.megastore = megastore
    this.db = db
    this.opts = opts || {}

    this._driveIndex = sub(this.db, 'drives', { valueEncoding: 'json' })
    this._nameIndex = sub(this.db, 'names', { valueEncoding: 'utf8' })

    if (this.opts.stats) {
      this._statsIndex = sub(this.db, 'stats', { valueEncoding: 'json' })
      this._collecting = true
    }

    // TODO: Replace with an LRU cache.
    this._drives = new Map()
    // TODO: Any ready behavior here?
    this.ready = () => Promise.resolve()
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
            drive.mkdir('/home', { uid: process.getuid(), gid: process.getgid() }, err => {
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

  _generateName (key) {
    if (key) return key
    // TODO: check collisions
    return crypto.randomBytes(64).toString('hex')
  }

  _generateKeyString (key, opts) {
    var keyString = (key instanceof Buffer) ? key.toString('hex') : key
    if (opts && opts.version) keyString = keyString + '+' + opts.version
    if (opts && opts.hash) keyString = keyString + '+' + opts.hash
    return keyString
  }

  async get (key, opts) {
    key = (key instanceof Buffer) ? datEncoding.decode(key) : key
    const keyString = this._generateKeyString(key, opts)
    var newDrive = false

    if (key) {
      // TODO: cache checkouts
      const existing = this._drives.get(keyString)
      if (existing) return existing
      try {
        var name = await this._nameIndex.get(key)
      } catch (err) {
        if (!err.notFound) throw err
        // If a name was not found for this key, then the drive is not writable and must be synced.
        name = this._generateName(key)
        newDrive = true
      }
    } else {
      name = this._generateName()
      newDrive = true
    }

    const corestore = this.megastore.get(name, { ...this.opts, ...opts })
    const driveOpts = {
      ...opts,
      sparse: opts.sparse !== false,
      sparseMetadata: opts.sparseMetadata !== false
    }
    const drive = hyperdrive(corestore, key, driveOpts)

    await new Promise((resolve, reject) => {
      drive.ready(err => {
        if (err) return reject(err)
        return resolve()
      })
    })
    key = datEncoding.encode(drive.key)

    if (drive.writable) {
      await this._configureDrive(drive, opts && opts.configure)
    }
    if (newDrive && this.opts.stats) {
      this._collectStats(drive)
    }

    // TODO: This should all be in one batch.
    await Promise.all([
      this._nameIndex.put(key, name),
      this._driveIndex.put(key, driveOpts)
    ])
    this._drives.set(keyString, drive)

    return drive
  }

  async publish (drive) {
    return this.megastore.seed(drive.discoveryKey)
  }

  async unpublish (drive) {
    return this.megastore.unseed(drive.discoveryKey)
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

      const drive = await driveManager.get(driveOpts.key, driveOpts)
      driveOpts.key = drive.key
      driveOpts.version = drive.version

      const rsp = new rpc.drive.messages.GetResponse()
      rsp.setOpts(driveOpts)

      return rsp
    }
  }
}

module.exports = {
  DriveManager,
  createDriveHandlers
}

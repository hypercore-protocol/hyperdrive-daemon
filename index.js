const p = require('path')

const corestore = require('corestore')
const hyperdrive = require('hyperdrive')
const hyperfuse = require('hyperdrive-fuse')
const express = require('express')
const level = require('level')
const through = require('through2')
const pump = require('pump')
const mkdirp = require('mkdirp')
const collect = require('collect-stream')
const argv = require('yargs').argv

const hypercore = require('hypercore')

const { loadMetadata } = require('./lib/metadata')

class Hypermount {
  constructor (store, db) {
    this.store = store
    this.db = db
    this.drives = new Map()
  }

  ready () {
    return this.store.ready()
  }

  async mount (key, mnt, opts) {
    if (typeof opts === 'function') return this.mount(key, mnt, null, opts)
    opts = opts || {}

    const factory = (key, coreOpts) => {
      coreOpts.seed = (opts.seed !== undefined) ? opts.seed : true
      return this.store.get(key, coreOpts)
    }

    const drive = hyperdrive(factory, key, {
      ...opts,
      factory: true,
      sparse: (opts.sparse !== undefined) ? opts.sparse : true,
      sparseMetadata: (opts.sparseMetadata !== undefined) ? opts.sparseMetadata : true
    })

    const mountInfo = await hyperfuse.mount(drive, mnt, {
      force: true,
      displayFolder: true
    })
    await this.db.put(mnt, {
      ...opts,
      key: mountInfo.key,
      mnt
    })
    this.drives.set(mountInfo.key, drive)

    return mountInfo.key
  }

  unmount (mnt) {
    return hyperfuse.unmount(mnt)
  }

  close () {
    return this.store.close()
  }

  async unmount (mnt) {
    let record = await this.db.get(mnt)
    if (!record) return
    await hyperfuse.unmount(mnt)
  }

  unmountAll () {
    return new Promise((resolve, reject) => {
      pump(
        this.db.createReadStream(),
        through.obj(({ key, value: record }, enc, cb) => {
          let unmountPromise = this.unmount(key)
          unmountPromise.then(() => cb(null))
          unmountPromise.catch(err => cb(err))
        }),
        err => {
          if (err) return reject(err)
          return resolve()
        }
      )
    })
  }

  refreshMounts () {
    return new Promise((resolve, reject) => {
      pump(
        this.db.createReadStream(),
        through.obj(({ key, value: record }, enc, cb) => {
          const mountPromise = this.mount(record.key, key, record)
          mountPromise.then(() => cb(null))
          mountPromise.catch(cb)
        }),
        err => {
          if (err) return reject(err)
          return resolve()
        }
      )
    })
  }

  list () {
    return new Promise((resolve, reject) => {
      const result = {}
      const stream = this.db.createReadStream()
      stream.on('data', ({ key: mnt, value: record }) => {
        const entry = result[record.key] = { mnt }
        const drive = this.drives.get(record.key)
        entry.networking = {
          metadata: drive.metadata.stats,
          content: drive.content && drive.content.stats
        }
      })
      stream.on('end', () => {
        return resolve(result)
      })
      stream.on('error', reject)
    })
  }

  async cleanup () {
    await this.unmountAll()
    await this.store.close()
    await this.db.close()
  }
}

function bindRoutes (app, metadata, hypermount, cleanup) {
  app.use(express.json())
  app.use((req, res, next) => {
    if (!req.headers.authorization) return res.sendStatus(403)
    if (!req.headers.authorization === `Bearer ${metadata.token}`) return res.sendStatus(403)
    return next()
  })

  app.post('/mount', async (req, res) => {
    try {
      let { key, mnt } = req.body
      key = await hypermount.mount(key, mnt, req.body)
      return res.status(201).json({ key, mnt })
    } catch (err) {
      return res.sendStatus(500)
    }
  })

  app.post('/unmount', async (req, res) => {
    try {
      const mnt = req.body.mnt
      await hypermount.unmount(mnt)
      return res.sendStatus(200)
    } catch (err) {
      return res.sendStatus(500)
    }
  })

  app.post('/close', async (req, res) => {
    try {
      await cleanup()
      res.sendStatus(200)
      process.exit(0)
    } catch (err) {
      return res.sendStatus(500)
    }
  })

  app.get('/status', async (req, res) => {
    return res.sendStatus(200)
  })

  app.get('/list', async (req, res) => {
    try {
      let result = await hypermount.list()
      return res.json(result)
    } catch (err) {
      return res.sendStatus(500)
    }
  })
}

async function start () {
  const metadata = await loadMetadata()
  const storageRoot = argv.storage || './storage'

  await (() => {
    return new Promise((resolve, reject) => {
      mkdirp(storageRoot, err => {
        if (err) return reject(err)
        return resolve()
      })
    })
  })()

  const store = corestore(p.join(storageRoot, 'cores'), {
    network: {
      port: argv.replicationPort || 3006
    }
  })
  const db = level(p.join(storageRoot, 'db'), {
    valueEncoding: 'json'
  })
  const hypermount = new Hypermount(store, db)
  const app = express()

  await hypermount.ready()
  await hypermount.refreshMounts()

  bindRoutes(app, metadata, hypermount, cleanup)
  var server = app.listen(argv.port || 3005)

  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
  process.once('unhandledRejection', cleanup)
  process.once('uncaughtException', cleanup)

  async function cleanup () {
    await hypermount.cleanup()
    server.close()
  }
}


if (require.main === module) {
  start()
}

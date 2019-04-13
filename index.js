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

const { loadMetadata } = require('./lib/metadata')

const Status = {
  UNMOUNTED: 0,
  MOUNTED: 1
}

class Hypermount {
  constructor (store) {
    this.store = store
  }

  mount (key, mnt, opts) {
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

    return hyperfuse.mount(drive, mnt)
  }

  unmount (mnt) {
    return hyperfuse.unmount(mnt)
  }

  close () {
    return this.store.close()
  }
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
  const hypermount = new Hypermount(store)
  const app = express()

  app.use(express.json())
  app.use((req, res, next) => {
    if (!req.headers.authorization) return res.sendStatus(403)
    if (!req.headers.authorization === `Bearer ${metadata.token}`) return res.sendStatus(403)
    return next()
  })

  app.post('/mount', async (req, res) => {
    try {
      console.log('req.body:', req.body)
      let { key, mnt } = req.body
      key = await mount(hypermount, db, key, mnt, req.body)
      return res.status(201).json({ key, mnt })
    } catch (err) {
      console.error('Mount error:', err)
      return res.sendStatus(500)
    }
  })

  app.post('/unmount', async (req, res) => {
    try {
      const mnt = req.body.mnt
      await unmount(hypermount, db, mnt)

      return res.sendStatus(200)
    } catch (err) {
      console.error('Unmount error:', err)
      return res.sendStatus(500)
    }
  })

  app.post('/close', async (req, res) => {
    try {
      await cleanup()
      res.sendStatus(200)
    } catch (err) {
      console.error('Close error:', err)
      return res.sendStatus(500)
    }
  })

  app.get('/status', async (req, res) => {
    return res.sendStatus(200)
  })

  app.get('/list', async (req, res) => {
    try {
      let result = await list(db)
      return res.json(result)
    } catch (err) {
      console.error('List error:', err)
      return res.sendStatus(500)
    }
  })

  await store.ready()
  await refreshMounts(hypermount, db)

  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)

  var server = app.listen(argv.port || 3005)

  async function cleanup () {
    await unmountAll(hypermount, db)
    await store.close()
    await db.close()
    server.close()
  }
}

function list (db) {
  return new Promise((resolve, reject) => {
    const result = {}
    const stream = db.createReadStream()
    stream.on('data', ({ key: mnt, value: record }) => {
      result[record.key] = mnt
    })
    stream.on('end', () => {
      return resolve(result)
    })
    stream.on('error', reject)
  })
}

async function mount (hypermount, db, key, mnt, opts) {
  let { key: mountedKey } = await hypermount.mount(key, mnt, opts)

  await db.put(mnt, {
    ...opts,
    key: mountedKey,
    mnt,
    status: Status.MOUNTED
  })

  return mountedKey
}

async function unmount (hypermount, db, mnt) {
  await hypermount.unmount(mnt)

  let record = await db.get(mnt)
  if (!record) return
  record.status = Status.UNMOUNTED

  await db.put(mnt, record)
}

function unmountAll (hypermount, db) {
  return new Promise((resolve, reject) => {
    pump(
      db.createReadStream(),
      through.obj(({ key, value: record }, enc, cb) => {
        if (record.status === Status.MOUNTED) {
          console.log('UNMOUNTING in unmountAll:', key)
          let unmountPromise = unmount(hypermount, db, key)
          unmountPromise.then(() => cb(null))
          unmountPromise.catch(err => cb(err))
        } else {
          return cb(null)
        }
      }),
      err => {
        if (err) return reject(err)
        return resolve()
      }
    )
  })
}

function refreshMounts (hypermount, db) {
  return new Promise((resolve, reject) => {
    pump(
      db.createReadStream(),
      through.obj(({ key, value: record }, enc, cb) => {
        if (record.status === Status.UNMOUNTED) {
          const mountPromise = mount(hypermount, db, record.key, key, record)
          mountPromise.then(() => cb(null))
          mountPromise.catch(cb)
        } else {
          return cb(null)
        }
      }),
      err => {
        if (err) return reject(err)
        return resolve()
      }
    )
  })
}

if (require.main === module) {
  start()
}

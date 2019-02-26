const datEncoding = require('dat-encoding')
const corestore = require('corestore')
const hyperdrive = require('hyperdrive')
const hyperfuse = require('hyperdrive-fuse')
const express = require('express')
const level = require('level')
const argv = require('yargs').argv

const { loadMetadata } = require('./lib/metadata')

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
  const store = corestore(argv.storage || './storage', {
    network: {
      port: argv.replicationPort || 3006
    }
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
      let { key, mnt } = await hypermount.mount(req.body.key, req.body.mnt, req.body)
      return res.status(201).json({ key, mnt })
    } catch (err) {
      console.error('Mount error:', err)
      return res.sendStatus(500)
    }
  })
  app.post('/unmount', async (req, res) => {
    try {
      await hypermount.unmount(req.body.mnt)
      return res.sendStatus(200)
    } catch (err) {
      console.error('Unmount error:', err)
      return res.sendStatus(500)
    }
  })
  app.post('/close', async (req, res) => {
    try {
      await store.close()
      server.close()
      return res.sendStatus(200)
    } catch (err) {
      console.error('Close error:', err)
      return res.sendStatus(500)
    }
  })
  app.get('/status', async (req, res) => {
    return res.sendStatus(200)
  })

  await store.ready()
  var server = app.listen(argv.port || 3005)
}

if (require.main === module) {
  start()
}

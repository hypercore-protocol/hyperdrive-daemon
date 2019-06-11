const p = require('path')
const { EventEmitter } = require('events')

const mkdirp = require('mkdirp')
const raf = require('random-access-file')
const level = require('level')
const sub = require('subleveldown')
const argv = require('yargs').argv
const grpc = require('grpc')
const { rpc, loadMetadata } = require('hyperdrive-daemon-client')

const Megastore = require('megastore')
const SwarmNetworker = require('megastore-swarm-networking')

const { DriveManager, createDriveHandlers } = require('./lib/drives')
const { catchErrors, serverError, requestError } = require('./lib/errors')

try {
  var hyperfuse = require('hyperdrive-fuse')
  var { FuseManager, createFuseHandlers } = require('./lib/fuse')
} catch (err) {
  console.warn('FUSE bindings are not available on this platform.')
}
const log = require('./lib/log').child({ component: 'server' })

class HyperdriveDaemon extends EventEmitter {
  constructor (storage, opts = {}) {
    super()

    this.db = level(`${storage}/db`, { valueEncoding: 'json' })
    this.opts = opts

    const megastoreOpts = {
      storage: path => raf(`${storage}/cores/${path}`),
      db: sub(this.db, 'megastore'),
      networker: new SwarmNetworker(opts.network)
    }
    this.megastore = new Megastore(megastoreOpts.storage, megastoreOpts.db , megastoreOpts.networker)
    this.drives = new DriveManager(this.megastore, sub(this.db, 'drives'), this.opts)
    this.fuse = hyperfuse ? new FuseManager(this.megastore, this.drives, sub(this.db, 'fuse'), this.opts) : null

    this.drives.on('error', err => this.emit('error', err))
    this.fuse.on('error', err => this.emit('error', err))

    this._isClosed = false
    this._isReady = false

    this.ready = () => {
      if (this._isReady) return Promise.resolve()
      return this._ready()
    }
  }

  _ready () {
    return Promise.all([
      this.db.open(),
      this.megastore.ready(),
      this.drives.ready(),
      this.fuse ? this.fuse.ready() : Promise.resolve()
    ]).then(() => {
      this._ready = true
    })
  }

  close () {
    if (this._isClosed) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.megastore.close(err => {
      if (err) return reject(err)
        this._isClosed = true
        return resolve()
      })
    })
  }

  async cleanup () {
    await this.unmountRoot()
    await this.megastore.close()
    await this.db.close()
  }
}

async function start () {
  const metadata = await new Promise((resolve, reject) => {
    loadMetadata((err, metadata) => {
      if (err) return reject(err)
      return resolve(metadata)
    })
  })
  const storageRoot = argv.storage
  await ensureStorage()

  const hypermount = new HyperdriveDaemon(storageRoot)
  await hypermount.ready()

  const server = new grpc.Server();
  if (hyperfuse) {
    server.addService(rpc.fuse.services.FuseService, {
      ...authenticate(metadata, catchErrors(createFuseHandlers(this.fuseManager)))
    })
  }
  server.addService(rpc.drive.services.DriveService, {
    ...authenticate(metadata, catchErrors(createDriveHandlers(this.driveManager)))
  })
  server.addService(rpc.main.services.HyperdriveService, {
    ...authenticate(metadata, catchErrors(createMainHandlers(this)))
  })

  console.log('binding server...')
  server.bind(`0.0.0.0:${argv.port}`, grpc.ServerCredentials.createInsecure())
  server.start()
  console.log('server started.')

  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
  process.once('unhandledRejection', cleanup)
  process.once('uncaughtException', cleanup)

  async function cleanup () {
    await hypermount.close()
    server.tryDestroy()
  }

  function ensureStorage () {
    return new Promise((resolve, reject) => {
      mkdirp(storageRoot, err => {
        if (err) return reject(err)
        return resolve()
      })
    })
  }
}

function authenticate (metadata, methods) {
  const authenticated = {}
  for (const methodName of Object.keys(methods)) {
    const method = methods[methodName]
    authenticated[methodName] = function (call, ...args) {
      const cb = args[args.length - 1]
      const token = call.metadata && call.metadata.token
      if (!token || !token.equals(metadata.token)) {
        const err = {
          code: grpc.status.UNAUTHENTICATED,
          message: 'Invalid auth token.'
        }
        if (cb) return cb(err)
        return call.destroy(err)
      }

      return method(call, ...args)
    }
  }
  return authenticated
}

function createMainHandlers (daemon) {
  return {
    stop: async (call) => {
      await daemon.cleanup()
      return new rpc.main.messages.StopResponse()
    },

    status: async (call) => {
      return new rpc.main.messages.StatusResponse()
    }
  }
}

if (require.main === module) {
  start()
}

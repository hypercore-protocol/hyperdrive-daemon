const p = require('path')
const { EventEmitter } = require('events')

const mkdirp = require('mkdirp')
const raf = require('random-access-file')
const level = require('level')
const sub = require('subleveldown')
const grpc = require('grpc')

const { rpc, loadMetadata } = require('hyperdrive-daemon-client')
const corestore = require('random-access-corestore')
const SwarmNetworker = require('corestore-swarm-networking')

const { DriveManager, createDriveHandlers } = require('./lib/drives')
const { catchErrors, serverError, requestError } = require('./lib/errors')

try {
  var hyperfuse = require('hyperdrive-fuse')
  var { FuseManager, createFuseHandlers } = require('./lib/fuse')
} catch (err) {
  console.warn('FUSE bindings are not available on this platform.')
}
const log = require('./lib/log').child({ component: 'server' })

const argv = extractArguments()

class HyperdriveDaemon extends EventEmitter {
  constructor (storage, opts = {}) {
    super()

    this.db = level(`${storage}/db`, { valueEncoding: 'json' })
    this.opts = opts

    const dbs = {
      fuse: sub(this.db, 'fuse', { valueEncoding: 'json' }),
      drives: sub(this.db, 'drives', { valueEncoding: 'json' })
    }

    const corestoreOpts = {
      storage: path => raf(`${storage}/cores/${path}`),
      sparse: true
    }
    this.corestore = corestore(corestoreOpts.storage, corestoreOpts)
    // The root corestore should be bootstrapped with an empty default feed.
    this.corestore.default()

    this.networking = new SwarmNetworker(this.corestore, opts.network)
    this.drives = new DriveManager(this.corestore, this.networking, dbs.drives, this.opts)
    this.fuse = hyperfuse ? new FuseManager(this.megastore, this.drives, dbs.fuse, this.opts) : null

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
      this.networking.listen(),
      this.drives.ready(),
      this.fuse ? this.fuse.ready() : Promise.resolve()
    ]).then(() => {
      this._ready = true
    })
  }

  async close () {
    if (this._isClosed) return Promise.resolve()
    if (this.networking) await this.networking.close()
    this._isClosed = true
  }

  async cleanup () {
    if (this.fuse && this.fuse.fuseConfigured) await this.fuse.unmount()
    await this.megastore.close()
    await this.db.close()
  }
}

module.exports = async function start (opts = {}) {
  const metadata = await new Promise((resolve, reject) => {
    loadMetadata((err, metadata) => {
      if (err) return reject(err)
      return resolve(metadata)
    })
  })
  const storageRoot = opts.storage || argv.storage
  await ensureStorage()

  const daemonOpts = {}
  const bootstrapOpts = opts.bootstrap || argv.bootstrap
  if (bootstrapOpts.length) {
    if (bootstrapOpts === false && bootstrapOpts[0] === 'false') {
      daemonOpts.network = { bootstrap: false }
    } else {
      daemonOpts.network = { bootstrap: bootstrapOpts }
    }
  }
  const daemon = new HyperdriveDaemon(storageRoot, daemonOpts)
  await daemon.ready()

  const server = new grpc.Server();
  if (hyperfuse) {
    server.addService(rpc.fuse.services.FuseService, {
      ...wrap(metadata, createFuseHandlers(daemon.fuse), { authenticate: true })
    })
  }
  server.addService(rpc.drive.services.DriveService, {
    ...wrap(metadata, createDriveHandlers(daemon.drives), { authenticate: true })
  })
  server.addService(rpc.main.services.HyperdriveService, {
    ...wrap(metadata, createMainHandlers(server, daemon), { authenticate: true })
  })


  const port = opts.port || argv.port
  server.bind(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure())
  server.start()
  log.info({ port: port }, 'server listening')

  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
  process.once('unhandledRejection', cleanup)
  process.once('uncaughtException', cleanup)

  return cleanup

  async function cleanup () {
    await daemon.close()
    server.forceShutdown()
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

function extractArguments () {
  return require('yargs')
    .options({
      bootstrap: {
        array: true,
        default: []
      },
      storage: {
        string: true
      },
      port: {
        number: true
      }
    })
    .argv
}

function wrap (metadata, methods) {
  const promisified = promisify(methods)
  let authenticated = authenticate(metadata, methods)
}

function wrap (metadata, methods, opts) {
  const wrapped = {}
  const authenticate = opts && opts.authenticate
  for (const methodName of Object.keys(methods)) {
    const method = methods[methodName]
    wrapped[methodName] = function (call, ...args) {
      const tag = { method: methodName, received: Date.now() }
      const cb = args.length ? args[args.length - 1] : null
      if (authenticate) {
        let token = call.metadata && call.metadata.get('token')
        if (token) token = token[0]
        log.trace({ ...tag, token }, 'received token')
        if (!token || token !== metadata.token) {
          log.error(tag, 'request authentication failed')
          const err = {
            code: grpc.status.UNAUTHENTICATED,
            message: 'Invalid auth token.'
          }
          if (cb) return cb(err)
          return call.destroy(err)
        }
        log.debug(tag, 'request authentication succeeded')
      }
      method(call)
        .then(rsp => {
          log.debug(tag, 'request was successful')
          if (cb) return cb(null, rsp)
        })
        .catch(err => {
          log.error({ ...tag, error: err.toString(), stack: err.stack }, 'request failed')
          if (cb) return cb(serverError(err))
          return call.destroy(err)
        })
    }
  }
  return wrapped
}

function createMainHandlers (server, daemon) {
  return {
    stop: async (call) => {
      await daemon.cleanup()
      setTimeout(() => {
        console.error('Daemon is exiting.')
        server.forceShutdown()
        process.exit(0)
      }, 250)
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

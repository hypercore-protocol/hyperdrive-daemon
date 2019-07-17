const p = require('path')
const os = require('os')
const { EventEmitter } = require('events')

const mkdirp = require('mkdirp')
const raf = require('random-access-file')
const level = require('level')
const sub = require('subleveldown')
const grpc = require('@grpc/grpc-js')
const corestore = require('corestore')
const SwarmNetworker = require('corestore-swarm-networking')

const { rpc, loadMetadata } = require('hyperdrive-daemon-client')
const constants = require('hyperdrive-daemon-client/lib/constants')

const DriveManager = require('./lib/drives')
const { catchErrors, serverError, requestError } = require('./lib/errors')

try {
  var hyperfuse = require('hyperdrive-fuse')
  var FuseManager = require('./lib/fuse')
} catch (err) {
  console.warn('FUSE bindings are not available on this platform.')
}
const log = require('./lib/log').child({ component: 'server' })

const STOP_EVENTS = ['SIGINT', 'SIGTERM', 'unhandledRejection', 'uncaughtException']

class HyperdriveDaemon extends EventEmitter {
  constructor (opts = {}) {
    super()

    this.opts = opts
    this.storage = opts.storage || constants.storage
    this.port = opts.port || constants.port

    this.db = level(`${this.storage}/db`, { valueEncoding: 'json' })
    const dbs = {
      fuse: sub(this.db, 'fuse', { valueEncoding: 'json' }),
      drives: sub(this.db, 'drives', { valueEncoding: 'json' })
    }

    const corestoreOpts = {
      storage: path => raf(`${this.storage}/cores/${path}`),
      sparse: true,
      // Collect networking statistics.
      stats: true
    }
    this.corestore = corestore(corestoreOpts.storage, corestoreOpts)
    // The root corestore should be bootstrapped with an empty default feed.
    this.corestore.default()

    const bootstrapOpts = opts.bootstrap || constants.bootstrap
    if (bootstrapOpts && bootstrapOpts.length && bootstrapOpts[0] !== '') {
      if (bootstrapOpts === false && bootstrapOpts[0] === 'false') {
        var networkOpts = { bootstrap: false }
      } else {
        networkOpts = { bootstrap: bootstrapOpts }
      }
    }
    this.networking = new SwarmNetworker(this.corestore, networkOpts)

    this.drives = new DriveManager(this.corestore, this.networking, dbs.drives, this.opts)
    this.fuse = hyperfuse ? new FuseManager(this.megastore, this.drives, dbs.fuse, this.opts) : null
    // Set in start.
    this.server = null
    this._cleanup = null

    this.drives.on('error', err => this.emit('error', err))
    this.fuse.on('error', err => this.emit('error', err))

    this._isClosed = false
    this._isReady = false

    this.ready = () => {
      if (this._isReady) return Promise.resolve()
      return this._ready()
    }
  }

  async _ready () {
    await this._loadMetadata()
    await this._ensureStorage()

    this._cleanup = this.stop.bind(this)
    for (const event of STOP_EVENTS) {
      process.once(event, this._cleanup)
    }

    return Promise.all([
      this.db.open(),
      this.networking.listen(),
      this.drives.ready(),
      this.fuse ? this.fuse.ready() : Promise.resolve()
    ]).then(() => {
      this._ready = true
    })
  }

  async _loadMetadata () {
    this.metadata = this.opts.metadata || await new Promise((resolve, reject) => {
      loadMetadata((err, metadata) => {
        if (err) return reject(err)
        return resolve(metadata)
      })
    })
  }

  _ensureStorage () {
    return new Promise((resolve, reject) => {
      mkdirp(this.storage, err => {
        if (err) return reject(err)
        return resolve()
      })
    })
  }

  createMainHandlers () {
    return {
      stop: async (call) => {
        await this.close()
        setTimeout(() => {
          console.error('Daemon is exiting.')
          this.server.forceShutdown()
        }, 250)
        return new rpc.main.messages.StopResponse()
      },

      status: async (call) => {
        return new rpc.main.messages.StatusResponse()
      }
    }
  }

  async stop () {
    if (this._isClosed) return Promise.resolve()

    if (this.fuse && this.fuse.fuseConfigured) await this.fuse.unmount()
    if (this.networking) await this.networking.close()
    if (this.server) this.server.forceShutdown()
    await this.db.close()

    for (const event of STOP_EVENTS) {
      process.removeListener(event, this._cleanup)
    }

    this._isClosed = true
  }

  async start () {
    await this.ready()
    this.server = new grpc.Server()

    if (hyperfuse) {
      this.server.addService(rpc.fuse.services.FuseService, {
        ...wrap(this.metadata, this.fuse.getHandlers(), { authenticate: true })
      })
    }
    this.server.addService(rpc.drive.services.DriveService, {
      ...wrap(this.metadata, this.drives.getHandlers(), { authenticate: true })
    })
    this.server.addService(rpc.main.services.HyperdriveService, {
      ...wrap(this.metadata, this.createMainHandlers(), { authenticate: true })
    })

    await new Promise((resolve, reject) => {
      this.server.bindAsync(`0.0.0.0:${this.port}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
        if (err) return reject(err)
        log.info({ port: port }, 'server listening')
        this.server.start()
        return resolve()
      })
    })


    async function close () {
      await this.close()
    }
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

if (require.main === module) {
  const opts = extractArguments()
  const daemon = new HyperdriveDaemon(opts)
  daemon.start()
} else {
  module.exports = HyperdriveDaemon
}

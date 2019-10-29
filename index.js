const { EventEmitter } = require('events')

const mkdirp = require('mkdirp')
const raf = require('random-access-file')
const level = require('level')
const sub = require('subleveldown')
const grpc = require('@grpc/grpc-js')
const Corestore = require('corestore')
const SwarmNetworker = require('corestore-swarm-networking')

const { rpc, loadMetadata } = require('hyperdrive-daemon-client')
const constants = require('hyperdrive-daemon-client/lib/constants')

const DriveManager = require('./lib/drives')
const ProfilesManager = require('./lib/profiles')
const { serverError } = require('./lib/errors')

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

    const corestoreOpts = {
      storage: path => raf(`${this.storage}/cores/${path}`),
      sparse: true,
      // Collect networking statistics.
      stats: true
    }
    this.corestore = new Corestore(corestoreOpts.storage, corestoreOpts)

    const bootstrapOpts = opts.bootstrap || constants.bootstrap
    if (bootstrapOpts && bootstrapOpts.length && bootstrapOpts[0] !== '') {
      if (bootstrapOpts === false && bootstrapOpts[0] === 'false') {
        var networkOpts = { bootstrap: false }
      } else {
        networkOpts = { bootstrap: bootstrapOpts }
      }
    }

    // TODO: Remove when channel deduping is in place.
    networkOpts.maxPeers = 500

    this.networking = new SwarmNetworker(this.corestore, networkOpts)

    // Set in ready.
    this.db = null
    this.drives = null
    this.fuse = null

    // Set in start.
    this.server = null
    this._isMain = !!opts.main
    this._cleanup = null

    this._isClosed = false
    this._readyPromise = false

    this.ready = () => {
      if (this._isClosed) return Promise.resolve()
      if (this._readyPromise) return this._readyPromise
      this._readyPromise = this._ready()
      return this._readyPromise
    }
  }

  async _ready () {
    await this._loadMetadata()
    await this._ensureStorage()

    this._cleanup = this.stop.bind(this)
    for (const event of STOP_EVENTS) {
      process.once(event, this._cleanup)
    }

    this.networking.listen()

    this.db = level(`${this.storage}/db`, { valueEncoding: 'json' })
    const dbs = {
      fuse: sub(this.db, 'fuse', { valueEncoding: 'json' }),
      drives: sub(this.db, 'drives', { valueEncoding: 'json' }),
      profiles: sub(this.db, 'profiles', { valueEncoding: 'json' })
    }
    this.drives = new DriveManager(this.corestore, this.networking, dbs.drives, this.opts)
    //this.profiles = new ProfilesManager(this.drives, this.opts)
    this.fuse = hyperfuse ? new FuseManager(this.drives, dbs.fuse, this.opts) : null
    this.drives.on('error', err => this.emit('error', err))
    if (this.fuse) this.fuse.on('error', err => this.emit('error', err))

    await Promise.all([
      this.drives.ready(),
      this.fuse ? this.fuse.ready() : Promise.resolve()
    ])

    this._isReady = true
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
        await this.stop()
        setTimeout(() => {
          console.error('Daemon is exiting.')
          this.server.forceShutdown()
          if (this._isMain) process.exit(0)
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
    if (this.server) this.server.forceShutdown()

    if (this.fuse && this.fuse.fuseConfigured) await this.fuse.unmount()
    if (this.networking) await this.networking.close()
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
          if (cb) process.nextTick(cb, null, rsp)
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
  const daemon = new HyperdriveDaemon({ ...opts, main: true })
  daemon.start()
} else {
  module.exports = HyperdriveDaemon
}

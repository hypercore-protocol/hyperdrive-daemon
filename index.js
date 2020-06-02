const p = require('path')
const { EventEmitter } = require('events')

const mkdirp = require('mkdirp')
const sub = require('subleveldown')
const grpc = require('@grpc/grpc-js')
const bjson = require('buffer-json-encoding')
const processTop = require('process-top')
const Corestore = require('corestore')
const HypercoreCache = require('hypercore-cache')
const SwarmNetworker = require('corestore-swarm-networking')
const HypercoreProtocol = require('hypercore-protocol')
const Peersockets = require('peersockets')

const { rpc, apiVersion } = require('hyperdrive-daemon-client')
const { createMetadata } = require('./lib/metadata')
const constants = require('hyperdrive-daemon-client/lib/constants')

const DriveManager = require('./lib/drives')
const PeersocketManager = require('./lib/peersockets')
const PeersManager = require('./lib/peers')
const DebugManager = require('./lib/debug')
const FuseManager = require('./lib/fuse')
const { serverError } = require('./lib/errors')

const log = require('./lib/log').child({ component: 'server' })

const NAMESPACE = 'hyperdrive-daemon'
const STOP_EVENTS = ['SIGINT', 'SIGTERM', 'unhandledRejection', 'uncaughtException']
const WATCH_LIMIT = 300
const MAX_PEERS = 128
const SWARM_PORT = 49737

const TOTAL_CACHE_SIZE = 1024 * 1024 * 512
const CACHE_RATIO = 0.5
const TREE_CACHE_SIZE = TOTAL_CACHE_SIZE * CACHE_RATIO
const DATA_CACHE_SIZE = TOTAL_CACHE_SIZE * (1 - CACHE_RATIO)

// This is set dynamically in refreshFuse.
try {
  var hyperfuse = require('hyperdrive-fuse')
} catch (err) {}

class HyperdriveDaemon extends EventEmitter {
  constructor (opts = {}) {
    super()

    this.opts = opts
    this.root = opts.storage || constants.root
    this.storage = p.join(this.root, 'storage')

    this.port = opts.port || constants.port
    this.memoryOnly = !!opts.memoryOnly
    this.noAnnounce = !!opts.noAnnounce
    this.noDebug = !!opts.noDebug

    log.info('memory only?', this.memoryOnly, 'no announce?', this.noAnnounce)
    this._storageProvider = this.memoryOnly ? require('random-access-memory') : require('hypercore-default-storage')
    this._dbProvider = this.memoryOnly ? require('level-mem') : require('level')

    const corestoreOpts = {
      storage: path => this._storageProvider(`${this.storage}/cores/${path}`),
      sparse: true,
      // Collect networking statistics.
      stats: true,
      cache: {
        data: new HypercoreCache({
          maxByteSize: DATA_CACHE_SIZE,
          estimateSize: val => val.length
        }),
        tree: new HypercoreCache({
          maxByteSize: TREE_CACHE_SIZE,
          estimateSize: val => 40
        })
      },
      ifAvailable: true
    }
    this.corestore = new Corestore(corestoreOpts.storage, corestoreOpts)

    this._networkOpts = {
      announceLocalAddress: true,
      preferredPort: opts.swarmPort || SWARM_PORT,
      maxPeers: opts.maxPeers || MAX_PEERS
    }
    const bootstrapOpts = opts.bootstrap || constants.bootstrap
    if (bootstrapOpts && bootstrapOpts.length && bootstrapOpts[0] !== '') {
      if (bootstrapOpts === false || bootstrapOpts[0] === 'false') {
        this._networkOpts.bootstrap = false
      } else {
        this._networkOpts.bootstrap = bootstrapOpts
      }
    }
    if (opts.latency !== undefined) this._networkOpts.latency = +opts.latency

    // Set in ready.
    this.networking = null
    this.db = null
    this.drives = null
    this.fuse = null
    this.peersockets = null
    this.debug = null
    this.metadata = null
    this._startTime = null

    // Set in start.
    this.server = null
    this._topTimer = null
    this._dbs = null
    this._isMain = !!opts.main
    this._cleanup = null

    this._isClosed = false
    this._readyPromise = false

    this._versions = null

    this.ready = () => {
      if (this._isClosed) return Promise.resolve()
      if (this._readyPromise) return this._readyPromise
      this._readyPromise = this._ready()
      return this._readyPromise.catch(err => {
        log.error({ error: err, stack: err.stack }, 'error in daemon ready function -- cleaning up')
        return this.stop(err)
      })
    }
  }

  async _ready () {
    // Always rotate the auth token when the daemon's restarted to prevent session mismatches.
    this.metadata = this.opts.metadata || await createMetadata(this.root, `localhost:${this.port}`)
    await this._ensureStorage()

    this._cleanup = this.stop.bind(this)
    for (const event of STOP_EVENTS) {
      process.on(event, this._cleanup)
    }

    this.db = this._dbProvider(`${this.storage}/db`, { valueEncoding: 'json' })
    const dbs = {
      fuse: sub(this.db, 'fuse', { valueEncoding: bjson }),
      drives: sub(this.db, 'drives', { valueEncoding: bjson }),
      profiles: sub(this.db, 'profiles', { valueEncoding: 'json' })
    }
    this._dbs = dbs

    await this.corestore.ready()

    const seed = this.corestore._deriveSecret(NAMESPACE, 'replication-keypair')
    const swarmId = this.corestore._deriveSecret(NAMESPACE, 'swarm-id')
    this._networkOpts.keyPair = HypercoreProtocol.keyPair(seed)
    this._networkOpts.id = swarmId

    this.networking = new SwarmNetworker(this.corestore, this._networkOpts)
    this.networking.on('replication-error', err => {
      log.trace({ error: err.message, stack: err.stack }, 'replication error')
      if (err.message && err.message.indexOf('Remote signature could not be verified') !== -1) {
        log.warn('Remote signature verification is failing -- one of your hypercores appears to be forked or corrupted.')
      }
    })
    this.networking.on('stream-opened', stream => {
      log.trace({ remoteType: stream.remoteType, remoteAddress: stream.remoteAddress }, 'replication stream opened')
    })
    this.networking.on('stream-closed', stream => {
      log.trace({ remoteType: stream.remoteType, remoteAddress: stream.remoteAddress }, 'replication stream closed')
    })
    await this.networking.listen()

    // Register the Hyperswarm timeout heuristics on all cores generated by our corestore.
    this._registerCoreTimeouts()

    const peersockets = new Peersockets(this.networking)
    this.peers = new PeersManager(this.networking, peersockets)
    this.peersockets = new PeersocketManager(this.networking, this.peers, peersockets)
    if (!this.noDebug) this.debug = new DebugManager(this)

    this.drives = new DriveManager(this.corestore, this.networking, dbs.drives, {
      ...this.opts,
      memoryOnly: this.memoryOnly,
      watchLimit: this.opts.watchLimit || WATCH_LIMIT
    })
    this.drives.on('error', err => this.emit('error', err))
    await this.drives.ready()

    this.fuse = new FuseManager(this.drives, this._dbs.fuse, this.opts)
    this.fuse.on('error', err => this.emit('error', err))
    await this.fuse.ready()

    this._isReady = true
    this._startTime = Date.now()
    this._versions = {
      daemon: require('./package.json').version,
      client: require('hyperdrive-daemon-client/package.json').version,
      schema: require('hyperdrive-schemas/package.json').version,
      hyperdrive: require('hyperdrive/package.json').version
    }
    if (this.fuse && this.fuse.fuseConfigured) {
      this._versions.fuseNative = require('fuse-native/package.json').version
      this._versions.hyperdriveFuse = require('hyperdrive-fuse/package.json').version
    }
  }

  _ensureStorage () {
    return new Promise((resolve, reject) => {
      mkdirp(this.storage, err => {
        if (err) return reject(err)
        return resolve()
      })
    })
  }

  /**
   * This is where we define our main heuristic for allowing hypercore gets/updates to proceed.
   */
  _registerCoreTimeouts () {
    const flushSets = new Map()

    this.networking.on('flushed', dkey => {
      const keyString = dkey.toString('hex')
      if (!flushSets.has(keyString)) return
      const { flushSet, peerAddSet } = flushSets.get(keyString)
      callAllInSet(flushSet)
      callAllInSet(peerAddSet)
    })

    this.corestore.on('feed', core => {
      const discoveryKey = core.discoveryKey
      const peerAddSet = new Set()
      const flushSet = new Set()
      var globalFlushed = false

      this.networking.swarm.flush(() => {
        if (this.networking.joined(discoveryKey)) return
        globalFlushed = true
        callAllInSet(flushSet)
        callAllInSet(peerAddSet)
      })

      flushSets.set(discoveryKey.toString('hex'), { flushSet, peerAddSet })
      core.once('peer-add', () => callAllInSet(peerAddSet))

      const timeouts = {
        get: (cb) => {
          if (this.networking.joined(discoveryKey)) {
            if (this.networking.flushed(discoveryKey)) return cb()
            return flushSet.add(cb)
          }
          if (globalFlushed) return cb()
          return flushSet.add(cb)
        },
        update: (cb) => {
          if (core.peers.length) return cb()
          if (this.networking.joined(discoveryKey)) {
            if (this.networking.flushed(discoveryKey) && !core.peers.length) return cb()
            return peerAddSet.add(cb)
          }
          if (globalFlushed) return cb()
          return peerAddSet.add(cb)
        }
      }
      core.timeouts = timeouts
    })
  }

  createMainHandlers () {
    return {
      status: async call => {
        const rsp = new rpc.main.messages.StatusResponse()
        rsp.setApiversion(apiVersion)
        rsp.setUptime(Date.now() - this._startTime)
        if (this._versions) {
          rsp.setDaemonversion(this._versions.daemon)
          rsp.setClientversion(this._versions.client)
          rsp.setSchemaversion(this._versions.schema)
          rsp.setHyperdriveversion(this._versions.hyperdrive)
          rsp.setNoisekey(this.noiseKeyPair.publicKey)

          const swarm = this.networking && this.networking.swarm
          if (swarm) {
            const remoteAddress = swarm.remoteAddress()
            rsp.setHolepunchable(swarm.holepunchable())
            rsp.setRemoteaddress(remoteAddress ? remoteAddress.host + ':' + remoteAddress.port : '')
          }

          if (this._versions.fuseNative) rsp.setFusenativeversion(this._versions.fuseNative)
          if (this._versions.hyperdriveFuse) rsp.setHyperdrivefuseversion(this._versions.hyperdriveFuse)

          if (hyperfuse) {
            rsp.setFuseavailable(true)
            rsp.setFuseconfigured(this.fuse.fuseConfigured)
          } else {
            rsp.setFuseavailable(false)
            rsp.setFuseconfigured(false)
          }
        }
        return rsp
      },
      refreshFuse: async call => {
        await this.fuse.ready()
        if (this.fuse && this.fuse.fuseConfigured) {
          hyperfuse = require('hyperdrive-fuse')
          this._versions.fuseNative = require('fuse-native/package.json').version
          this._versions.hyperdriveFuse = require('hyperdrive-fuse/package.json').version
        }
        return new rpc.main.messages.FuseRefreshResponse()
      }
    }
  }

  get uptime () {
    if (!this._startTime) return 0
    return Date.now() - this._startTime
  }

  get noiseKeyPair () {
    if (!this.networking) return null
    return this.networking.keyPair
  }

  async stop (err) {
    // Couldn't tell you why these propagate as uncaughtExceptions (gRPC is a PITA), but we should ignore them.
    if (err && ((err.code === 1) || (err.code === 'ERR_HTTP2_INVALID_STREAM'))) return
    if (err) log.error({ error: true, err, message: err.message, stack: err.stack, errno: err.errno }, 'stopping daemon due to error')
    if (this._isClosed) {
      log.info('force killing the process because stop has been called twice')
      if (this._isMain) return process.exit(0)
      return null
    }
    this._isClosed = true

    try {
      if (this._topTimer) {
        clearInterval(this._topTimer)
        this._topTimer = null
      }
      if (this.server) this.server.forceShutdown()
      log.info('waiting for fuse to unmount')
      if (this.fuse && this.fuse.fuseConfigured) await this.fuse.unmount()
      log.info('waiting for networking to close')
      if (this.networking) await this.networking.close()
      log.info('waiting for corestore to close')
      if (this.corestore) {
        await new Promise((resolve, reject) => {
          this.corestore.close(err => {
            if (err) return reject(err)
            return resolve()
          })
        })
      }
      log.info('waiting for db to close')
      if (this.db) await this.db.close()
      if (this._isMain) return process.exit(0)
    } catch (err) {
      log.error({ error: err.message, stack: err.stack }, 'error in cleanup')
      if (this._isMain) return process.exit(1)
      throw err
    }
    log.info('finished cleanup -- shutting down')

    for (const event of STOP_EVENTS) {
      process.removeListener(event, this._cleanup)
    }
  }

  async start () {
    await this.ready()
    this._topTimer = setInterval(() => {
      log.info(processTop().toJSON(), 'process stats')
    }, 1000 * 60)

    this.server = new grpc.Server()

    this.server.addService(rpc.fuse.services.FuseService, {
      ...wrap(this.metadata, this.fuse.getHandlers(), { authenticate: true })
    })
    this.server.addService(rpc.drive.services.DriveService, {
      ...wrap(this.metadata, this.drives.getHandlers(), { authenticate: true })
    })
    this.server.addService(rpc.peersockets.services.PeersocketsService, {
      ...wrap(this.metadata, this.peersockets.getHandlers(), { authenticate: true })
    })
    this.server.addService(rpc.peers.services.PeersService, {
      ...wrap(this.metadata, this.peers.getHandlers(), { authenticate: true })
    })
    if (this.debug) {
      this.server.addService(rpc.debug.services.DebugService, {
        ...wrap(this.metadata, this.debug.getHandlers(), { authenticate: true })
      })
    }
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
  const argv = require('minimist')(process.argv.slice(2), {
    string: ['storage', 'log-level', 'bootstrap'],
    boolean: ['announce', 'memory-only', 'debug'],
    default: {
      bootstrap: '',
      'memory-only': false,
      announce: true,
      debug: true
    }
  })
  if (argv.bootstrap === 'false') argv.bootstrap = false
  else if (argv.bootstrap) argv.bootstrap = argv.bootstrap.split(',')
  return argv
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
          log.warn(tag, 'request authentication failed')
          const err = {
            code: grpc.status.UNAUTHENTICATED,
            message: 'Invalid auth token.'
          }
          if (cb) return cb(err)
          return call.destroy(err)
        }
        log.trace(tag, 'request authentication succeeded')
      }
      method(call)
        .then(rsp => {
          log.trace(tag, 'request was successful')
          if (cb) process.nextTick(cb, null, rsp)
        })
        .catch(err => {
          log.trace({ ...tag, error: err.toString() }, 'request failed')
          if (cb) return cb(serverError(err))
          return call.destroy(err)
        })
    }
  }
  return wrapped
}

function callAllInSet (set) {
  for (const cb of set) {
    cb()
  }
  set.clear()
}

if (require.main === module) {
  const opts = extractArguments()
  const daemon = new HyperdriveDaemon({ ...opts, main: true })
  process.title = 'hyperdrive'
  daemon.start()
} else {
  module.exports = HyperdriveDaemon
}

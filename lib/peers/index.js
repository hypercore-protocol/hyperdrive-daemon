const { EventEmitter } = require('events')
const eos = require('end-of-stream')

const { rpc } = require('hyperdrive-daemon-client')
const messages = rpc.peers.messages
const WatchPeersTypes = messages.WatchPeersResponse.Type
const log = require('../log').child({ component: 'peers' })

const ALIAS = Symbol('hyperdrive-peer-alias')

module.exports = class PeersManager extends EventEmitter {
  constructor (networker, peersockets, opts = {}) {
    super()
    this.networker = networker
    this.peersockets = peersockets
    this.opts = opts

    this._aliasCount = 1
    this._aliasesByKey = new Map()
    this._keysByAlias = new Map()
  }

  // RPC Methods

  async _rpcWatchPeers (call) {
    const discoveryKey = Buffer.from(call.request.getDiscoverykey())
    log.debug({ discoveryKey: discoveryKey && discoveryKey.toString('hex') }, 'opening peer watching stream')
    const close = this.peersockets.watchPeers(discoveryKey, {
      onjoin: (remoteKey) => {
        const rsp = new messages.WatchPeersResponse()
        rsp.setType(WatchPeersTypes.JOINED)
        const aliases = [this.getAlias(remoteKey)]
        rsp.setPeersList(aliases)
        call.write(rsp)
      },
      onleave: (remoteKey) => {
        const rsp = new messages.WatchPeersResponse()
        rsp.setType(WatchPeersTypes.LEFT)
        const aliases = [this.getAlias(remoteKey)]
        rsp.setPeersList(aliases)
        call.write(rsp)
      }
    })
    eos(call, close)
  }

  async _rpcListPeers (call) {
    var discoveryKey = call.request.getDiscoverykey()
    if (discoveryKey) discoveryKey = Buffer.from(discoveryKey)
    log.debug({ discoveryKey: discoveryKey && discoveryKey.toString('hex') }, 'listing peers')
    const peerInfos = []
    for (const peer of this.peersockets.listPeers(discoveryKey)) {
      const peerInfo = new messages.PeerInfo()
      peerInfo.setNoisekey(peer.key)
      peerInfo.setAddress(peer.address)
      peerInfo.setType(peer.type)
      peerInfos.push(peerInfo)
    }
    const rsp = new messages.ListPeersResponse()
    rsp.setPeersList(peerInfos)
    return rsp
  }

  async _rpcGetKey (call) {
    const rsp = new messages.GetKeyResponse()
    const key = this._keysByAlias.get(call.request.getAlias())
    rsp.setKey(key)
    return rsp
  }

  async _rpcGetAlias (call) {
    const rsp = new messages.GetAliasResponse()
    const alias = this.getAlias(Buffer.from(call.request.getKey()))
    rsp.setAlias(alias)
    return rsp
  }

  // Public Methods

  getKey (alias) {
    return this._keysByAlias.get(alias)
  }

  getAlias (remoteKey) {
    if (!Buffer.isBuffer(remoteKey)) throw new Error('getAlias must be called with a Buffer.')
    // The alias is stored on the Buffer as a Symbol to enable fast lookups.
    if (remoteKey[ALIAS]) return remoteKey[ALIAS]

    const keyString = remoteKey.toString('hex')
    const existingAlias = this._aliasesByKey.get(keyString)
    if (existingAlias) {
      remoteKey[ALIAS] = existingAlias
      return existingAlias
    }

    const alias = this._aliasCount++
    remoteKey[ALIAS] = alias
    this._aliasesByKey.set(keyString, alias)
    this._keysByAlias.set(alias, remoteKey)
    return alias
  }

  getHandlers () {
    return {
      listPeers: this._rpcListPeers.bind(this),
      watchPeers: this._rpcWatchPeers.bind(this),
      getAlias: this._rpcGetAlias.bind(this),
      getKey: this._rpcGetKey.bind(this)
    }
  }
}

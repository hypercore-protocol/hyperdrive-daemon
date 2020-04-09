const { EventEmitter } = require('events')
const eos = require('end-of-stream')
const Peersockets = require('peersockets')

const { rpc } = require('hyperdrive-daemon-client')
const messages = rpc.peersockets.messages
const log = require('../log').child({ component: 'peersockets' })

const WatchPeersTypes = messages.WatchPeersResponse.Type
const PeerMessageTypes = messages.PeerMessage.Type

const ALIAS = Symbol('peersockets-alias')

module.exports = class PeersocketsManager extends EventEmitter {
  constructor (networker, opts = {}) {
    super()
    this.networker = networker
    this.peersockets = new Peersockets(networker)
    this.opts = opts
  }

  async _watchPeers (call) {
    const discoveryKey = Buffer.from(call.request.getDiscoverykey())
    log.debug({ discoveryKey: discoveryKey && discoveryKey.toString('hex') }, 'opening peer watching stream')
    const close = this.peersockets.watchPeers(discoveryKey, {
      onjoin: (remoteKey) => {
        const rsp = new messages.WatchPeersResponse()
        rsp.setType(WatchPeersTypes.JOINED)
        const peerInfo = new messages.PeerInfo()
        // TODO: Batch these.
        peerInfo.setNoisekey(remoteKey)
        rsp.setPeersList([peerInfo])
        call.write(rsp)
      },
      onleave: (remoteKey) => {
        const rsp = new messages.WatchPeersResponse()
        rsp.setType(WatchPeersTypes.LEFT)
        const peerInfo = new messages.PeerInfo()
        // TODO: Batch these.
        peerInfo.setNoisekey(remoteKey)
        rsp.setPeersList([peerInfo])
        call.write(rsp)
      }
    })
    eos(call, close)
  }

  async _join (call) {
    log.debug('opening topic handle')
    const topicHandler = new TopicHandler(this.peersockets, call)
    eos(call, topicHandler.close())
  }

  getHandlers () {
    return {
      watchPeers: this._watchPeers.bind(this),
      join: this._join.bind(this)
    }
  }
}

class TopicHandler {
  constructor (peersockets, call) {
    this.call = call
    this.peersockets = peersockets
    this._clientAliases = new Map()
    this._aliasCount = 0
    // Set when an open message is received
    this._topicName = null
    this._topic = null
    this.call.on('data', this._onmessage.bind(this))
  }

  _onmessage (msg) {
    switch (msg.getType()) {
      case PeerMessageTypes.OPEN:
        return this._onopen(msg.getOpen())
      case PeerMessageTypes.DATA:
        return this._ondata(msg.getData())
      case PeerMessageTypes.ALIAS:
        return this._onalias(msg.getAlias())
    }
  }

  _createPeerMessage (type) {
    const peerMessage = new messages.PeerMessage()
    peerMessage.setType(type)
    return peerMessage
  }

  _createAlias (remoteKey) {
    const alias = ++this._aliasCount
    remoteKey[ALIAS] = alias
    const peerMessage = this._createPeerMessage(PeerMessageTypes.ALIAS)
    const aliasMessage = new messages.AliasMessage()
    aliasMessage.setAlias(alias)
    aliasMessage.setNoisekey(remoteKey)
    peerMessage.setAlias(aliasMessage)
    this.call.write(peerMessage)
    return alias
  }

  _onopen (openMessage) {
    this._topicName = openMessage.getTopic()
    this._topic = this.peersockets.join(this._topicName, {
      onmessage: (remoteKey, msg) => {
        const alias = remoteKey[ALIAS] || this._createAlias(remoteKey)
        const peerMessage = this._createPeerMessage(PeerMessageTypes.DATA)
        const dataMessage = new messages.DataMessage()
        dataMessage.setMsg(msg)
        dataMessage.setAlias(alias)
        peerMessage.setData(dataMessage)
        this.call.write(peerMessage)
      }
    })
  }

  _ondata (dataMessage) {
    const alias = dataMessage.getAlias()
    const msg = dataMessage.getMsg()
    const remoteKey = this._clientAliases.get(alias)
    if (!remoteKey) return
    this._topic.send(remoteKey, Buffer.from(msg))
  }

  _onalias (aliasMessage) {
    const alias = aliasMessage.getAlias()
    const remoteKey = aliasMessage.getNoisekey()
    this._clientAliases.set(alias, Buffer.from(remoteKey))
  }

  close () {
    // TODO: Need to do any cleanup?
  }
}

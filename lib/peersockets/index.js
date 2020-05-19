const { EventEmitter } = require('events')

const { rpc } = require('hyperdrive-daemon-client')
const messages = rpc.peersockets.messages
const log = require('../log').child({ component: 'peersockets' })

const PeerMessageTypes = messages.PeerMessage.Type

module.exports = class PeersocketsManager extends EventEmitter {
  constructor (networker, peers, peersockets, opts = {}) {
    super()
    this.networker = networker
    this.peers = peers
    this.peersockets = peersockets
    this.opts = opts
    this.handlesByTopic = new Map()
    this.handles = []
  }

  // RPC Methods

  async _rpcJoin (call) {
    log.debug('opening topic handle')
    const topicHandler = new TopicHandler(this, this.peersockets, this.peers, call)
    this.handles.push(topicHandler)
  }

  getHandlers () {
    return {
      join: this._rpcJoin.bind(this)
    }
  }
}

class TopicHandler {
  constructor (manager, peersockets, peers, call) {
    this.call = call
    this.manager = manager
    this.peersockets = peersockets
    this.peers = peers
    // Set when an open message is received
    this._topicName = null
    this._topic = null
    this.call.on('data', this._onmessage.bind(this))
    this.call.on('error', this.close.bind(this))
    this.call.on('end', this.close.bind(this))
  }

  _onmessage (msg) {
    switch (msg.getType()) {
      case PeerMessageTypes.OPEN:
        return this._onopen(msg.getOpen())
      case PeerMessageTypes.DATA:
        return this._ondata(msg.getData())
      default:
        log.warn({ type: msg.getType() }, 'received a message with an invalid type')
    }
  }

  _createPeerMessage (type) {
    const peerMessage = new messages.PeerMessage()
    peerMessage.setType(type)
    return peerMessage
  }

  _onopen (openMessage) {
    this._topicName = openMessage.getTopic()

    var handles = this.manager.handlesByTopic.get(this._topicName)
    if (!handles) {
      handles = []
      this.manager.handlesByTopic.set(this._topicName, handles)
    }
    handles.push(this)

    this._topic = this.peersockets.join(this._topicName, {
      onmessage: (remoteKey, msg) => {
        const alias = this.peers.getAlias(remoteKey)
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
    const remoteKey = this.peers.getKey(alias)
    if (!remoteKey) return
    this._topic.send(remoteKey, Buffer.from(msg))
  }

  close () {
    if (!this._topicName) return
    var handles = this.manager.handlesByTopic.get(this._topicName)
    if (!handles) return
    var idx = handles.indexOf(this)
    if (idx !== -1) {
      handles.splice(idx, 1)
    }
    idx = this.manager.handles.indexOf(this)
    this.manager.handles.splice(idx, 1)
    if (!handles.length) {
      this.manager.handlesByTopic.delete(this._topicName)
      this.peersockets.leave(this._topicName)
    }
  }
}

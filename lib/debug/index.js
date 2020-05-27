const { EventEmitter } = require('events')
const repl = require('repl')
const streamx = require('streamx')
const pumpify = require('pumpify')

const { rpc } = require('hyperdrive-daemon-client')
const messages = rpc.debug.messages

const log = require('../log').child({ component: 'repl' })

module.exports = class DebugManager extends EventEmitter {
  constructor (daemon) {
    super()
    this.daemon = daemon
  }

  // RPC Methods

  async _rpcRepl (call) {
    const inputDecoder = new streamx.Transform({
      highWaterMark: 1,
      transform: (req, cb) => {
        return cb(null, Buffer.from(req.getIo()))
      }
    })
    const outputEncoder = new streamx.Transform({
      highWaterMark: 1,
      transform: (chunk, cb) => {
        const responseMessage = new messages.ReplMessage()
        responseMessage.setIo(Buffer.from(chunk))
        return cb(null, responseMessage)
      }
    })
    const r = repl.start({
      input: pumpify(call, inputDecoder),
      output: pumpify.obj(outputEncoder, call),
      preview: false,
      terminal: true,
      completer: line => {
        const keys = Object.keys(r.context)
        return [keys.filter(k => k.startsWith(line)), line]
      }
    })
    Object.assign(r.context, {
      daemon: this.daemon,
      corestore: this.daemon.corestore,
      networker: this.daemon.networking,
      swarm: this.daemon.networking.swarm,
      drives: this.daemon.drives._drives,
      log
    })
    call.on('end', () => r.close())
    call.once('error', () => r.close())
  }

  getHandlers () {
    return {
      repl: this._rpcRepl.bind(this)
    }
  }
}

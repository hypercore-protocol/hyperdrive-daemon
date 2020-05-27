const tmp = require('tmp-promise')
const dht = require('@hyperswarm/dht')

const { HyperdriveClient } = require('hyperdrive-daemon-client')
const HyperdriveDaemon = require('../..')

const BASE_PORT = 4101
const BOOTSTRAP_PORT = 3106
const BOOTSTRAP_URL = `localhost:${BOOTSTRAP_PORT}`

async function create (numServers, opts) {
  const cleanups = []
  const clients = []
  const daemons = []
  const dirs = []

  const bootstrapper = dht({
    bootstrap: false
  })
  bootstrapper.listen(BOOTSTRAP_PORT)
  await new Promise(resolve => {
    return bootstrapper.once('listening', resolve)
  })

  for (let i = 0; i < numServers; i++) {
    const instanceOpts = Array.isArray(opts) ? opts[i] || {} : opts
    const { client, daemon, cleanup, dir } = await createInstance(i, BASE_PORT + i, [BOOTSTRAP_URL], instanceOpts)
    clients.push(client)
    daemons.push(daemon)
    cleanups.push(cleanup)
    dirs.push(dir)
  }

  return { clients, daemons, cleanup, dirs }

  async function cleanup (opts) {
    for (const cleanupInstance of cleanups) {
      await cleanupInstance(opts)
    }
    await bootstrapper.destroy()
  }
}

async function createOne (opts) {
  const { dirs, clients, cleanup, daemons } = await create(1, opts)
  return {
    dir: dirs[0],
    client: clients[0],
    daemon: daemons[0],
    cleanup
  }
}

async function createInstance (id, port, bootstrap, opts = {}) {
  const dir = opts.dir || await tmp.dir({ unsafeCleanup: true })
  const { path, cleanup: dirCleanup } = dir

  const token = `test-token-${id}`
  const endpoint = `localhost:${port}`

  const daemon = new HyperdriveDaemon({
    storage: path,
    bootstrap,
    port,
    // Added this so that old DHT messages from a live daemon don't connect to the test daemons.
    swarmPort: port * 2,
    memoryOnly: !!opts.memoryOnly,
    noAnnounce: !!opts.noAnnounce,
    metadata: {
      token,
      endpoint
    },
    latency: opts.latency
  })
  await daemon.start()

  const client = new HyperdriveClient(endpoint, token)
  await client.ready()

  return {
    dir,
    client,
    daemon,
    cleanup
  }

  async function cleanup (opts = {}) {
    await daemon.stop()
    if (!opts.persist) await dirCleanup()
  }
}

module.exports = {
  create,
  createOne
}

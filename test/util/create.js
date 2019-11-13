const tmp = require('tmp-promise')
const dht = require('@hyperswarm/dht')

const loadClient = require('hyperdrive-daemon-client/lib/loader')
const HyperdriveDaemon = require('../..')

const BASE_PORT = 4101
const BOOTSTRAP_PORT = 3100
const BOOTSTRAP_URL = `localhost:${BOOTSTRAP_PORT}`

async function create (numServers) {
  const cleanups = []
  const clients = []
  const daemons = []

  const bootstrapper = dht({
    bootstrap: false
  })
  bootstrapper.listen(BOOTSTRAP_PORT)
  await new Promise(resolve => {
    return bootstrapper.once('listening', resolve)
  })

  for (let i = 0; i < numServers; i++) {
    const { client, daemon, cleanup } = await createInstance(i, BASE_PORT + i, [BOOTSTRAP_URL])
    clients.push(client)
    daemons.push(daemon)
    cleanups.push(cleanup)
  }

  return { clients, daemons, cleanup }

  async function cleanup () {
    for (let cleanupInstance of cleanups) {
      await cleanupInstance()
    }
    await bootstrapper.destroy()
  }
}

async function createOne () {
  const { clients, cleanup, daemons } = await create(1)
  return {
    client: clients[0],
    daemon: daemons[0],
    cleanup
  }
}

async function createInstance (id, port, bootstrap) {
  const { path, cleanup: dirCleanup } = await tmp.dir({ unsafeCleanup: true })

  const token = `test-token-${id}`
  const endpoint = `localhost:${port}`
  var client

  const daemon = new HyperdriveDaemon({
    storage: path,
    bootstrap,
    port,
    metadata: {
      token,
      endpoint
    }
  })
  await daemon.start()

  return new Promise((resolve, reject) => {
    return loadClient(endpoint, token, (err, c) => {
      client = c
      if (err) return reject(err)
      return resolve({
        client,
        daemon,
        cleanup
      })
    })
  })

  async function cleanup () {
    await daemon.stop()
    await dirCleanup()
  }
}

module.exports = {
  create,
  createOne
}

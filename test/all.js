const { spawn } = require('child_process')

const pify = require('pify')
const test = require('tape')
const tmp = require('tmp-promise')

const PORT = 3101
process.env['HYPERDRIVE_TOKEN'] = 'test-token'
process.env['HYPERDRIVE_ENDPOINT'] = `localhost:${PORT}`

const loadClient = require('hyperdrive-daemon-client/lib/loader')
const start = require('..')

test('can write/read a file from a remote hyperdrive', async t => {
  const { client, cleanup } = await create()

  try {
    const { opts, id } = await client.drive.get()
    t.true(opts.key)
    t.same(id, 1)

    await client.drive.writeFile(id, 'hello', 'world')

    const contents = await client.drive.readFile(id, 'hello')
    t.same(contents, Buffer.from('world'))

    await client.drive.closeSession(id)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can stat a file from a remote hyperdrive', async t => {
  const { client, cleanup } = await create()

  try {
    const { opts, id } = await client.drive.get()
    t.true(opts.key)
    t.same(id, 1)

    await client.drive.writeFile(id, 'hello', 'world')

    const stat = await client.drive.stat(id, 'hello')
    t.same(stat.size, Buffer.from('world').length)
    t.same(stat.uid, 0)
    t.same(stat.gid, 0)

    await client.drive.closeSession(id)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can list a directory from a remote hyperdrive', async t => {
  const { client, cleanup } = await create()

  try {
    const { opts, id } = await client.drive.get()
    t.true(opts.key)
    t.same(id, 1)

    await client.drive.writeFile(id, 'hello', 'world')
    await client.drive.writeFile(id, 'goodbye', 'dog')
    await client.drive.writeFile(id, 'adios', 'friend')

    const files = await client.drive.readdir(id, '')
    t.same(files.length, 4)
    t.notEqual(files.indexOf('hello'), -1)
    t.notEqual(files.indexOf('goodbye'), -1)
    t.notEqual(files.indexOf('adios'), -1)
    t.notEqual(files.indexOf('.key'), -1)

    await client.drive.closeSession(id)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can read/write multiple remote hyperdrives on one server', async t => {
  const { client, cleanup } = await create()
  var startingId = 1

  const files = [
    ['hello', 'world'],
    ['goodbye', 'dog'],
    ['random', 'file']
  ]

  for (const [file, content] of files) {
    await createAndWrite(file, content)
  }

  for (let i = 1; i < files.length + 1; i++) {
    const [file, content] = files[i - 1]
    const readContent = await client.drive.readFile(i, file)
    t.same(readContent, Buffer.from(content))
  }

  async function createAndWrite (file, content) {
    const { opts, id } = await client.drive.get()
    t.true(opts.key)
    t.same(id, startingId++)
    await client.drive.writeFile(id, file, content)
  }

  await cleanup()
  t.end()
})

async function create () {
  const { path, cleanup: dirCleanup } = await tmp.dir({ unsafeCleanup: true })
  const stop = await start({
    storage: path,
    bootstrap: false,
    port: 3101
  })

  return new Promise((resolve, reject) => {
    return loadClient((err, client) => {
      if (err) return reject(err)
      return resolve({
        client: {
          drive: promisifyClass(client.drive),
          fuse: promisifyClass(client.fuse)
        },
        cleanup
      })
    })
  })

  async function cleanup () {
    await stop()
    await dirCleanup()
  }
}

function promisifyClass (clazz) {
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(clazz)).filter(name => name !== 'constructor')
  methods.forEach(name => {
    clazz[name] = pify(clazz[name])
  })
  return clazz
}

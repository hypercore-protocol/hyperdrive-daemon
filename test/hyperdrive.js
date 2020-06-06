const test = require('tape')

const collectStream = require('stream-collector')
const { createOne } = require('./util/create')

test('can write/read a file from a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive = await client.drive.get()
    t.true(drive.key)
    t.same(drive.id, 1)

    await drive.writeFile('hello', 'world')

    const contents = await drive.readFile('hello', { encoding: 'utf8' })
    t.same(contents, 'world')

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can write/read a large file from a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  const content = Buffer.alloc(3.9e7).fill('abcdefghi')

  try {
    const drive = await client.drive.get()
    t.true(drive.key)
    t.same(drive.id, 1)

    await drive.writeFile('hello', content)

    const contents = await drive.readFile('hello')
    t.same(contents, content)

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can write/read file metadata alongside a file', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive = await client.drive.get()
    t.true(drive.key)
    t.same(drive.id, 1)

    await drive.writeFile('hello', 'world', {
      metadata: {
        hello: Buffer.from('world')
      }
    })

    const stat = await drive.stat('hello')
    t.same(stat.metadata.hello, Buffer.from('world'))

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can update file metadata', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive = await client.drive.get()
    t.true(drive.key)
    t.same(drive.id, 1)

    await drive.writeFile('hello', 'world', {
      metadata: {
        hello: Buffer.from('world')
      }
    })

    var stat = await drive.stat('hello')
    t.same(stat.metadata.hello, Buffer.from('world'))

    await drive.updateMetadata('hello', {
      hello: Buffer.from('goodbye')
    })

    stat = await drive.stat('hello')
    t.same(stat.metadata.hello, Buffer.from('goodbye'))

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can delete metadata', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive = await client.drive.get()
    t.true(drive.key)
    t.same(drive.id, 1)

    await drive.writeFile('hello', 'world', {
      metadata: {
        first: Buffer.from('first'),
        second: Buffer.from('second')
      }
    })

    var stat = await drive.stat('hello')
    t.same(stat.metadata.first, Buffer.from('first'))
    t.same(stat.metadata.second, Buffer.from('second'))

    await drive.deleteMetadata('hello', ['first'])

    stat = await drive.stat('hello')
    t.false(stat.metadata.first)
    t.same(stat.metadata.second, Buffer.from('second'))

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can write/read a file from a remote hyperdrive using stream methods', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive = await client.drive.get()
    t.true(drive.key)
    t.same(drive.id, 1)

    const writeStream = drive.createWriteStream('hello', { uid: 999, gid: 999 })
    writeStream.write('hello')
    writeStream.write('there')
    writeStream.end('friend')

    await new Promise((resolve, reject) => {
      writeStream.on('error', reject)
      writeStream.on('finish', resolve)
    })

    const readStream = await drive.createReadStream('hello', { start: 5, length: Buffer.from('there').length + 1 })
    const content = await new Promise((resolve, reject) => {
      collectStream(readStream, (err, bufs) => {
        if (err) return reject(err)
        return resolve(Buffer.concat(bufs))
      })
    })
    t.same(content, Buffer.from('theref'))

    const stat = await drive.stat('hello')
    t.same(stat.uid, 999)
    t.same(stat.gid, 999)

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('assorted read parameters to createReadStream', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive = await client.drive.get()
    t.true(drive.key)
    t.same(drive.id, 1)

    let blocks = ['hello', 'hello', 'world', 'world']
    let complete = blocks.join('')
    let tests = [
      {
        params: {},
        value: complete
      },
      {
        params: { end: 10 },
        value: complete.slice(0, 10 + 1)
      },
      {
        params: { start: 4, end: 10 },
        value: complete.slice(4, 10 + 1)
      }
    ]

    const writeStream = drive.createWriteStream('hello', { uid: 999, gid: 999 })
    for (let block of blocks) {
      writeStream.write(block)
    }
    writeStream.end()

    await new Promise((resolve, reject) => {
      writeStream.on('error', reject)
      writeStream.on('finish', resolve)
    })

    console.log('wrote blocks')

    for (let { params, value } of tests) {
      const readStream = await drive.createReadStream('hello', params)
      const content = await new Promise((resolve, reject) => {
        collectStream(readStream, (err, bufs) => {
          if (err) return reject(err)
          return resolve(Buffer.concat(bufs))
        })
      })
      t.same(content.toString('utf8'), value)
    }

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('reading an invalid file propogates error', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive = await client.drive.get()
    t.true(drive.key)
    t.same(drive.id, 1)

    try {
      const readStream = await drive.createReadStream('hello', { start: 5, length: Buffer.from('there').length + 1 })
      await new Promise((resolve, reject) => {
        collectStream(readStream, (err, bufs) => {
          if (err) return reject(err)
          return resolve(Buffer.concat(bufs))
        })
      })
      t.fail('read stream did not throw error')
    } catch (err) {
      t.pass('read stream threw error')
    }

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can stat a file from a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive = await client.drive.get()

    await drive.writeFile('hello', 'world')

    const stat = await drive.stat('hello')
    t.same(stat.size, Buffer.from('world').length)
    t.same(stat.uid, 0)
    t.same(stat.gid, 0)

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can list a directory from a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive = await client.drive.get()

    await drive.writeFile('hello', 'world')
    await drive.writeFile('goodbye', 'dog')
    await drive.writeFile('adios', 'amigo')

    const files = await drive.readdir('')
    t.same(files.length, 3)
    t.notEqual(files.indexOf('hello'), -1)
    t.notEqual(files.indexOf('goodbye'), -1)
    t.notEqual(files.indexOf('adios'), -1)

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can list a directory from a remote hyperdrive with stats', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive = await client.drive.get()

    await drive.writeFile('hello', 'world')
    await drive.writeFile('goodbye', 'dog')
    await drive.writeFile('adios', 'amigo')
    const expected = new Set(['hello', 'goodbye', 'adios'])

    const objs = await drive.readdir('', { includeStats: true })
    t.same(objs.length, 3)
    for (const { name, stat, mount, innerPath } of objs) {
      t.true(expected.has(name))
      t.same(stat.mode, 33188)
      t.true(mount.key.equals(drive.key))
      t.same(innerPath, name)
      expected.delete(name)
    }

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can list a large directory from a remote hyperdrive with stats', async t => {
  const { client, cleanup } = await createOne()
  const NUM_FILES = 5000
  const PARALLEL_WRITE = true

  try {
    const drive = await client.drive.get()

    const proms = []
    for (let i = 0; i < NUM_FILES; i++) {
      const prom = drive.writeFile(String(i), String(i))
      if (PARALLEL_WRITE) proms.push(prom)
      else await prom
    }
    if (PARALLEL_WRITE) await Promise.all(proms)

    const objs = await drive.readdir('', { includeStats: true })
    t.same(objs.length, NUM_FILES)
    let statError = null
    let mountError = null
    for (const { stat, mount } of objs) {
      if (stat.mode !== 33188) statError = 'stat mode is incorrect'
      if (!mount.key.equals(drive.key)) mountError = 'mount key is not the drive key'
    }
    if (statError) t.fail(statError)
    if (mountError) t.fail(mountError)

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can create a diff stream on a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive1 = await client.drive.get()
    const drive2 = await client.drive.get()

    await drive1.writeFile('hello', 'world')
    const v1 = await drive1.version()
    await drive1.writeFile('goodbye', 'dog')
    const v2 = await drive1.version()
    await drive1.mount('d2', { key: drive2.key })
    const v3 = await drive1.version()
    await drive1.unmount('d2')

    const diff1 = await drive1.createDiffStream()
    const checkout = await drive1.checkout(v2)
    const diff2 = await checkout.createDiffStream(v1)
    const diff3 = await drive1.createDiffStream(v3)
    const checkout2 = await drive1.checkout(v3)
    const diff4 = await checkout2.createDiffStream(v2)

    await validate(diff1, [
      { type: 'put', name: 'goodbye' },
      { type: 'put', name: 'hello' }
    ])
    await validate(diff2, [
      { type: 'put', name: 'goodbye' }
    ])
    await validate(diff3, [
      // TODO: The first is a false positive.
      { type: 'put', name: 'goodbye' },
      { type: 'unmount', name: 'd2' }
    ])
    await validate(diff4, [
      { type: 'mount', name: 'd2', key: drive2.key }
    ])

    await drive1.close()
    await drive2.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()

  async function validate (stream, expected) {
    return new Promise((resolve, reject) => {
      var seen = 0
      stream.on('end', () => {
        t.same(seen, expected.length)
        return resolve()
      })
      stream.on('error', t.fail.bind(t))
      stream.on('data', ({ type, name, value }) => {
        t.same(name, expected[seen].name)
        t.same(type, expected[seen].type)
        if (type === 'mount') t.same(value.mount.key, expected[seen].key)
        seen++
      })
    })
  }
})

test('can read/write multiple remote hyperdrives on one server', async t => {
  const { client, cleanup } = await createOne()
  var startingId = 1

  const files = [
    ['hello', 'world'],
    ['goodbye', 'dog'],
    ['random', 'file']
  ]

  var drives = []
  for (const [file, content] of files) {
    drives.push(await createAndWrite(file, content))
  }

  for (let i = 0; i < files.length; i++) {
    const [file, content] = files[i]
    const drive = drives[i]
    const readContent = await drive.readFile(file)
    t.same(readContent, Buffer.from(content))
  }

  async function createAndWrite (file, content) {
    const drive = await client.drive.get()
    t.same(drive.id, startingId++)
    await drive.writeFile(file, content)
    return drive
  }

  await cleanup()
  t.end()
})

test('can mount a drive within a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive1 = await client.drive.get()

    const drive2 = await client.drive.get()
    t.notEqual(drive1.key, drive2.key)

    await drive1.mount('a', { key: drive2.key })

    await drive1.writeFile('a/hello', 'world')
    await drive1.writeFile('a/goodbye', 'dog')
    await drive1.writeFile('adios', 'amigo')
    await drive2.writeFile('hamster', 'wheel')

    t.same(await drive1.readFile('adios'), Buffer.from('amigo'))
    t.same(await drive1.readFile('a/hello'), Buffer.from('world'))
    t.same(await drive2.readFile('hello'), Buffer.from('world'))
    t.same(await drive2.readFile('hamster'), Buffer.from('wheel'))

    await drive1.close()
    await drive2.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can mount a drive within a remote hyperdrive multiple times', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive1 = await client.drive.get()
    const drive2 = await client.drive.get()
    await drive2.writeFile('x', 'y')

    await drive1.mount('a', { key: drive2.key })
    await drive1.mount('b', { key: drive2.key })

    t.same(await drive1.readFile('a/x'), Buffer.from('y'))
    t.same(await drive1.readFile('b/x'), Buffer.from('y'))

    await drive1.close()
    await drive2.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can mount a versioned drive within a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive1 = await client.drive.get()

    const drive2 = await client.drive.get()
    await drive2.writeFile('hamster', 'wheel')
    const version1 = await drive2.version()
    await drive2.writeFile('blah', 'blahblah')

    await drive1.mount('a', { key: drive2.key })
    await drive1.mount('aStatic', { key: drive2.key, version: version1 })

    await drive1.writeFile('a/hello', 'world')
    await drive1.writeFile('adios', 'amigo')

    t.same(await drive1.readFile('adios'), Buffer.from('amigo'))
    t.same(await drive1.readFile('a/hello'), Buffer.from('world'))
    t.same(await drive2.readFile('hello'), Buffer.from('world'))
    t.same(await drive2.readFile('hamster'), Buffer.from('wheel'))
    t.same(await drive1.readFile('aStatic/hamster'), Buffer.from('wheel'))
    try {
      await drive1.readFile('aStatic/blah')
      t.fail('aStatic should be a versioned mount')
    } catch (err) {
      t.true(err)
    }

    await drive1.close()
    await drive2.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can unmount a drive within a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive1 = await client.drive.get()
    const drive2 = await client.drive.get()
    t.notEqual(drive1.key, drive2.key)

    await drive1.mount('a', { key: drive2.key })

    await drive1.writeFile('a/hello', 'world')
    await drive1.writeFile('a/goodbye', 'dog')
    await drive1.writeFile('adios', 'amigo')
    await drive2.writeFile('hamster', 'wheel')

    t.same(await drive1.readFile('adios'), Buffer.from('amigo'))
    t.same(await drive1.readFile('a/hello'), Buffer.from('world'))
    t.same(await drive2.readFile('hello'), Buffer.from('world'))
    t.same(await drive2.readFile('hamster'), Buffer.from('wheel'))

    await drive1.unmount('a')
    try {
      await drive1.readFile('a/hello')
    } catch (err) {
      t.true(err)
      t.same(err.code, 2)
    }

    await drive1.close()
    await drive2.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can watch a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  var triggered = 0

  try {
    const drive = await client.drive.get()

    const unwatch = drive.watch('', () => {
      triggered++
    })

    await drive.writeFile('hello', 'world')
    await delay(20)
    await unwatch()
    await delay(20)
    await drive.writeFile('world', 'hello')

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  t.same(triggered, 1)

  await cleanup()
  t.end()
})

test('watch cleans up after unexpected close', async t => {
  const { client, cleanup, daemon } = await createOne()

  var triggered = 0

  try {
    const drive = await client.drive.get()

    drive.watch('', () => {
      triggered++
    })

    await drive.writeFile('hello', 'world')
    await delay(10)
    t.same(daemon.drives._watchCount, 1)
    await cleanup()
  } catch (err) {
    t.fail(err)
  }

  t.same(triggered, 1)
  t.same(daemon.drives._watchers.size, 0)
  t.same(daemon.drives._watchCount, 0)

  t.end()
})

test('can create a symlink to directories', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive = await client.drive.get()
    await drive.mkdir('hello', { uid: 999 })
    await drive.writeFile('hello/world', 'content')
    await drive.symlink('hello', 'other_hello')
    await drive.symlink('hello/world', 'other_world')

    const contents = await drive.readFile('other_world')
    t.same(contents, Buffer.from('content'))

    const files = await drive.readdir('other_hello')
    t.same(files.length, 1)
    t.same(files[0], 'world')

    const stat = await drive.lstat('other_world')
    t.true(stat.isSymbolicLink())

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('drives are closed when all corresponding sessions are closed', async t => {
  const { client, cleanup, daemon } = await createOne()

  try {
    const drive = await client.drive.get()
    await drive.writeFile('a', 'a')
    await drive.writeFile('b', 'b')
    await drive.writeFile('c', 'c')
    const otherDrive = await client.drive.get({ key: drive.key })
    const checkout1 = await client.drive.get({ key: drive.key, version: 1 })

    await drive.close()
    t.same(daemon.drives._drives.size, 2)
    await otherDrive.close()
    t.same(daemon.drives._drives.size, 2)
    await checkout1.close()
    t.same(daemon.drives._drives.size, 0)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('reopening a drive after previously closed works', async t => {
  const { client, cleanup, daemon } = await createOne()

  try {
    var drive = await client.drive.get()
    const driveKey = drive.key
    await drive.writeFile('a', 'a')
    await drive.writeFile('b', 'b')
    await drive.writeFile('c', 'c')
    const otherDrive = await client.drive.get({ key: driveKey })
    const checkout1 = await client.drive.get({ key: driveKey, version: 1 })

    await drive.close()
    t.same(daemon.drives._drives.size, 2)
    await otherDrive.close()
    t.same(daemon.drives._drives.size, 2)
    await checkout1.close()
    t.same(daemon.drives._drives.size, 0)

    drive = await client.drive.get({ key: driveKey })
    await drive.writeFile('d', 'd')
    const contents = await drive.readFile('a')
    t.same(contents, Buffer.from('a'))
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('many quick closes/reopens', async t => {
  const NUM_CYCLES = 10
  const { client, cleanup, daemon } = await createOne()
  var driveKey = null
  const expected = new Array(NUM_CYCLES).fill(0).map((_, i) => '' + i)

  try {
    for (let i = 0; i < NUM_CYCLES; i++) {
      var drive = await client.drive.get({ key: driveKey })
      if (!driveKey) driveKey = drive.key
      await drive.writeFile(expected[i], expected[i])
      await drive.close()
      if (daemon.drives._drives.size !== 0) t.fail('session close did not trigger drive close')
    }
    drive = await client.drive.get({ key: driveKey })
    const actual = []
    for (let i = 0; i < NUM_CYCLES; i++) {
      const contents = await drive.readFile(expected[i])
      actual[i] = contents.toString('utf8')
    }
    t.same(expected, actual)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('drives are writable after a daemon restart', async t => {
  var { dir, client, cleanup } = await createOne()

  try {
    var drive = await client.drive.get()
    const driveKey = drive.key
    await drive.writeFile('a', 'a')

    await cleanup({ persist: true })

    const newDaemon = await createOne({ dir })
    client = newDaemon.client
    cleanup = newDaemon.cleanup

    drive = await client.drive.get({ key: driveKey })
    t.same(await drive.readFile('a'), Buffer.from('a'))
    await drive.writeFile('b', 'b')
    t.same(await drive.readFile('b'), Buffer.from('b'))
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('cores are not closed incorrectly during the initial rejoin', async t => {
  var { dir, client, cleanup } = await createOne()

  try {
    var drive = await client.drive.get()
    const driveKey = drive.key
    await drive.writeFile('a', 'a')
    await drive.configureNetwork({ announce: true, lookup: true, remember: true })

    await cleanup({ persist: true })

    const newDaemon = await createOne({ dir })
    client = newDaemon.client
    cleanup = newDaemon.cleanup
    drive = await client.drive.get({ key: driveKey })

    t.same(await drive.readFile('a'), Buffer.from('a'))
    await drive.writeFile('b', 'b')
    t.same(await drive.readFile('b'), Buffer.from('b'))
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('mounts are writable in memory-only mode', async t => {
  var { client, cleanup } = await createOne({ memoryOnly: true })

  try {
    var drive = await client.drive.get()
    var mount = await client.drive.get()
    const mountKey = mount.key

    await drive.writeFile('a', 'a')
    await drive.mount('b', { key: mountKey })
    await drive.writeFile('b/c', 'b/c')
    await mount.writeFile('d', 'd')

    const aContents = await drive.readFile('a')
    const bcContents = await drive.readFile('b/c')
    const cContents = await mount.readFile('c')
    const dContents = await mount.readFile('d')

    t.same(aContents, Buffer.from('a'))
    t.same(bcContents, Buffer.from('b/c'))
    t.same(cContents, Buffer.from('b/c'))
    t.same(dContents, Buffer.from('d'))
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can get network configuration alongside drive stats', async t => {
  var { client, cleanup } = await createOne({ memoryOnly: true })

  try {
    const drive1 = await client.drive.get()
    const drive2 = await client.drive.get()

    await drive1.writeFile('a', 'a')
    await drive2.writeFile('b', 'bbbbbb')
    await drive2.writeFile('c', 'cccccc')

    await drive1.configureNetwork({ announce: true, lookup: true, remember: true })
    await drive2.configureNetwork({ announce: false, lookup: true, remember: false })

    const { network: network1 } = await drive1.stats()
    const { network: network2 } = await drive2.stats()

    t.true(network1.announce)
    t.true(network1.lookup)
    t.true(network1.remember)
    t.false(network2.announce)
    t.true(network2.lookup)
    t.false(network2.remember)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can get all network configurations', async t => {
  var { client, cleanup } = await createOne({ memoryOnly: true })

  const configs = [
    { announce: true, lookup: true, remember: true },
    { announce: false, lookup: false, remember: true },
    { announce: false, lookup: true, remember: false },
    { announce: true, lookup: false, remember: false }
  ]
  const driveConfigs = new Map()

  try {
    for (const config of configs) {
      const drive = await client.drive.get()
      await drive.configureNetwork(config)
      const expectedConfig = (!config.announce && !config.lookup) ? null : config
      driveConfigs.set(drive.key.toString('hex'), expectedConfig)
    }
    const configMap = await client.drive.allNetworkConfigurations()
    for (const [key, config] of configMap) {
      const expectedDriveConfig = driveConfigs.get(key)
      if (!expectedDriveConfig) {
        t.same(config, null)
      } else {
        t.same(expectedDriveConfig.announce, config.announce)
        t.same(expectedDriveConfig.lookup, config.lookup)
      }
    }
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

// TODO: Figure out why the grpc server is not terminating.
test.onFinish(() => {
  setTimeout(() => {
    process.exit(0)
  }, 100)
})

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

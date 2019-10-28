const test = require('tape')

const collectStream = require('stream-collector')
const { createOne } = require('./util/create')

test('can write/read a file from a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  try {
    const drive = await client.drive.get()
    t.true(drive.key)
    t.same(drive.id, 1)

    const version = await drive.version()

    await drive.writeFile('hello', 'world')

    const contents = await drive.readFile('hello', { encoding: 'utf8'})
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

  const content = Buffer.alloc(3.9e6 * 10.11).fill('abcdefghi')

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

    const version = await drive.version()

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

    const version = await drive.version()

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
    console.error('ERR:', err.stack)
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

    const version = await drive.version()

    await drive.writeFile('hello', 'world', {
      metadata: {
        'first': Buffer.from('first'),
        'second': Buffer.from('second')
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
    console.error('ERR:', err.stack)
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
    const v4 = await drive1.version()

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
      { type: 'put', name: 'goodbye'}
    ])
    await validate(diff3, [
      // TODO: The first is a false positive.
      { type: 'put', name: 'goodbye' },
      { type: 'unmount', name: 'd2' }
    ])
    await validate(diff4, [
      { type: 'mount', name: 'd2' }
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
    await unwatch()
    await drive.writeFile('world', 'hello')

    await drive.close()
  } catch (err) {
    t.fail(err)
  }

  t.true(triggered)

  await cleanup()
  t.end()
})

// TODO: Important test
test.skip('watch cleans up after unexpected close', async t => {
  const { client, cleanup } = await createOne()

  var triggered = 0

  try {
    const { id } = await client.drive.get()

    const unwatch = client.drive.watch(id, '', () => {
      triggered++
    })

    await client.drive.writeFile(id, 'hello', 'world')
    await unwatch()
    await client.drive.writeFile(id, 'world', 'hello')

    await client.drive.close(id)
  } catch (err) {
    t.fail(err)
  }

  t.true(triggered)

  await cleanup()
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

// TODO: Figure out why the grpc server is not terminating.
test.onFinish(() => {
  setTimeout(() => {
    process.exit(0)
  }, 100)
})

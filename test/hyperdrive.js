const test = require('tape')

const { createOne } = require('./util/create')

test('can write/read a file from a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  try {
    const { opts, id } = await client.drive.get()
    t.true(opts.key)
    t.same(id, 1)

    await client.drive.writeFile(id, 'hello', 'world')

    const contents = await client.drive.readFile(id, 'hello')
    t.same(contents, Buffer.from('world'))

    await client.drive.close(id)
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
    const { opts, id } = await client.drive.get()
    t.true(opts.key)
    t.same(id, 1)

    await client.drive.writeFile(id, 'hello', content)

    const contents = await client.drive.readFile(id, 'hello')
    t.same(contents, content)

    await client.drive.close(id)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can stat a file from a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  try {
    const { opts, id } = await client.drive.get()
    t.true(opts.key)
    t.same(id, 1)

    await client.drive.writeFile(id, 'hello', 'world')

    const stat = await client.drive.stat(id, 'hello')
    t.same(stat.size, Buffer.from('world').length)
    t.same(stat.uid, 0)
    t.same(stat.gid, 0)

    await client.drive.close(id)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can list a directory from a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  try {
    const { opts, id } = await client.drive.get()
    t.true(opts.key)
    t.same(id, 1)

    await client.drive.writeFile(id, 'hello', 'world')
    await client.drive.writeFile(id, 'goodbye', 'dog')
    await client.drive.writeFile(id, 'adios', 'amigo')

    const files = await client.drive.readdir(id, '')
    t.same(files.length, 4)
    t.notEqual(files.indexOf('hello'), -1)
    t.notEqual(files.indexOf('goodbye'), -1)
    t.notEqual(files.indexOf('adios'), -1)
    t.notEqual(files.indexOf('.key'), -1)

    await client.drive.close(id)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can read/write multiple remote hyperdrives on one server', async t => {
  const { client, cleanup } = await createOne()
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

test('can mount a drive within a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  try {
    const { opts: opts1, id: id1 } = await client.drive.get()
    t.true(opts1.key)
    t.same(id1, 1)

    const { opts: opts2, id: id2 } = await client.drive.get()
    t.true(opts2.key)
    t.same(id2, 2)
    t.notEqual(opts1.key, opts2.key)

    const noVersion = { ...opts2, version: null }

    await client.drive.mount(id1, 'a', noVersion)

    await client.drive.writeFile(id1, 'a/hello', 'world')
    await client.drive.writeFile(id1, 'a/goodbye', 'dog')
    await client.drive.writeFile(id1, 'adios', 'amigo')
    await client.drive.writeFile(id2, 'hamster', 'wheel')

    t.same(await client.drive.readFile(id1, 'adios'), Buffer.from('amigo'))
    t.same(await client.drive.readFile(id1, 'a/hello'), Buffer.from('world'))
    t.same(await client.drive.readFile(id2, 'hello'), Buffer.from('world'))
    t.same(await client.drive.readFile(id2, 'hamster'), Buffer.from('wheel'))

    await client.drive.close(id1)
    await client.drive.close(id2)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can unmount a drive within a remote hyperdrive', async t => {
  const { client, cleanup } = await createOne()

  try {
    const { opts: opts1, id: id1 } = await client.drive.get()
    t.true(opts1.key)
    t.same(id1, 1)

    const { opts: opts2, id: id2 } = await client.drive.get()
    t.true(opts2.key)
    t.same(id2, 2)
    t.notEqual(opts1.key, opts2.key)

    const noVersion = { ...opts2, version: null }

    await client.drive.mount(id1, 'a', noVersion)

    await client.drive.writeFile(id1, 'a/hello', 'world')
    await client.drive.writeFile(id1, 'a/goodbye', 'dog')
    await client.drive.writeFile(id1, 'adios', 'amigo')
    await client.drive.writeFile(id2, 'hamster', 'wheel')

    t.same(await client.drive.readFile(id1, 'adios'), Buffer.from('amigo'))
    t.same(await client.drive.readFile(id1, 'a/hello'), Buffer.from('world'))
    t.same(await client.drive.readFile(id2, 'hello'), Buffer.from('world'))
    t.same(await client.drive.readFile(id2, 'hamster'), Buffer.from('wheel'))

    await client.drive.unmount(id1, 'a')
    try {
      await client.drive.readFile(id1, 'a/hello')
    } catch (err) {
      t.true(err)
      t.same(err.code, 2)
    }

    await client.drive.close(id1)
    await client.drive.close(id2)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

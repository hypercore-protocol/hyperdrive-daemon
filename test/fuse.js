const os = require('os')
const fs = require('fs').promises
const { execSync } = require('child_process')
const test = require('tape')

const constants = require('hyperdrive-daemon-client/lib/constants')
const { create, createOne } = require('./util/create')

function runFuseTests () {
  test('unmounting the root drive cleans up correctly', async t => {
    const { clients, cleanup, daemons } = await create(2)
    const firstClient = clients[0]
    const secondClient = clients[1]
    const firstDaemon = daemons[0]

    await firstDaemon.fuse.mount(constants.mountpoint)
    let dirList = await fs.readdir(constants.mountpoint)
    t.same(dirList, ['Network'])

    await firstDaemon.fuse.unmount(constants.mountpoint)
    dirList = await fs.readdir(constants.mountpoint)
    t.same(dirList, [])

    await cleanup()
    t.end()
  })

  const platform = os.platform()
  console.log('platform:', platform)
  if (platform === 'darwin') {
    runOSXFuseTests()
  } else if (platform === 'linux') {
    runLinuxFuseTests()
  }
}

function runOSXFuseTests () {
  test('(osx only) unmounting the root drive with the Finder open cleans up correctly', async t => {
    const { clients, cleanup, daemons } = await create(2)
    const firstClient = clients[0]
    const secondClient = clients[1]
    const firstDaemon = daemons[0]

    await firstDaemon.fuse.mount(constants.mountpoint)
    let dirList = await fs.readdir(constants.mountpoint)
    t.same(dirList, ['Network'])

    execSync(`open ${constants.mountpoint}`)

    await firstDaemon.fuse.unmount(constants.mountpoint)
    dirList = await fs.readdir(constants.mountpoint)
    t.same(dirList, [])

    await cleanup()
    t.end()
  })
}

function runLinuxFuseTests () {
  console.log('running linux fuse tests')

}

if (process.env['ENABLE_FUSE_TESTS']) {
  runFuseTests()
} else {
  console.log('Skipping FUSE tests because the ENABLE_FUSE_TESTS environment variable is not set.')
}

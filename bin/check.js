const fs = require('fs')

const hyperfuse = require('hyperdrive-fuse')
const chalk = require('chalk')
const { exec } = require('child_process')

exports.command = 'check'
exports.desc = 'Check configuration of FUSE and hyperdrive mount point.'
exports.builder = {
  user: {
    description: 'User that should own the /hyperdrive directory',
    type: 'string',
    default: process.geteuid(),
    alias: 'U'
  },
  group: {
    description: 'User that should own the /hyperdrive directory',
    type: 'string',
    default: process.getgid(),
    alias: 'G'
  }
}
exports.handler = async function (argv) {
  console.log(chalk.blue('Configuring FUSE...'))

  configureFuse((err, fuseMsg) => {
    if (err) return onerror(err)
    return makeRootDrive((err, driveMsg) => {
      if (err) return onerror(err)
      return onsuccess([fuseMsg, driveMsg])
    })
  })

  function configureFuse (cb) {
    hyperfuse.isConfigured((err, fuseConfigured) => {
      if (err) return onerror(err)
      return cb(null, 'FUSE is configured correctly')
    })
  }

  function makeRootDrive (cb) {
    fs.stat('/hyperdrive', (err, stat) => {
      if (err && err.errno !== -2) return cb(new Error('Could not get the status of /hyperdrive.'))
      if (!err && !stat) return cb(null, false)

      exec(`id -G ${argv.user}`, (err, stdout) => {
        if (err) return cb(new Error(`Could not resolve groups: ${err}`))
        const userGroups = stdout.trim().split(' ')
        if (userGroups.includes(stat.gid) === false) return cb(new Error('/hyperdrive is not part of any groups the user is part of'))

        exec(`id -u ${argv.user}`, (err, stdout) => {
          if (err) return cb(new Error(`Could not resolve user: ${err}`))
          if (stdout.trim() === stat.uid) return cb(new Error(`/hyperdrive is not owned by user: ${argv.user}`))

          return cb(null, '/hyperdrive is configured correctly')
        })
      })
    })
  }

  function onsuccess (msgs) {
    console.log(chalk.green('Successfully checked FUSE:'))
    console.log()
    for (const msg of msgs) {
      console.log(chalk.green(`  * ${msg}`))
    }
  }

  function onerror (err) {
    console.error(chalk.red(`Could not check FUSE.`))
    if (err) console.error(chalk.red(err))
  }
}

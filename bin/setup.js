const p = require('path')
const fs = require('fs')
const { exec } = require('child_process')

const mkdirp = require('mkdirp')

const constants = require('hyperdrive-daemon-client/lib/constants')

try {
  var hyperfuse = require('hyperdrive-fuse')
} catch (err) {
  console.warn('FUSE installation failed. You will be unable to mount your hyperdrives.')
}

const chalk = require('chalk')

exports.command = 'setup'
exports.desc = 'Run a one-time configuration step for FUSE.'
exports.builder = {
  user: {
    description: `User that should own the ${constants.mountpoint} directory`,
    type: 'string',
    default: process.geteuid(),
    alias: 'U'
  },
  group: {
    description: 'User that should own the ${constants.mountpoint} directory',
    type: 'string',
    default: process.getegid(),
    alias: 'G'
  },
  force: {
    description: 'Force',
    type: 'boolean',
    default: false,
    alias: 'f'
  }
}
exports.handler = async function (argv) {
  if (!hyperfuse) return onerror('FUSE installation failed.')

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
      if (argv.force === false && fuseConfigured) return cb(null, 'FUSE is already configured.')
      return configure(cb)
    })

    function configure (cb) {
      exec(`sudo ${process.execPath} ${p.join(__dirname, '../scripts/configure.js')}`, err => {
        if (err) return cb(new Error(`Could not configure hyperdrive-fuse: ${err}`))
        return cb(null, 'Successfully configured FUSE!')
      })
    }
  }

  function makeRootDrive (cb) {
    fs.stat(constants.mountpoint, (err, stat) => {
      if (err && err.errno !== -2) return cb(new Error(`Could not get the status of ${constants.mountpoint}.`))
      if (!err && argv.force === false && stat) return cb(null, 'The root hyperdrive directory has already been created.')
      mkdirp(constants.hiddenMountpoint, err => {
        if (err) return cb(new Error(`Could not create the ${constants.hiddenMountpoint} directory.`))
        mkdirp(constants.mountpoint, err => {
          if (err) return cb(new Error(`Could not create the ${constants.mountpoint} directory.`))
          fs.symlink(constants.hiddenMountpoint, constants.mountpoint, err => {
            if (err) return cb(new Error(`Could not symlink ${constants.mountpoint} to ${constants.hiddenMountpoint}.`))
            return cb(null, 'Successfully created the root Hyperdrive directory.')
          })
        })
      })
    })
  }

  function onsuccess (msgs) {
    console.log(chalk.green('Successfully configured FUSE:'))
    console.log()
    for (const msg of msgs) {
      console.log(chalk.green(`  * ${msg}`))
    }
  }

  function onerror (err) {
    console.error(chalk.red(`Could not configure FUSE.`))
    if (err) console.error(chalk.red(err))
  }
}

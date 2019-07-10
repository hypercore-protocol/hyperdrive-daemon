const p = require('path')
const fs = require('fs')
const { spawn, exec } = require('child_process')

const hyperfuse = require('hyperdrive-fuse')
const ora = require('ora')
const chalk = require('chalk')

exports.command = 'setup'
exports.desc = 'Run a one-time configuration step for FUSE.'
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
      if (fuseConfigured) return cb(null, 'FUSE is already configured.')
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
    fs.stat('/hyperdrive', (err, stat) => {
      if (err && err.errno !== -2) return cb(new Error('Could not get the status of /hyperdrive.'))
      if (!err && stat) return cb(null, 'The root hyperdrive directory has already been created.')
      exec('sudo mkdir /hyperdrive', err => {
        if (err) return cb(new Error('Could not create the /hyperdrive directory.'))
        exec(`sudo chown ${process.getuid()}:${process.getgid()} /hyperdrive`, err => {
          if (err) return cb(new Error('Could not change the permissions on the /hyperdrive directory.'))
          return cb(null, 'Successfully created the the root hyperdrive directory.')
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

const p = require('path')
const fs = require('fs').promises
const { exec } = require('child_process')
const { Command, flags } = require('@oclif/command')

const constants = require('hyperdrive-daemon-client/lib/constants')

try {
  var hyperfuse = require('hyperdrive-fuse')
} catch (err) {
  console.warn('FUSE installation failed. You will be unable to mount your hyperdrives.')
}

class SetupCommand extends Command {
  static usage = 'fuse-setup'
  static description = 'Perform a one-time configuration step for FUSE.'
  static flags = {
    user: flags.integer({
      description: `User that should own the ${constants.mountpoint} directory`,
      char: 'U',
      default: process.geteuid()
    }),
    group: flags.integer({
      description: `Group that should own the ${constants.mountpoint} directory`,
      char: 'G',
      default: process.getegid()
    }),
    force: flags.boolean({
      description: 'Force the setup to execute, even if it\'s already been performed once.',
      char: 'f',
      default: 'false'
    })
  }
  async run () {
    if (!hyperfuse) return onerror('FUSE installation failed.')
    const { flags } = this.parse(SetupCommand)

    console.log('Configuring FUSE...')
    await makeRootDrive()
    try {
      await configureFuse()
      console.log('FUSE successfully configured:')
      console.log('  * Your root drive will be mounted at ~/Hyperdrive when the daemon is next started.')
      console.log('  * If your mountpoint ever becomes unresponsive, try running `hyperdrive force-unmount`.')
    } catch (err) {
      console.error('Could not configure the FUSE module:')
      console.error(err)
    }

    async function configureFuse (cb) {
      const configured = await new Promise((resolve, reject) => {
        hyperfuse.isConfigured((err, fuseConfigured) => {
          if (err) return reject(err)
          return resolve(fuseConfigured)
        })
      })
      if (configured) {
        console.log('Note: FUSE is already configured.')
      } else {
        return new Promise((resolve, reject) => {
          exec(`sudo ${process.execPath} ${p.join(__dirname, '../../scripts/configure.js')}`, err => {
            if (err) return reject(err)
            return resolve()
          })
        })
      }
    }

    async function makeRootDrive () {
      try {
        const symlinkStat = await fs.stat(constants.mountpoint)
        const mountpointStat = await fs.stat(constants.hiddenMountpoint)
        if (!mountpointStat) {
          await fs.mkdir(constants.hiddenMountpoint, { recursive: true })
          await fs.chown(constants.hiddenMountpoint, flags.user, flags.group)
        }
        if (!symlinkStat) {
          await fs.symlink(constants.hiddenMountpoint, constants.mountpoint)
        }
      } catch (err) {
        console.error('Could not create the FUSE mountpoint:')
        console.error(err)
      }
    }
  }
}

module.exports = SetupCommand

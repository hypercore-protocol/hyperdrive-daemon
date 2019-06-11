const p = require('path')
const { spawn, exec } = require('child_process')

const hyperfuse = require('hyperdrive-fuse')
const ora = require('ora')
const chalk = require('chalk')

exports.command = 'setup'
exports.desc = 'Run a one-time configuration step for FUSE.'
exports.handler = async function (argv) {
  console.log(chalk.blue('Configuring FUSE...'))
  hyperfuse.isConfigured((err, configured) => {
    if (err) return onerror(err)
    if (configured) return onsuccess('FUSE is already configured!')
    return configure()
  })

  function configure () {
    exec('which node', (err, nodePath) => {
      if (err) return onerror(err)
      nodePath = nodePath.trim()
      const child = spawn('sudo', [nodePath, p.join(__dirname, '../scripts/configure.js')], {
        stdio: 'inherit'
      })
      child.on('exit', code => {
        if (code !== 0) return onerror() 
        return onsuccess('Successfully configured FUSE!')
      })
    })
  }

  function onsuccess (msg) {
    console.log(chalk.green(msg))
  }

  function onerror (err) {
    console.error(chalk.red(`Could not configure FUSE.`))
    if (err) console.error(chalk.red(err))
  }
}

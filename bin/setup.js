const p = require('path')
const { spawn } = require('child_process')

const hyperfuse = require('hyperdrive-fuse')
const ora = require('ora')
const chalk = require('chalk')

exports.command = 'setup'
exports.desc = 'Run a one-time configuration step for FUSE.'
exports.handler = async function (argv) {
  console.log(chalk.blue('Configuring FUSE...'))
  const child = spawn('sudo', ['node', p.join(__dirname, '../scripts/configure.js')], {
    stdio: 'inherit'
  })
  child.on('exit', code => {
    if (code !== 0) return console.error(chalk.red(`Could not configure FUSE.`))
    console.log(chalk.green('Successfully configured FUSE!'))
  })
}

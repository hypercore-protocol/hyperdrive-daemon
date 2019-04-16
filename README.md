# ⏏️ hypermount
A FUSE-mountable distributed filesystem, built with Hyperdrive.

Hypermount lets your mount Hyperdrives as directories on both OSX and Linux. To create a new mounted Hyperdrive, just run `hypermount mount <an empty dir>` -- hypermount will generate and seed a new Hyperdrive for you, mounted at the specified directory, and it will give you a key you can share with others. To mount someone else's Hyperdrive, just run `hypermount mount <an empty dir> <key>`!

To make it easier to mount multiple drives, Hypermount runs as a daemonized HTTP server. It maintains a database of mounted Hyperdrives, which it will automatically remount when the daemon is started and unmount when it's stopped.

Under the hood, this module uses [corestore](https://github.com/andrewosh/corestore) to manage and seed your library of hypercores.

## Installation
```
npm i hypermount -g
```

### Setup

When you first install Hypermount, you'll need to perform a setup step that will install native, prebuilt FUSE bindings. We currently only provide bindings for OSX and Linux. The setup step is the only step that requires `sudo`.
```
❯ hypermount setup
Configuring FUSE...
[sudo] password for andrewosh:
Successfully configured FUSE!
```

You should only need to perform this step once (it will persist across restarts).

## Usage

Hypermount provides an HTTP interface for mounting, unmounting, and providing status information about all current mounts. There's also a bundled CLI tool

## License

MIT

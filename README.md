# ⏏️ hypermount
A FUSE-mountable distributed filesystem, built with Hyperdrive.

Hypermount lets your mount Hyperdrives as directories on both OSX and Linux. To generate and seed a new Hyperdrive, mounted at a  just run:
```
❯ hypermount mount me
Mounted 8a18b05e95e2e20eca9e66cdeff5b926c7c553edc34c7ffc06054edbb1810f7e at friends/me
```
This command will give you a Hyperdrive key you can share with others. A friend can subsequently mount this drive:
```
❯ hypermount mount andrew 8a18b05e95e2e20eca9e66cdeff5b926c7c553edc34c7ffc06054edbb1810f7e
Mounted 8a18b05e95e2e20eca9e66cdeff5b926c7c553edc34c7ffc06054edbb1810f7e at friends/andrew
```

Once your drives are mounted, you can treat them as you would any other directory!

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

Hypermount provides an HTTP interface for mounting, unmounting, and providing status information about all current mounts. There's also a bundled CLI tool which wraps the HTTP interfaces and provides the following commands:

#### `hypermount setup`
Performs a one-time configuration step that installs FUSE. This command will prompt you for `sudo`.

#### `hypermount mount <mountpoint> [key]`
If a key is specified, create a Hyperdrive using that key. If not, generate a new one. Once the drive has been created, mount it at `mountpoint`.

This command takes options:
```
--sparse          Create a sparse content feed.      [boolean] [default: true]
--sparseMetadata  Create a sparse metadata feed.     [boolean] [default: true]
```

#### `hypermount unmount <mountpoint>`
Unmount a Hyperdrive that's been previously mounted at `mountpoint`, if it exists.

*Note: This command will currently not delete or unseed the Hyperdrive. Support for this will be added soon.

#### `hypermount list`
Display information about all mounted Hyperdrives.

The output takes the form:
```
❯ hypermount list
35127c7db33e884a8b5b054aa8bef510c6faf3688265f0d885241731bf0354b4 => /home/andrewosh/friends/a
  Network Stats:
    Metadata:
      Uploaded:   0 MB
      Downloaded: 0 MB
    Content:
      Uploaded:   0 MB
      Downloaded: 0 MB
1fb343ab8362b84155e7554a42d023b376aa71cdc9d94ca9a4efee8a58326d03 => /home/andrewosh/friends/b
  Network Stats:
    Metadata:
      Uploaded:   0 MB
      Downloaded: 0 MB
    Content:
      Uploaded:   0 MB
      Downloaded: 0 MB
...
```

#### `hypermount status`
Display status information about the Hypermount daemon.

#### `hypermount start`
Launch the Hypermount daemon. When this command is executed, it will use the current working directory as its storage/logging directory. This command must be run before any additional commands (except for `setup`) will work.

Takes these options:
```
  --port             The HTTP port that the daemon will bind to. [number] [default: 3101]
  --replicationPort  The port that the hypercore replicator will bind to. [number] [default: 3102]
```

#### `hypermount stop`
Unmount all mounted Hyperdrives and stop the daemon.

## License

MIT

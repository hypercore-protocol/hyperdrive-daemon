# ⛰️ hyperdrive-daemon
*Note: This is currently a prerelease based on the [`v10`](https://github.com/mafintosh/hyperdrive/tree/v10) branch of Hyperdrive. It should be relatively stable, but expect some roughness around the edges.*

A daemon for creating, storing and sharing Hyperdrives. Provides both a gRPC API (see [`hyperdrive-daemon-client`](https://github.com/andrewosh/hyperdrive-daemon-client)), and an optional FUSE interface for mounting drives as directories.

If you choose to use FUSE, the Hyperdrive daemon lets your mount Hyperdrives as directories on both OSX and Linux. The daemon requires all users to have a private "root" drive, into which additional subdrives can be mounted and shared with others. After starting the daemon, you can create your root drive as follows:
```
❯ hyperdrive fs mount
Mounted a drive with the following info:

  Mountpoint: /home/foo/Hyperdrive 
  Key:        49c5b9e4ac75a0f0b00ab911975837dd0c8d429512a13413fe2dad768fc9a0f2 
  Seeding:    false

This drive is private by default. To publish it, run `hyperdrive fs publish ~/Hyperdrive` 
```

You likely won't want to publish or share your root drive with others, but you can create shareable subdrives using the same command:
```
❯ hyperdrive fs mount ~/Hyperdrive/home/videos
Mounted a drive with the following info:

  Mountpoint: /home/foo/Hyperdrive/home/videos 
  Key:        b432f90b2f817164c32fe5056a06f50c60dc8db946e81331f92e3192f6d4b847 
  Seeding:    false

This drive is private by default. To publish it, run `hyperdrive fs publish ~/Hyperdrive/home/videos` 
```

Once your drives are mounted, you can treat them as you would any other directory!

Subdrives are private by default (they will not be advertised on the network), but you can make them available with the `fs publish` command:
```
❯ hyperdrive fs publish ~/Hyperdrive/home/videos
Published the drive mounted at ~/Hyperdrive/home/videos
```

After publishing, another user can either:
1. Mount the same subdrive by key within their own root drive
2. Inspect the drive inside the `~/Hyperdrive/by-key` directory (can be a symlink target outside the FUSE mount!):
```
❯ hyperdrive fs key ~/Hyperdrive/home/videos 
b432f90b2f817164c32fe5056a06f50c60dc8db946e81331f92e3192f6d4b847

❯ ls ~/Hyperdrive/by-key/b432f90b2f817164c32fe5056a06f50c60dc8db946e81331f92e3192f6d4b847
vid.mkv
```
Or:
```
❯ hyperdrive fs mount ~/Hyperdrive/home/a_friends_videos b432f90b2f817164c32fe5056a06f50c60dc8db946e81331f92e3192f6d4b847
...
❯ ls ~/Hyperdrive/home/a_friends_videos 
vid.mkv
```

## Installation
```
npm i hyperdrive-daemon@beta -g
```

### Setup

When you first install Hypermount, you'll need to perform a setup step that will install native, prebuilt FUSE bindings. We currently only provide bindings for OSX and Linux. The setup step is the only step that requires `sudo`.
```
❯ hyperdrive setup
Configuring FUSE...
[sudo] password for andrewosh:
Successfully configured FUSE!
```

You should only need to perform this step once (it will persist across restarts).

### Starting the Daemon

After installing/configuring, you'll need to start the daemon before running any other commands. To do this, first pick a storage directory for your mounted Hyperdrives. By default, the daemon will use `~/.hyperdrive/storage`.

```
❯ hyperdrive start
Daemon started at http://localhost:3101
```

If you want to stop the daemon, you can run:
```
❯ hyperdrive stop
The Hyperdrive daemon has been stopped.
```

## API
The daemon exposes a gRPC API for interacting with remote Hyperdrives. [`hyperdrive-daemon-client`](https://github.com/andrewosh/hyperdrive-daemon-client) is a Node client that you can use to interact with the API. If you'd like to write a client in another language, check out the schema definitions in [`hyperdrive-schemas`](https://github.com/andrewosh/hyperdrive-schemas)

## CLI

Hypermount provides an gRPC interface for mounting, unmounting, and providing status information about all current mounts. There's also a bundled CLI tool which wraps the gRPC API and provides the following commands:

### Basic Commands 
#### `hyperdrive setup`
Performs a one-time configuration step that installs FUSE. This command will prompt you for `sudo`.

#### `hyperdrive start`
Start the Hyperdrive daemon.

Options include:
```
  --bootstrap ['host:port', 'host:port', ...] // Optional, alternative bootstrap servers
  --storage   /my/storage/dir                 // The storage directory. Defaults to ~/.hyperdrive/storage
  --log-level info                            // Logging level
  --port      3101                            // The port gRPC will bind to.
```

#### `hyperdrive status`
Gives the current status of the daemon.

#### `hyperdrive stop`
Stop the daemon

### FUSE Commands
All filesystem-related commands are accessed through the `fs` subcommand. 

#### `hyperdrive fs mount`
(FUSE) mount hyperdrive FS at `~/Hyperdrive`. This includes `~/Hyperdrive/home`, your top-level, private Hyperdrive -- Any drives you'd like to share with others must be created by mounting (a Hyperdrive mount, not a FUSE mount) a subdrive under this path. 

Your root drive will persist across restarts. You can use it as a replacement for your normal home directory!


#### `hyperdrive fs mount <mountpoint> [key]`
(Hyperdrive) mount a subdrive within your root drive.

Newly-created drives are private by default, and can be made available to the network with `hyperdrive fs publish <mountpoint>`.

- `mountpoint` must be a subdirectory of `~/Hyperdrive/home`. 
- `key` is an optional drive key. If `key` is specified, it will be advertised on the network by default, and your drive will be read-only.

#### `hyperdrive fs key <mountpoint>`
Display the drive key for `<mountpoint>`.

#### `hyperdrive fs publish <mountpoint>`
Share the subdrive to other network peers who have the drive key.  

- `mountpoint` must be a subdirectory of `~/Hyperdrive/home` and must have been previously mounted with the mount subcommand described above.

#### `hyperdrive fs unpublish <mountpoint>`
Stop advertising a previously-published subdrive on the network.

*Note: This command will currently not delete the Hyperdrive. Support for this will be added soon.*

#### `hyperdrive fs force-unmount`
If the daemon fails or is not stopped cleanly, then the `~/Hyperdrive` mountpoint might be left in an unusable state. Running this command before restarting the daemon will forcibly disconnect the mountpoint.

## License

MIT

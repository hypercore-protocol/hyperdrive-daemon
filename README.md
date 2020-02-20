# ⛰️ hyperdrive-daemon
[![Build Status](https://travis-ci.com/andrewosh/hyperdrive-daemon.svg?branch=master)](https://travis-ci.com/andrewosh/hyperdrive-daemon)

The Hyperdrive daemon helps you create, share, and manage Hyperdrives through a persistent process running on your computer, without having to deal with storage management or networking configuration. It provides both a gRPC API (see [`hyperdrive-daemon-client`](https://github.com/andrewosh/hyperdrive-daemon-client)) for interacting with remote drives, and an optional FUSE interface for mounting drives as directories in your local filesystem.

#### Features
* __Hyperswarm Networking__: Hyperdrives are announced and discovered using the [Hyperswarm DHT](https://github.com/hyperswarm/hyperswarm)
* __Easy Storage__: All your Hyperdrives are stored in a single spot, the `~/.hyperdrive/storage` directory.
* __gRPC API__: The daemon exposes an API for managing remote Hyperdrives over gRPC. We currently have a [NodeJS client](https://github.com/andrewosh/hyperdrive-daemon-client).
* __FUSE support__: If you're using Linux or Mac, you can mount Hyperdrives as directories and work with them using standard filesystem syscalls.
* __CLI Tools__: The `hyperdrive` CLI supports a handful of commands for managing the daemon, creating/sharing drives, getting statistics, and augmenting the FUSE interface to support Hyperdrive-specific functions (like mounts).
* __Persistence__: Networking configuration info is stored in a [Level](https://github.com/level/level) instance, so your drives will reconnect to the network automatically when the daemon's restarted.
* __PM2 Process Management__: We use [PM2](https://github.com/Unitech/pm2) to manage the daemon process. Separately installing the PM2 CLI gives you access to extra monitoring, and support for installing the Hyperdrive daemon as a system daemon.

#### :warning: Beta Notice :warning:
During the beta period, we'll be collecting simple telemetry (such as memory usage and DHT info) by default. The telemetry updates do not contain any Hyperdrive keys, and you can see exactly what we send [here](https://github.com/andrewosh/hyperdrive-daemon/blob/master/lib/telemetry.js).

If you're not comfortable sharing these stats, you can disable telemetry by starting the daemon with the `--no-telemetry` flag.

## Installation
```
npm i hyperdrive-daemon@beta -g
```
*Note: Make sure you're installing the `@beta` version for now!*

### Starting the daemon

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

### Checking the status

After it's been started, you can check if the daemon's running (and get lots of useful information) with the `status` command:
```
❯ hyperdrive status
The Hyperdrive daemon is running:

  API Version:             0
  Daemon Version:          1.7.15
  Client Version:          1.7.6
  Schema Version:          1.6.5
  Hyperdrive Version:      10.8.15
  Fuse Native Version:     2.2.1
  Hyperdrive Fuse Version: 1.2.14

  Holepunchable:           true
  Remote Address:          194.62.216.174:35883

  Uptime:                  0 Days 1 Hours 6 Minutes 2 Seconds
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

## FUSE
With FUSE, the Hyperdrive daemon lets your mount Hyperdrives as directories on both OSX and Linux. To use FUSE, you need to run the `setup` command before you start the daemon the first time:

### Setup
The setup command installs native, prebuilt FUSE bindings. We currently only provide bindings for OSX and Linux. The setup step is the only part of installation that requires `sudo` access:
```
❯ hyperdrive setup
Configuring FUSE...
[sudo] password for andrewosh:
Successfully configured FUSE!
```

You should only need to perform this step once (it will persist across restarts). In order to make sure that the setup step completed successfully, run the `fs status` command:
```
❯ hyperdrive fs status
FUSE Status:
  Available: true
  Configured: true
```

If FUSE is both available and configured, then you're ready to continue with mounting your top-level, private drive!

### Usage
The daemon requires all users to have a private "root" drive, into which additional subdrives can be mounted and shared with others. Think of this root drive as the Home directory on your computer (where you might have Documents, Photos, Videos directories, for example). After starting the daemon, you can create your root drive as follows:
```
❯ hyperdrive fs mount
Mounted a drive with the following info:

  Mountpoint: /home/andrewosh/Hyperdrive 
  Key:        6490153bc73e86563a3794a9e796be49441381ff27a6423acb7c90e464072bed 
  Published:  false

This drive is private by default. To publish it, run `hyperdrive fs publish /home/andrewosh/Hyperdrive` 
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

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
  --port      3101                            // The port gRPC will bind to
  --memory-only                               // Run in in-memory mode
  --foreground                                // Do not launch a separate, PM2-managed process
  --no-telemetry                              // Disable telemetry
```

#### `hyperdrive status`
Gives the current status of the daemon, as well as version/networking info.

#### `hyperdrive stop`
Stop the daemon.

## FUSE
Using FUSE, the Hyperdrive daemon lets your mount Hyperdrives as normal filesystem directories on both OSX and Linux. To use FUSE, you need to run the `setup` command before you start the daemon the first time:

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
The daemon requires all users to have a private "root" drive, mounted at `~/Hyperdrive`, into which additional subdrives can be mounted and shared with others.

Think of this root drive as the `home` directory on your computer, where you might have Documents, Photos, or Videos directories. You'll likely never want to share your complete Documents folder with someone, but you can create a shareable mounted drive `Documents/coding-project-feb-2020` to share with collaborators on that project. 

#### Basic Mounting
After starting the daemon, you can create your root drive using the `fs mount` command without additional arguments:
```
❯ hyperdrive fs mount
Mounted a drive with the following info:

  Mountpoint: /home/andrewosh/Hyperdrive 
  Key:        6490153bc73e86563a3794a9e796be49441381ff27a6423acb7c90e464072bed 
  Published:  false

This drive is private by default. To publish it, run `hyperdrive fs publish /home/andrewosh/Hyperdrive` 
```

To create a mount in FUSE, you can use the `fs mount` command with `key` and `mountpoint` arguments. The `mountpoint` must always be a directory within your root drive, and the `key` is optional (if it isn't specified, this will create a new drive for you).

To mount a new drive, you can either provide a complete path to the desired mountpoint, or you can use a relative path if your current working directory is within `~/Hyperdrive`. As an example, here's how you would create a shareable drive called `Videos`, mounted inside your root drive:
```
❯ hyperdrive fs mount ~/Hyperdrive/videos
Mounted a drive with the following info:

  Mountpoint: /home/foo/Hyperdrive/home/videos 
  Key:        b432f90b2f817164c32fe5056a06f50c60dc8db946e81331f92e3192f6d4b847 
  Seeding:    false

This drive is private by default. To publish it, run `hyperdrive fs publish ~/Hyperdrive/home/videos` 
```

Equivalently:
```
❯ cd ~/Hyperdrive
❯ hyperdrive fs mount Videos
```

For most purposes, you can just treat this mounted drive like you would any other directory. The `hyperdrive` CLI gives you a few mount-specific commands for sharing drive keys and getting statistics for mounted drives.

Mounted subdrives are private by default (they will not be advertised on the network), but you can make them available with the `fs publish` command:
```
❯ hyperdrive fs publish ~/Hyperdrive/Videos
Published the drive mounted at ~/Hyperdrive/Videos
```

Publishing will start announcing the drive's discovery key on the hyperswarm DHT, and this setting is persistent -- the drive will be reannounced when the daemon is restarted.

After publishing, another user can either:
1. Mount the same subdrive by key within their own root drive
2. Inspect the drive inside the `~/Hyperdrive/Network` directory (can be a symlink target outside the FUSE mount!):
```
❯ hyperdrive fs key ~/Hyperdrive/Videos
b432f90b2f817164c32fe5056a06f50c60dc8db946e81331f92e3192f6d4b847

❯ ls ~/Hyperdrive/Network/b432f90b2f817164c32fe5056a06f50c60dc8db946e81331f92e3192f6d4b847
vid.mkv
```
Or:
```
❯ hyperdrive fs mount ~/Hyperdrive/a_friends_videos b432f90b2f817164c32fe5056a06f50c60dc8db946e81331f92e3192f6d4b847
...
❯ ls ~/Hyperdrive/home/a_friends_videos
vid.mkv
```

If you ever want to remove a mountpoint, you can use the `hyperdrive fs unmount` command.

### The `Network` "Magic Folder"

Within your root drive, you'll see a special directory called `~/Hyperdrive/Network`. This is a virtual directory (it does not actually exist inside the drive), but it provides read-only access to useful information, such as storage/networking stats for any drive in the daemon. Here's what you can do with the `Network` directory:

#### Global Drive Paths
For any drive that's being announced on the DHT, `~/Hyperdrive/Network/<drive-key>` will contain that drive's contents. This is super useful because these paths will be consistent across all daemon users! If you have an interesting file you want to share over IRC, you can just copy+paste `cat ~/Hyperdrive/Network/<drive-key>/my-interesting-file.txt` into IRC and that command will work for everyone.

#### Storage/Networking Statistics
Inside `~/Hyperdrive/Network/Stats/<drive-key>` you'll find two files: `storage.json` and `networking.json` containing an assortment of statistics relating to that drive, such as per-file storage usage, current peers, and uploaded/downloaded bytes of the drive's metadata and content feeds.

*Note: `storage.json` is dynamically computed every time the file is read -- if you have a drive containing millions of files, this can be an expensive operation, so be careful.*

Since looking at `networking.json` is a common operation, we provide a shorthand command `hyperdrive fs stats` that prints this file for you. It uses your current working directory to determine the key of the mounted drive you're in.

#### Active Drives
The `~/Hyperdrive/Network/Active` directory contains symlinks to the `networking.json` stats files for every drive that your daemon is currently announcing. `ls`ing this directory gives you a quick overview of exactly what you're announcing.

### FUSE Commands
All filesystem-related commands are accessed through the `fs` subcommand.

#### `hyperdrive fs status`
Get FUSE-related status information. In order to use FUSE, both `available` and `configured` must be true. 

*Note: Always be sure to run `hyperdrive setup` and check the FUSE status before doing any additional `fs` commands!*

#### `hyperdrive fs mount`
Mount your root drive at `~/Hyperdrive`. Any drives you'd like to share with others must be created by mounting (a Hyperdrive mount, not a FUSE mount) a subdrive under this path using the command below. 

Your root drive will persist across restarts. You can use it as a replacement for your normal home directory! 

If you'd ever like to create a fresh root drive, you can force its creation with the `force-create` flag. If this isn't set, your previous root drive will always be reused.

#### `hyperdrive fs mount <mountpoint> [key]`
(Hyperdrive) mount a subdrive within your root drive.

Newly-created drives are private by default, and can be made available to the network with `hyperdrive fs publish <mountpoint>`.

- `mountpoint` must be a subdirectory of `~/Hyperdrive/home`. 
- `key` is an optional drive key. If `key` is specified, it will be advertised on the network by default, and your drive will be read-only (unless you're the original creator of this drive).

CLI options include:
```
  --checkout (version) // Mount a static version of a drive.
```

#### `hyperdrive fs key <mountpoint>`
Display the drive key for a mounted drive. 

- `mountpoint` must be a subdirectory of `~/Hyperdrive/` and must have been previously mounted with the mount subcommand described above. If `mountpoint` is not specified, the command will use the enclosing mount of your current working directory.

By default, this command will refuse to display the key of your root drive (to dissuade accidentally sharing it). To forcibly display your root drive key, run this command with `--root`.

CLI options include:
```
  --root // Forcibly display your root drive key.
```

#### `hyperdrive fs publish <mountpoint>`
Start announcing a drive on the DHT so that it can be shared with other peers.

- `mountpoint` must be a subdirectory of `~/Hyperdrive/` and must have been previously mounted with the mount subcommand described above. If `mountpoint` is not specified, the command will use the enclosing mount of your current working directory.

By default, this command will refuse to publish your root drive (to dissuade accidentally sharing it). To forcibly publish your root drive, run this command with `--root`.

CLI options include:
```
  --lookup (true|false)   // Look up the drive key on the DHT. Defaults to true
  --announce (true|false) // Announce the drive key on the DHT. Defaults to true
  --remember (true|false) // Persist these network settings in the database.
  --root                  // Forcibly display your root drive key.
```

#### `hyperdrive fs unpublish <mountpoint>`
Stop advertising a previously-published subdrive on the network.

- `mountpoint` must be a subdirectory of `~/Hyperdrive/` and must have been previously mounted with the mount subcommand described above. If `mountpoint` is not specified, the command will use the enclosing mount of your current working directory.

*Note: This command will currently not delete the Hyperdrive. Support for this will be added soon.*

#### `hyperdrive fs stats <mountpoint>`
Display networking statistics for a drive. This is a shorthand for getting a drive's key with `hyperdrive fs key` and `cat`ing `~/Hyperdrive/Network/Stats/<drive-key>/networking.json`.

- `mountpoint` must be a subdirectory of `~/Hyperdrive/` and must have been previously mounted with the mount subcommand described above. If `mountpoint` is not specified, the command will use the enclosing mount of your current working directory.

#### `hyperdrive fs force-unmount`
If the daemon fails or is not stopped cleanly, then the `~/Hyperdrive` mountpoint might be left in an unusable state. Running this command before restarting the daemon will forcibly disconnect the mountpoint.

This command should never be necessary! If your FUSE mountpoint isn't cleaned up on shutdown, and you're unable to restart your daemon (due to "Mountpoint in use") errors, please file an issue.

## License
MIT

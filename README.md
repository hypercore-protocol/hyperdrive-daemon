# hyperdrive-daemon
[![Build Status](https://travis-ci.com/hypercore-protocol/hyperdrive-daemon.svg?branch=master)](https://travis-ci.com/github/hypercore-protocol/hyperdrive-daemon)

The Hyperdrive daemon helps you create, share, and manage Hyperdrives through a persistent process running on your computer, without having to deal with storage management or networking configuration.

It provides both a gRPC API (see [`hyperdrive-daemon-client`](https://github.com/andrewosh/hyperdrive-daemon-client)) for interacting with remote drives, and an optional FUSE interface for mounting drives as directories in your local filesystem.

#### Features
* __Hyperswarm Networking__: Hyperdrives are announced and discovered using the [Hyperswarm DHT](https://github.com/hyperswarm/hyperswarm).
* __Easy Storage__: All your Hyperdrives are stored in a single spot, the `~/.hyperdrive/storage` directory.
* __gRPC API__: The daemon exposes an API for managing remote Hyperdrives over gRPC. We currently have a [NodeJS client](https://github.com/andrewosh/hyperdrive-daemon-client).
* __FUSE support__: If you're using Linux or Mac, you can mount Hyperdrives as directories and work with them using standard filesystem syscalls.
* __CLI Tools__: The `hyperdrive` CLI supports a handful of commands for managing the daemon, creating/sharing drives, getting statistics, and augmenting the FUSE interface to support Hyperdrive-specific functions (like mounts).
* __Persistence__: Networking configuration info is stored in a [Level](https://github.com/level/level) instance, so your drives will reconnect to the network automatically when the daemon's restarted.
* __PM2 Process Management__: We use [PM2](https://github.com/Unitech/pm2) to manage the daemon process. Separately installing the PM2 CLI gives you access to extra monitoring, and support for installing the Hyperdrive daemon as a system daemon

## Installation
*Note: The daemon CLI currently requires Node 12 or greater*

__Temporary Note: We're working out a [segfault issue](https://github.com/hypercore-protocol/hyperdrive-daemon/issues/47) that's causing the daemon to fail with Node 14. If you're on 14, check that issue for updates, but for now try using 12 or 13__.

```
npm i hyperdrive-daemon -g
```

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
#### `hyperdrive fuse-setup`
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
```

#### `hyperdrive status`
Gives the current status of the daemon, as well as version/networking info, and FUSE availability info.

#### `hyperdrive stop`
Stop the daemon.

### Importing/Exporting
If you're on a system that doesn't support FUSE, or you just don't want to bother with it, the CLI provides the `import` and `export` commands for moving files in and out of Hyperdrives.

#### Importing
To import a directory into a new Hyperdrive, you can run `import` without specifying a key:
```
❯ hyperdrive import ./path/to/directory
Importing path/to/directory into aae4f36bd0b1a7a8bf68aa0bdd0b93997fd8ff053f4a3e816cb629210aa17737 (Ctrl+c to exit)...

Importing | ======================================== | 100% | 3/3 Files
```

The command will remain running, watching the directory for any new changes, but you can always stop it with `Ctrl+c`

`import` will save a special file called `.hyperdrive-import-key` inside the directory you uploaded. This makes it easier to resume a previous import later, without any additional arguments. 

Using the command above as an example, `hyperdrive import path/to/directory` subsequent times will always import into drive `aae4f36bd0b1a7a8bf68aa0bdd0b93997fd8ff053f4a3e816cb629210aa17737`.

#### Exporting
`hyperdrive export` is just the inverse of `import`: Given a key it will export the drive's contents into a directory:
```
❯ hyperdrive export aae4f36bd0b1a7a8bf68aa0bdd0b93997fd8ff053f4a3e816cb629210aa17737
Exporting aae4f36bd0b1a7a8bf68aa0bdd0b93997fd8ff053f4a3e816cb629210aa17737 into (my working directory)/aae4f36bd0b1a7a8bf68aa0bdd0b93997fd8ff053f4a3e816cb629210aa17737 (Ctrl+c to exit)...

Exporting | ======================================== | 100% | 5/5 Metadata Blocks | 0 Peers
```
Unless an output directory is specified, `export` will store files in a subdirectory with the drive's key as its name.

As with `import`, `export` will store a special file which lets you resume exports easily (just `cd` into your previous output directory and run `hyperdrive export`), and it will remain running, watching the remote drive for changes.

### Debugging Commands
If you're testing bug fixes or features, some of these commands might be useful for you.

#### `hyperdrive cleanup:remove-readonly-drives`
Delete all read-only drives from disk. This will clear up storage, and makes it easier to test networking issues during development (as running this command will force you to re-sync test drives when the daemon is restarted).

This command *must not* be run while the daemon is running. Since it deletes data, it's intentionally verbose!

## FUSE
Using FUSE, the Hyperdrive daemon lets your mount Hyperdrives as normal filesystem directories on both OSX and Linux. To use FUSE, you need to run the `setup` command before you start the daemon the first time:

### Setup
The setup command installs native, prebuilt FUSE bindings. We currently only provide bindings for OSX and Linux. The setup step is the only part of installation that requires `sudo` access:
```
❯ hyperdrive fuse-setup
Configuring FUSE...
[sudo] password for andrewosh:
Successfully configured FUSE!
```

You should only need to perform this step once (it will persist across restarts). In order to make sure that the setup step completed successfully, run the `status` command. It should contain the following two FUSE-related lines:
```
❯ hyperdrive status
...
  Fuse Available: true
  Fuse Configured: true
```

If FUSE is both available and configured, then you're ready to continue with mounting your top-level, private drive!

### Usage
The daemon requires all users to have a private "root" drive, mounted at `~/Hyperdrive`, into which additional subdrives can be mounted and shared with others.

Think of this root drive as the `home` directory on your computer, where you might have Documents, Photos, or Videos directories. You'll likely never want to share your complete Documents folder with someone, but you can create a shareable mounted drive `Documents/coding-project-feb-2020` to share with collaborators on that project. 

#### Basic Mounting
After starting the daemon with FUSE configured, you'll find a fresh root drive automatically mounted for you at `~/Hyperdrive`. This root drive will persist across daemon restarts, so it should always be available (just like your usual Home directory!).

As with a home directory, you can might want to create directories like `~/Hyperdrive/Documents`, `~/Hyperdrive/Videos`, and `~/Hyperdrive/Projects`. Be careful though -- any directory you create with `mkdir` or through the OSX Finder will not be drive mounts, so they will not be shareable with others.

There are two ways to create a shareable drive inside your root drive:
1. `hyperdrive create [path]` - This will create a new shareable drive at `path` (where `path` must be a subdirectory of `~/Hyperdrive`. This drive will look like a normal directory, but if you run `hyperdrive info [path]` it will tell you that it's shareable.
2. `hyperdrive mount [path] [key]` - This will mount an existing drive at `path`. It's useful if someone is sharing one of their drives with you, and you want to save it into your root drive.

Here are a few examples of what this flow might look like:

To mount a new drive, you can either provide a complete path to the desired mountpoint, or you can use a relative path if your current working directory is within `~/Hyperdrive`. As an example, here's how you would create a shareable drive called `Videos`, mounted inside your root drive:
```
❯ hyperdrive create ~/Hyperdrive/videos
Mounted a drive with the following info:

  Path      : /home/foo/Hyperdrive/videos 
  Key:        b432f90b2f817164c32fe5056a06f50c60dc8db946e81331f92e3192f6d4b847 
  Seeding:    true
```

*__Note:__ Unless you use the `no-seed` flag, all new drives will be automatically "seeded," meaning they'll be announced on the Hyperswarm DHT. In the above example, this could be done with `hyperdrive create ~/Hyperdrive/videos --no-seed`. To announce it later, you can run `hyperdrive seed ~/Hyperdrive/videos`.*

Equivalently:
```
❯ cd ~/Hyperdrive
❯ hyperdrive create Videos
```

For most purposes, you can just treat this mounted drive like you would any other directory. The `hyperdrive` CLI gives you a few mount-specific commands for sharing drive keys and getting statistics for mounted drives.

Mounted subdrives are seeded (announced on the DHT) by default, but if you've chosen to not seed (via the `--no-seed` flag), you can make them available with the `seed` command:
```
❯ hyperdrive seed ~/Hyperdrive/Videos
Seeding the drive mounted at ~/Hyperdrive/Videos
```

Seeding will start announcing the drive's discovery key on the hyperswarm DHT, and this setting is persistent -- the drive will be reannounced when the daemon is restarted.

After seeding, another user can either:
1. Mount the same subdrive by key within their own root drive
2. Inspect the drive inside the `~/Hyperdrive/Network` directory (can be a symlink target outside the FUSE mount!):
```
❯ hyperdrive info ~/Hyperdrive/Videos
Drive Info:

  Key:          b432f90b2f817164c32fe5056a06f50c60dc8db946e81331f92e3192f6d4b847
  Is Mount:     true 
  Writable:     true

❯ ls ~/Hyperdrive/Network/b432f90b2f817164c32fe5056a06f50c60dc8db946e81331f92e3192f6d4b847
vid.mkv
```
Or:
```
❯ hyperdrive mount ~/Hyperdrive/a_friends_videos b432f90b2f817164c32fe5056a06f50c60dc8db946e81331f92e3192f6d4b847
...
❯ ls ~/Hyperdrive/home/a_friends_videos
vid.mkv
```

If you ever want to remove a drive, you can use the `hyperdrive unmount [path]` command.

### The `Network` "Magic Folder"

Within your root drive, you'll see a special directory called `~/Hyperdrive/Network`. This is a virtual directory (it does not actually exist inside the drive), but it provides read-only access to useful information, such as storage/networking stats for any drive in the daemon. Here's what you can do with the `Network` directory:

#### Global Drive Paths
For any drive that's being announced on the DHT, `~/Hyperdrive/Network/<drive-key>` will contain that drive's contents. This is super useful because these paths will be consistent across all daemon users! If you have an interesting file you want to share over IRC, you can just copy+paste `cat ~/Hyperdrive/Network/<drive-key>/my-interesting-file.txt` into IRC and that command will work for everyone.

#### Storage/Networking Statistics
Inside `~/Hyperdrive/Network/Stats/<drive-key>` you'll find two files: `storage.json` and `networking.json` containing an assortment of statistics relating to that drive, such as per-file storage usage, current peers, and uploaded/downloaded bytes of the drive's metadata and content feeds.

*__Note__: `storage.json` is dynamically computed every time the file is read -- if you have a drive containing millions of files, this can be an expensive operation, so be careful.*

Since looking at `networking.json` is a common operation, we provide a shorthand command `hyperdrive stats` that prints this file for you. It uses your current working directory to determine the key of the mounted drive you're in.

#### Active Drives
The `~/Hyperdrive/Network/Active` directory contains symlinks to the `networking.json` stats files for every drive that your daemon is currently announcing. `ls`ing this directory gives you a quick overview of exactly what you're announcing.

### FUSE Commands
*Note: Always be sure to run `hyperdrive setup` and check the FUSE status before doing any additional FUSE-related commands!*

#### `hyperdrive create <path>`
Create a new drive mounted at `path`.

Newly-created drives are seeded by default. This behavior can be disabled with the `no-seed` flag, or toggled later through `hyperdrive seed <path>` or `hyperdrive unseed <path>`

Options include:
```
  --no-seed // Do not announce the drive on the DHT.
```

#### `hyperdrive mount <path> <key>`
Mount an existing Hyperdrive into your root drive at path `path`.

If you don't specify a `key`, the `mount` command will behave identically to `hyperdrive create`.

- `path` must be a subdirectory of `~/Hyperdrive/home`. 
- `key` is an optional drive key.

CLI options include:
```
  --checkout (version) // Mount a static version of a drive.
  --no-seed            // Do not announce the drive on the DHT.
```

#### `hyperdrive info <path>`
Display information about the drive mounted at `path`. The information will include the drive's key, and whether `path` is the top-level directory in a mountpoint (meaning it's directly shareable).

- `path` must be a subdirectory of `~/Hyperdrive/`. If `path` is not specified, the command will use the enclosing mount of your current working directory.

By default, this command will refuse to display the key of your root drive (to dissuade accidentally sharing it). To forcibly display your root drive key, run this command with `--root`.

CLI options include:
```
  --root // Forcibly display your root drive key.
```

#### `hyperdrive seed <path>`
Start announcing a drive on the DHT so that it can be shared with other peers.

- `path` must be a subdirectory of `~/Hyperdrive/`. If `path` is not specified, the command will use the enclosing mount of your current working directory.

By default, this command will refuse to publish your root drive (to dissuade accidentally sharing it). To forcibly publish your root drive, run this command with `--root`.

CLI options include:
```
  --lookup (true|false)   // Look up the drive key on the DHT. Defaults to true
  --announce (true|false) // Announce the drive key on the DHT. Defaults to true
  --remember (true|false) // Persist these network settings in the database.
  --root                  // Forcibly display your root drive key.
  ```

#### `hyperdrive unseed <path>`
Stop advertising a previously-published subdrive on the network.

- `path` must be a subdirectory of `~/Hyperdrive/`. If `path` is not specified, the command will use the enclosing mount of your current working directory.

*Note: This command will currently not delete the Hyperdrive from disk. Support for this will be added soon.*

#### `hyperdrive stats <path>`
Display networking statistics for a drive. This is a shorthand for getting a drive's key with `hyperdrive info` and `cat`ing `~/Hyperdrive/Network/Stats/<drive-key>/networking.json`.

- `path` must be a subdirectory of `~/Hyperdrive/` and must have been previously mounted with the mount subcommand described above. If `path` is not specified, the command will use the enclosing mount of your current working directory.

#### `hyperdrive force-unmount`
If the daemon fails or is not stopped cleanly, then the `~/Hyperdrive` mountpoint might be left in an unusable state. Running this command before restarting the daemon will forcibly disconnect the mountpoint.

This command should never be necessary! If your FUSE mountpoint isn't cleaned up on shutdown, and you're unable to restart your daemon (due to "Mountpoint in use") errors, please file an issue.

## License
MIT

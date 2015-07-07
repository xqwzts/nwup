# nwup

nwup is an updater for packaged [NW.js/node-webkit](https://github.com/nwjs/nw.js/) applications. It allows the application code to be updated separately from the NW.js runtime, leading to much smaller update file sizes. There's also a [grunt plugin](https://github.com/xqwzts/grunt-nwup) that helps create updates that can be used with nwup.

##### Note:

This is still in early development, currently only supports Windows applications, though cross-platform OSX/Linux support is planned.


## How Does it Work?

nwup reverses the application packaging process to extract the original NW.js runtime from the packaged application. It then merges the update and runtime, repackaging into a new updated executable.

###### Packaging
`nw.exe + app.zip -> app.exe`
###### Extracting Runtime
`app.exe -> nw.exe + app.zip`
###### Updating
`nw.exe + update.zip -> app.updated.exe`

For more details see the [usage](#usage) section.

## Requirements

nwup assumes the packaged executable was created by concatenating the nw.exe runtime with the zipped application as described in the NW.js [wiki](https://github.com/nwjs/nw.js/wiki/How-to-package-and-distribute-your-apps#step-2a-put-your-app-with-nw-executable): either by using [node-webkit-builder](https://github.com/mllrsohn/node-webkit-builder) or [manually](https://github.com/nwjs/nw.js/wiki/How-to-package-and-distribute-your-apps#windows-1).


### Manifest

nwup needs some configuration information to function, and it looks for them in the application's `package.json` manifest. It checks for an `nwup` field, and extracts the configuration from the following subfields:

#### updateManifest
_(string)_ [__required__] URL pointing to the [update manifest JSON](#update-manifest).

#### runtimesize
_(int)_ [__required__] the size of the NW.js runtime before packaging.

#### mode
_(string)_ [__optional__] flag to determine if running in a development or production enviroment. Set to `DEVEL` or `PROD`. If mode is set to `DEVEL` then the update process will exit without updating to avoid modifying the unpackaged NW.js runtime.

##### Example:

```json
{
  "name": "myapp",
  "version": "0.0.2",
  "main": "index.html",
  ...
  "nwup": {
    "updateManifest": "https://www.example.com/updates/latest.json",
    "mode": "PROD",
    "runtimesize": 61049344
  }
}
```


### Update Manifest

When checking for updates nwup will make a request to the URL defined in the application's manifest [under the `updateManifest` field]. It expects a list of fields in JSON format, with `version` and `update` being required. Any extra fields provided there will be made available to the application [for use as a changelog, file size, additional info, etc].The following fields are required:

#### version
_(string)_ __[required]__ the latest version available, if this is newer than the application's current version then the application needs to be updated. Versioning should follow the [semver](http://semver.org/) format.

#### update
_(string)_ __[required]__ URL pointing to the latest update zip file.

##### Example:

```json
{
    "version": "1.1.0",
    "update": "https://www.example.com/updates/2.1.0.zip",
    "changelog": "Some additional info here that will be ignored by nwup, but passed along to the application."
}
```


## Installation

```shell
npm install nwup --save
```


## Usage

The update lifecycle is as follows:

1. Check if an update is available.
2. Download the update.
3. Restart the application to apply the update.
4. Check if an update is in progress.
5. Restart the application to complete the update.
6. Check if an update was completed and the temporary files need to be deleted.
7. Delete temporary update files.

nwup provides a method that takes care of each of these steps:

1. `checkForUpdate()`

    > Makes a request to the remote URL defined in the app manifest under `nwup.updateManifest`.
    > Compares the version number in the remote manifest with the app's current version.

2. `downloadUpdate()`

    > Extracts the NW.js runtime from the application [this is done by reading out the first n bytes where n is the size of the NW.js runtime determined before packaging].
    > Downloads the update zip from the remote server at the location provided in updateLocation.
    > Merges the update with the NW.js runtime to create a new executable [update.exe] which contains the updated version.

3. `applyUpdate(updatePath)`

    > Flags the application into update mode [isUpdating() will return true],
    > stores the path to the the current executable, closes the current application, and opens the new application determined by updatePath.

4. `isUpdating()`

    > When nwup downloads an update and starts updating, it will need to restart the app to apply those updates.
    > On startup apps should call isUpdating() to check if the update has not yet finished, and call completeUpdate() to finish the process and apply the updates.

5. `completeUpdate()`

    > Completes the update by overwriting the old app with the new updated executable.
    > Flags the application into clean mode [needsCleaning() will return true], closes the current application [updater], and opens the new updated application in the original path.

6. `needsCleaning()`

    > On startup apps should call needsCleaning() to check if the temp files still need to be deleted, and call clean() to delete them and end the update lifecycle.

7. `clean()`

    > Deletes the temporary update files that are no longer needed.

A simplified example:

```javascript
var nwup = require('nwup');
var updater = new nwup();

// Check if an update is in progress.
if (updater.isUpdating()) {
    // Restart the application to complete the update.
    setTimeout(function() {updater.completeUpdate();}, 2000);
} else {
    // Check if an update was completed and the temporary files need to be deleted.
    if (updater.needsCleaning()) {
        // Delete temporary update files.
        updater.clean()
    }

    // Check if an update is available.
    updater.checkForUpdate()
    .then(function(payload) {
        if (payload.updateAvailable) {
            // Download the update.
            updater.downloadUpdate(payload.updateInformation.update)
            .then(function (updatePath) {
                // Restart the application to apply the update.
                updater.applyUpdate(updatePath);
            }, function(error) {
                throw(error);
            }, function(progress) {
                // Track the download progress
                if (progress.totalSize) {
                    console.log('update size', progress.totalSize);
                }
                if (progress.receivedSize) {
                    console.log('amount dled', progress.receivedSize);
                }
            })
            .done();
        }
    });
```

Typically an application would allow for user input in the process, mainly:

- after step 1: Prompt the user to download the update.
- after setp 2: Prompt the user to apply the update.
- after step 4: Display 'updating' text to the user.
- after step 7: Display 'update complete' notice.


## Creating Updates

To fulfill all the requirements listed above, every time a new version is released you would need the following:

1. The update files in a zipped archive [all your application files zipped up together, without the NW.js runtime/dlls]
2. `nwup` fields in the application's manifest.
3. An update manifest at the nwup.updateManifest location.

The [grunt-nwup](https://github.com/xqwzts/grunt-nwup) plugin can be integrated in your project to automate the process.

var fs = require('fs');
var path = require('path');
var Q = require('q');
var rimraf = require('rimraf');
var mkdirp = require('mkdirp');
var request = require('request');
var semver = require('semver');
var spawn = require('child_process').spawn;
var gui = global.window.nwDispatcher.requireNwGui();
var localStorage = global.window.localStorage;

var MODE_UPDATE = 'UPDATE';
var MODE_CLEAN = 'CLEAN';
var DATA_MODE = 'mode';
var DATA_EXECPATH = 'execPath';


/**
*** Constructor
*** Reads required data from the running application's manifest:
*** version: Current app version, will compare this with the latest update version on the server.
***          Must use Semantic Versioning. see: http://semver.org/
*** nwup {
***   updateManifest: URL of the json file containing update details
***   runtimesize: Size of the nw.js runtime that was used in packaging
***   mode: [Optional] Set to "DEVEL" to avoid updating when in development mode [and overwriting the unpackaged nw.js runtime]
*** }
**/
function nwup() {
  var manifest = gui.App.manifest;
  this.currentVersion = manifest.version;
  this.remoteAddress = manifest.nwup.updateManifest;
  this.runtimesize = manifest.nwup.runtimesize;
  this.isDevMode = manifest.nwup.mode === 'DEVEL';
};

nwup.prototype = {
  constructor: nwup,


  /**
  *** When nwup downloads an update and starts updating, it will need to restart the app to apply those updates.
  *** On startup apps should call isUpdating() to check if the update has not yet finished, and call completeUpdate()
  *** to finish the process and apply the updates.
  *** returns: true if the update needs to be completed.
  **/
  isUpdating: function() {
    return getData(DATA_MODE) == MODE_UPDATE;
  },


  /**
  *** On startup apps should call needsCleaning() to check if the temp files still need to be deleted, and call clean()
  *** to delete them and end the update lifecycle.
  *** returns: true if the update has completed and temp files need to be cleaned.
  **/
  needsCleaning: function() {
    return getData(DATA_MODE) == MODE_CLEAN;
  },


  /**
  *** Makes a request to the remote URL defined in the app manifest under nwup.updateManifest
  *** Compares the version number in the remote manifest with the app's current version.
  *** returns: a promise:
  ***           - on reject: error message.
  ***           - on resolve: an object containing the following:
  ***                       - updateAvailable: bool, true if a the remote version is newer than the current version.
  ***                       - updateInformation: JSON, the full remote manifest data
  **/
  checkForUpdate: function() {
    var self = this;
    var deferred = Q.defer();
    var updateAvailable = false;

    // get remote manifest
    request(this.remoteAddress, function (error, response, body) {
      if (error) deferred.reject(error);

      if (response.statusCode !== 200) deferred.reject('Server responded with status code: ' + response.statusCode);

      if (response.statusCode === 200) {
        // get server manifest
        var remoteManifest = JSON.parse(body);

        // get version from manifest
        var remoteVersion = remoteManifest.version;

        // compare with current version
        if (semver.lt(self.currentVersion, remoteVersion)) {
          updateAvailable = true;
        }

        deferred.resolve({
          updateAvailable: updateAvailable,
          updateInformation: remoteManifest
        });
      }
    });

    return deferred.promise;
  },


  /**
  *** Extracts the NW.js runtime from the application [this is done by reading out the
  *** first n bytes where n is the size of the NW.js runtime determined before packaging].
  *** Downloads the update zip from the remote server at the location provided in updateLocation.
  *** Merges the update with the NW.js runtime to create a new executable [update.exe] which contains the updated version.
  *** returns: a promise:
  ***           - on reject: error message
  ***           - on notify: an object containing either of the following:
  ***                       - totalSize: The size of the update to be downloaded.
  ***                       - receivedSize: The aggregate amount downloaded.
  ***           - on resolve: the path to the new executable.
  *** If the `nwup.mode` flag in the manifest is set to "DEVEL",
  *** skip the actual updating to avoid modifying an unpackaged NW.js runtime
  **/
  downloadUpdate: function(updateLocation) {
    // abort if this is being run in dev mode
    if (this.isDevMode) {
      return Q.reject('Update aborted in development environment');
    }

    var deferred = Q.defer();

    // get current app path
    var execPath = process.execPath;

    // extract nw.exe from current app [read out runtimesize bytes]
    var execStream = fs.createReadStream(execPath, {start: 0, end: this.runtimesize});
    execStream.on('error', function(err) { deferred.reject(err); });

    var tmpPath =  path.join(path.dirname(execPath), 'tmp', Date.now().toString());

    var totalSize;
    var receivedSize;

    mkdirp(tmpPath, function(err) {
      if (err) deferred.reject(err);

      var runtimePath = path.join(tmpPath, 'exportednw');
      var runtimeStream = fs.createWriteStream(runtimePath);
      runtimeStream.on('error', function(err) {  deferred.reject(err); });

      runtimeStream.on('finish', function() {
        var updatePath = path.join(tmpPath, 'update.zip');

        // dl the update zip
        var updateRequest = request.get(updateLocation);
        updateRequest.on('error', function(err) { deferred.reject(err); });

        updateRequest.on('response', function(response) {
          if (response.statusCode !== 200) {
            deferred.reject('update file not found. server replied with code:', response.statusCode);
          } else {
            totalSize = response.headers['content-length'];
            receivedSize = 0;
            deferred.notify({
              totalSize: totalSize
            });
            // update detected, start download
            updateRequest.pipe(fs.createWriteStream(updatePath));
          }
        });

        updateRequest.on('data', function(data) {
          receivedSize += data.length;
          deferred.notify({
            receivedSize: receivedSize
          });
        });

        updateRequest.on('end', function() {
          // TODO: chcksum
          // check that we actually downloaded an update zip:

          // merge the update with the extracted nw runtime
          var zipStream = fs.createReadStream(updatePath);
          var writeStream = fs.createWriteStream(runtimePath, {flags:'a'});

          zipStream.on('error', function(err) {  deferred.reject(err); });
          writeStream.on('error', function(err) {  deferred.reject(err); });

          writeStream.on('finish', function () {
            // delete the update zip
            fs.unlink(updatePath, function(err) {
              if (err)  deferred.reject(err);
            });

            // rename the new exec to .exe
            var newExecPath =  path.join(path.dirname(execPath), 'update.exe');
            fs.rename(runtimePath, newExecPath, function(err) {
              if (err) deferred.reject(err);

              deferred.resolve(newExecPath);
            });
          });

          zipStream.pipe(writeStream);
        });
      });

      execStream.pipe(runtimeStream);
    });

    return deferred.promise;
  },


  /**
  *** Flags the application into update mode [isUpdating() will return true],
  *** stores the path to the the current executable,
  *** closes the current application,
  *** and opens the new application determined by updatePath
  **/
  applyUpdate: function(updatePath) {
    if (!updatePath) return;

    // persist the data needed upon restart
    var data = [
      {key: DATA_MODE, value: MODE_UPDATE},
      {key: DATA_EXECPATH, value: process.execPath}
    ];

    storeData(data);
    respawn(updatePath);
  },


  /**
  *** Completes the update by overwriting the old app with the new updated executable.
  *** Flags the application into clean mode [needsCleaning() will return true],
  *** closes the current application [updater],
  *** and opens the new updated application in the original path.
  **/
  completeUpdate: function() {
    var oldExecPath = getData(DATA_EXECPATH);
    if (!oldExecPath) return;

    var newExecPath = process.execPath;

    if (oldExecPath == newExecPath) {
      // something went wrong. Release update.
      removeData(DATA_MODE);
      removeData(DATA_EXECPATH);
      return;
    }

    var readStream = fs.createReadStream(newExecPath);
    readStream.on('error', function(err) {
      // TODO: emit error instead of throwing
      throw err;
    });

    var self = this;

    var writeStream = fs.createWriteStream(oldExecPath);
    writeStream.on('error', function(err) {
      // TODO: have a counter here and only try that many times, after that fail.
      setTimeout(function() {self.completeUpdate();}, 1000);
    });

    writeStream.on('finish', function() {
      // App updated successfully, need to restart and clean update files.

      removeData(DATA_EXECPATH);
      storeData([{key: DATA_MODE, value: MODE_CLEAN}]);

      // respawning
      respawn(oldExecPath);
    });

    // streams created, start piping
    readStream.pipe(writeStream);
  },


  /**
  *** Deletes the temporary update files that are no longer needed:
  ***   - the tmp folder
  ***   - the update.exe file
  **/
  clean: function() {
    var deferred = Q.defer();

    var baseDir = path.dirname(process.execPath);
    var tmpPath = path.join(baseDir, 'tmp');
    var updatePath = path.join(baseDir, 'update.exe');

    var rimglob = '{' + tmpPath + ',' + updatePath + '}';
    rimraf(rimglob, function(err) {
      if (err) deferred.reject(err);

      removeData(DATA_MODE);
      deferred.resolve();
    });

    return deferred.promise;
  }
};



/**
*** private functions: not exported by the module since they're only used internally
**/

function respawn(execPath) {
  // spawn new process [see: https://iojs.org/api/child_process.html#child_process_options_detached]
  var child = spawn(execPath, {detached: true});
  child.on('error', function(err) {
    throw err;
  });
  child.unref();

  // close this app
  gui.Window.get().hide();
  gui.App.quit();
};


function storeData(data) {
  var nwup = localStorage.nwup ? JSON.parse(localStorage.nwup) : {};
  for (var i in data) {
    nwup[data[i].key] = data[i].value;
  }
  localStorage.nwup = JSON.stringify(nwup);
};


function getData(key) {
  if (!localStorage.nwup) return null;

  var nwup = JSON.parse(localStorage.nwup);
  return nwup[key];
};


function removeData(key) {
  if (!localStorage.nwup) return;

  var nwup = JSON.parse(localStorage.nwup);
  delete nwup[key];

  localStorage.nwup = JSON.stringify(nwup);
};

module.exports = nwup;

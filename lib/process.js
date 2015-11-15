/**
 * Scales.js — the flexible game management daemon built for PufferPanel.
 * Licensed under a GPL-v3 license.
 */
require('date-utils');
var Async = require('async');
var Rfr = require('rfr');
var Logger = Rfr('lib/logger.js');
var GlobalConfig = Rfr('config.json');
var Pty = require('pty.js');
var Proc = require('child_process');
var Util = require('util');
var Events = require('events');
var Path = require('path');
var Querystring = require('querystring');
var StripANSI = require('strip-ansi');
var Fs = require('fs-extra');
var Extend = require('node.extend');
var Request = require('request');
var Usage = require('usage');

// Set Power Variables
var OFF = 0;
var ON = 1;
var STOPPING = 2;
var STARTING = 3;
var CRASHED = 4;

var Scales = function (config) {

    var Plugin = Rfr('lib/plugins/' + config.plugin + '/main.js');

    this.ps;
    this.status = 0;
    this.spawnedPID;
    this.spawnedPIDLocked = false;
    this.preflightReboot = false;

    this.config = config;
    this.usageStatistics = {};
    this.logStream = false;

    this.lastCrash = 0;
    this.queryErrorCount = 0;
    this.statisticsErrorCount = 0;

    this.plugin = new Plugin(this.getRootPath(), this.buildPath(), this.config);

    this.dockerUserID;
    this.dockerCreateProcess;
    this.dockerRebuildContainer = false;

};

Util.inherits(Scales, Events.EventEmitter);

Scales.prototype.hasPermission = function (key, permission) {

    if (GlobalConfig.keys.indexOf(key) > -1) {
        return true;
    }

    if (typeof permission === 'undefined' || !(key in this.config.keys)) {
        return false;
    }

    if (this.config.keys[key].indexOf(permission) >= 0) {
        return true;
    }

    return false;
};

/**
 * Sets the current server status.
 * @param {int} status Should be 0-4 depending on the current status.
 */
Scales.prototype.setStatus = function (status) {

    if (this.status !== status) {
        this.status = status;
        this.emit('status', this.status);
    }

    return this.status;

};

Scales.prototype.setLastCrash = function () {

    this.lastCrash = Math.floor(new Date().getTime() / 1000);
};

/**
 * Ensures that Docker Container is started.
 * @param  {Function} next [description]
 * @return {[type]}        [description]
 */
Scales.prototype.dockerInitalizeContainer = function (next) {

    var self = this;
    Proc.exec(Util.format('docker start %s', this.config.user), function (err, stdout, stderr) {

        if (err || stderr) {
            Logger.error(Util.format('An error occured attempting to start docker container for %s', self.config.user), stderr);
            return next(err);
        }

        return next();
    });
};

/**
 * Attaches to the server's docker container.
 * Access as this.pty = this.attachDockerContainer();
 * @return {object} Pty.spawn(); object
 */
Scales.prototype.dockerAttachContainer = function () {

    return Pty.spawn('docker', ['attach', this.config.user]);
};

/**
 * Detaches a server's docker containers, efectively turning off the server with a hard shutdown.
 * Does not trigger a crash warning.
 * @param {bool} status Wether or not to update the server power status. Defaults to true.
 * @return {object}
 */
Scales.prototype.dockerDetachContainer = function (next) {

    var self = this;
    Proc.exec(Util.format('docker stop %s', this.config.user), function (err, stdout, stderr) {

        if (err || stderr) {
            Logger.error(Util.format('An error occured attempting to stop docker container for %s, killing it.', self.config.name), stderr);
            self.dockerKillContainer(null, false);
            return next(stderr);
        }

        Logger.verbose(Util.format('Detached docker container for server %s', self.config.name));
        return next(null);
    });
};

/**
 * Kills a running docker container.
 * @param  {string} signal The signal to kill the running container with.
 * @return {[type]}        [description]
 */
Scales.prototype.dockerKillContainer = function (next, crashed) {

    var self = this;

    if (typeof crashed !== 'undefined' && crashed === false) {
        this.setStatus(STOPPING);
    }

    Proc.exec(Util.format('docker kill -s 9 %s', this.config.user), function (err, stdout, stderr) {

        if (err || stderr) {
            Logger.error(Util.format('An error occured attempting to kill docker container for %s', self.config.name), stderr);
            if (typeof next === 'function') {
                return next(new Error('An error occured attempting to kill the docker container.'));
            }
            return;
        }

        Logger.verbose(Util.format('Killed docker container for server %s', self.config.name));
        if (typeof next === 'function') {
            return next();
        }
    });
};

/**
 * Deletes a Docker Container.
 * @param  {string} signal The signal to kill the running container with.
 * @return {[type]}        [description]
 */
Scales.prototype.dockerDeleteContainer = function (next) {

    var self = this;

    Proc.exec(Util.format('docker rm -vf %s', this.config.user), function (err, stdout, stderr) {

        if (err || stderr) {
            Logger.error(Util.format('An error occured attempting to delete docker container for %s', self.config.name), stderr);
            return next(err);
        }

        Logger.verbose(Util.format('Deleted docker container for server %s', self.config.name));
        return next(null);
    });
};

/**
 * [dockerGetUserID description]
 * @param  {Function} next [description]
 * @return {[type]}        [description]
 */
Scales.prototype.dockerGetUserID = function (next) {

    var self = this;

    Proc.exec(Util.format('stat -c \'%u:%g\' %s', this.buildPath()), function (err, stdout, stderr) {

        if (err || stderr) {
            Logger.error('An error occured while trying to determine user information for a docker container.', stderr);
            return next(err);
        }

        self.dockerUserID = stdout.replace('\n', '');
        return next();
    });
};

/**
 * [dockerCreateContainer description]
 * @param  {Function} next [description]
 * @return {[type]}        [description]
 */
Scales.prototype.dockerCreateContainer = function (next) {

    var self = this;

    Async.series([
        function (callback) {

            Logger.verbose(Util.format('Attempting to gather user information to create a container for server %s', self.config.name));
            if (typeof self.dockerUserID !== 'undefined') {
                return callback();
            }

            self.dockerGetUserID(function (err) {

                return callback(err);
            });
        },
        function (callback) {

            // Build Port Mapping
            var portMap = Util.format('-p %s:%s:%s -p %s:%s:%s/udp',
                self.config.gamehost,
                self.config.gameport,
                self.config.gameport,
                self.config.gamehost,
                self.config.gameport,
                self.config.gameport
            );

            if (typeof self.config.build.mapping !== 'undefined') {
                var mappingObject = self.config.build.mapping;
                for (var ip in mappingObject) {
                    for (var port in mappingObject[ip]) {
                        // mapping localhost:internal to ip:external (docker --> host)
                        portMap = Util.format('%s -p %s:%s:%s -p %s:%s:%s/udp',
                            portMap,
                            ip,
                            mappingObject[ip][port],
                            port,
                            ip,
                            mappingObject[ip][port],
                            port
                        );
                    }
                }
            }

            Logger.verbose(Util.format('Creating docker container for server %s', self.config.name));
            dockerProcessParams = Util.format('create -it --name %s -h docker -m %sM --blkio-weight=%s --cpu-period=100000 --cpu-quota=%s %s -u %s -v %s:/home/container %s',
                self.config.user,
                self.config.build.memory,
                self.config.build.io || 500,
                (self.config.build.cpu <= 0) ? -1 : (self.config.build.cpu * 1000),
                portMap,
                self.dockerUserID,
                self.buildPath(),
                (self.config.plugin === 'bungeecord' || self.config.plugin === 'minecraft-pre') ? 'pufferpanel/minecraft:latest' : 'pufferpanel/' + self.config.plugin + ':latest'
            );

            this.ps = Pty.spawn('docker', dockerProcessParams.match(/\S+/g));

            this.ps.on('data', function (data) {

                self.emit('installer', StripANSI(data));
            });

            this.ps.on('exit', function (code) {

                if (code !== 0) {
                    return callback(new Error('docker create command exited with non-zero error code [' + code + '].'));
                }

                Logger.verbose(Util.format('Successfully added a new docker container for %s.', self.config.name));
                return callback();
            });
        }
    ], function (err) {

        return next(err);
    });
};

/**
 * Spins up the docker container and executes the server command to start the server.
 * @return {[type]}        [description]
 */
Scales.prototype.dockerExecuteServerStartup = function (next) {

    Logger.verbose(Util.format('Attempting to spawn server process for %s', this.config.user));

    try {
        this.setStatus(STARTING);
        this.ps = Pty.spawn('docker', this.plugin.startup());
        return next();
    } catch (ex) {
        this.setStatus(OFF);
        Logger.error(Util.format('Unable to start server process for %s due to an exception in Pty.spawn()', this.config.user), ex.stack);
        return next(ex);
    }
};

Scales.prototype.rebuildDockerContainer = function (next) {

    var self = this;

    Async.series([
        function (callback) {

            self.emit('console', 'Management Daemon: Rebuilding container for this server. Please wait...\n');
            self.dockerDeleteContainer(function (err) {

                return callback(err);
            });
        },
        function (callback) {

            self.dockerCreateContainer(function (err) {

                return callback(err);
            });
        }
    ], function (err) {

        return next(err);
    });

};

Scales.prototype.preflight = function () {

    var self = this;

    if (this.status !== OFF) {
        Logger.warn('Attempting to run PreFlight while server is not currently set to OFF.');
        return;
    }

    this.emit('console', '\n\nRunning server Pre-Flight, this might take a moment or two...\n\n');

    this.queryErrorCount = 0;
    this.statisticsErrorCount = 0;

    Async.series({
        permissions: function (next) {
            Proc.exec(Util.format('chown -R %s:scalesuser %s', self.config.user, self.buildPath()), function (err, stdout, stderr) {

                if (err || stderr) {
                    Logger.error('Unable to complete preflight for server ' + self.config.name + ' due to a permissions error.', stdout);
                    return next(stderr);
                }

                Logger.verbose('Completed permissions preflight for server ' + self.config.name);
                return next();

            });
        },
        preflight: function (next) {
            if (typeof self.plugin !== 'undefined' && typeof self.plugin.preflight === 'function') {
                try {
                    self.plugin.preflight(function (err, response) {
                        return next(err || null, response || null);
                    });
                } catch (ex) {
                    Logger.error(ex.stack);
                    return next(ex);
                }
            } else {
                return next(new Error('Unable to run plugin preflight due to missing function. Plugin was ' + self.config.plugin));
            }
        },
        startup: function (next) {
            self.powerOn(next);
        }
    }, function (err, response) {

        if (response.preflight && response.preflight === 1) {
            // User needs to restart server
            Async.series([
                function (next) {
                    if (self.preflightReboot !== false) {
                        Logger.error('Preflight reboot could not continue due to a potential crash loop.');
                        return next(new Error('Preflight failed due to potential crash loop.'));
                    }
                    self.preflightReboot = true;
                    return next();
                },
                function (next) {

                    self.emit('console', '\n==============================================\n');
                    self.emit('console', '          PUFFERPANEL STARTUP NOTICE          \n');
                    self.emit('console', '==============================================\n');
                    self.emit('console', 'Restarting your server now to officially start it.\nWe needed to generate some server files\nbefore we could run this server for you.');
                    return next();
                },
                function (next) {
                    self.powerCycle();
                }
            ]);
        }

        if (err) {
            Logger.error(Util.format('An error occured while attempting to perform server preflight for %s.', self.config.name), err);
            self.emit('console', '[ERROR] An error occured while attempting to start this server. Please ask your systems administrator to look into this.');
        }

    });
};

/**
 * Turns on the specified server.
 */
Scales.prototype.powerOn = function (next) {

    var self = this;

    Async.series([
        function (callback) {

            if (self.dockerRebuildContainer) {
                self.rebuildDockerContainer(function (err) {

                    if (err) {
                        return callback(err);
                    }
                    self.dockerRebuildContainer = false;
                    return callback();
                });
            } else {
                return callback();
            }
        },
        function (callback) {

            self.dockerInitalizeContainer(function (err) {

                return callback(err);
            });
        },
        function (callback) {

            self.dockerExecuteServerStartup(function (err) {

                return callback(err);
            });
        }
    ], function (err) {

        if (err) {
            Logger.error(Util.format('An error was detected during the startup sequence for server %s', self.config.name), err);
            console.log(err);

            if (typeof next === 'function') {
                return next(err);
            }
            return;

        }

        self.ps.on('data', function (data) {

            output = data.toString();
            self.emit('console', StripANSI(output));

            // Write output to specific file if defined in the plugin
            // Used by SRCDS since it's logging is a bit.. sparse.
            if (typeof self.plugin.settings.manual_log !== 'undefined' && self.plugin.settings.manual_log) {
                if (!self.logStream) {
                    Fs.remove(self.buildPath(self.plugin.settings.log), function (err) {

                        if (err) {
                            Logger.error('An unhandled error occured while attempting to delte a log file when starting a server.', err);
                        }

                        Fs.ensureFile(self.buildPath(self.plugin.settings.log), function (err) {

                            if (err) {
                                Logger.error('An error occured while trying to create a log file for ' + self.config.name, err);
                            } else {
                                self.logStream = Fs.createWriteStream(self.buildPath(self.plugin.settings.log), {
                                    flags: 'a'
                                });
                            }
                        });
                    });
                }

                if (self.logStream !== false) {
                    if ((output.replace(/\s+/g, '')).length > 1) {
                        self.logStream.write(StripANSI(output.replace(/\r\n/g, '') + '\n'));
                    }
                }
            }

            if (self.status === STARTING) {
                // Only applies to MC Servers
                // Should consider adding a call here for self.plugin.postStart();
                if (typeof self.plugin.settings.trigger.eula !== 'undefined') {
                    if (output.indexOf(self.plugin.settings.trigger.eula) !== -1) {
                        self.setStatus(STOPPING);
                        self.emit('off');

                        Logger.warn(Util.format('Server %s has not yet accepted the EULA. Stopping server...', self.config.name));
                    }
                }

                if (typeof self.plugin.settings.trigger.started !== 'undefined' && output.indexOf(self.plugin.settings.trigger.started) > -1) {
                    // only run once
                    if (self.spawnedPIDLocked === false && self.ps.pid && typeof self.spawnedPID === 'undefined') {
                        self.spawnedPIDLocked = true;
                        Proc.exec(Util.format('pgrep -u %s %s', self.config.user, self.plugin.settings.pgrep_exe), function (err, stdout, stderr) {

                            if (err) {
                                Logger.error(Util.format('An error occured while attempting to get the spawned PID for %s.', self.config.user));
                            }

                            self.spawnedPID = stdout.replace('\n', '');
                            self.intervalQueryServerStats = setInterval(self.statistics, 2000, self);
                        });
                    }

                    self.setStatus(ON);
                    self.intervalQueryServer = setInterval(self.query, 10000, self);

                    Logger.verbose(Util.format('Server %s successfully started.', self.config.name));
                    return next();

                }
            }
        });

        // Emitted when the PTY exits
        self.ps.on('exit', function () {

            self.dockerDetachContainer(function (err) {

                // @TODO: How do we even handle a detachDockerContainer error?
                // If it won't detach we have an issue.
                if (self.status === ON || self.status === STARTING) {

                    self.emit('status', 'crashed');
                    self.setStatus(CRASHED);

                    Logger.warn('Server process detected as crashed and container was stopped (pid: ' + self.ps.pid + ') for server ' + self.config.name);
                    self.emit('off');

                }

                if (self.status === STOPPING) {
                    Logger.verbose(Util.format('Server process stopped for %s', self.config.name));
                    self.setStatus(OFF);

                    // Tell Scales the process is exited
                    self.emit('off');
                }
            });
        });
    });

    // Emitted when the 'exit' event is detected from the PTY
    this.on('off', function () {

        if (self.status !== OFF && self.status !== CRASHED) {
            Logger.verbose('Stopping server process for ' + self.config.name);
            self.setStatus(OFF);
        }

        clearInterval(self.intervalQueryServer);
        clearInterval(self.intervalQueryServerStats);

        self.usageStatistics = {};
        self.plugin.query = {};
        self.spawnedPIDLocked = false;
        self.spawnedPID = undefined;
        self.ps = undefined;
        self.preflightReboot = false;

        if (self.status === CRASHED) {
            self.setStatus(OFF);

            // Prevent rapid crash restarts from happening
            if (Math.floor(new Date().getTime() / 1000) - self.lastCrash < 60) {
                Logger.warn('Skipping server restart after crash due to frequency of crashes occuring on server ' + self.config.name);
                self.emit('console', '[Scales] [WARNING] This server has been detected as crashed by the management daemon. The restart process is being skipped due to the frequency at which this server is crashing (< 60 seconds between crashes).');
                return;
            }

            // Set time since last crash
            self.setLastCrash();

            Logger.warn('Server process for ' + self.config.name + ' killed after crash, server is now rebooting...');
            self.emit('console', '[Scales] [WARNING] This server has been detected as crashed by the management daemon. Restarting now...');
            self.preflight();
        }

        if (self.logStream !== false) {
            self.logStream = false;
        }
    });
};

Scales.prototype.powerOff = function (next) {

    if (this.status !== OFF) {
        Logger.verbose(Util.format('Stopping server process (pid: %s) for %s', this.ps.pid, this.config.name));
        this.setStatus(STOPPING);
        this.ps.write(this.plugin.settings.stop + '\r');
    } else {
        // Allows the use of restart even if the server isn't on.
        Logger.verbose(Util.format('Power off called for %s but server is already off. If a callback was defined it will continue.', this.config.name));
        if (typeof next !== 'undefined') {
            return next();
        }
    }

    if (typeof next === 'function') {
        this.on('off', function () {
            try {
                return next();
            } catch (ex) {
                // ignore exception, this is hackish, but I can't seem to fix this.
                // [2015-11-07 23:22:37] [INFO] Error: Callback was already called.
                //      at /srv/scales/node_modules/async/lib/async.js:43:36
                //      at /srv/scales/node_modules/async/lib/async.js:694:17
                //      at /srv/scales/node_modules/async/lib/async.js:173:37
                //      at /srv/scales/lib/process.js:655:24
                //      at null.<anonymous> (/srv/scales/lib/process.js:633:24)
                //      at emitNone (events.js:72:20)
                //      at emit (events.js:166:7)
                //      at /srv/scales/lib/process.js:559:26
                //      at /srv/scales/lib/process.js:140:16
                //      at ChildProcess.exithandler (child_process.js:194:7)
            }
        });
    }

};

Scales.prototype.kill = function (crashed, next) {

    if (typeof this.ps !== 'undefined' && typeof this.ps.pid !== 'undefined') {
        this.dockerKillContainer(function (err) {

            self.emit('off');
            if (typeof next === 'function') {
                return next();
            }

        }, false);
    } else {
        if (typeof next === 'function') {
            return next();
        }
    }

};

Scales.prototype.powerCycle = function () {

    var self = this;
    Async.series([
        function (next) {
            self.powerOff(function (err) {
                return next();
            });
        },
        function (next) {
            return self.preflight();
        }
    ]);
};

Scales.prototype.console = function (data) {

    // Server is already stopping or stopped, don't send the data.
    if ([OFF, STOPPING].indexOf(this.status) >= 0) {
        return false;
    }

    // Prevent Scales from thinking server has crashed if user sends stop command
    if (data === this.plugin.settings.stop) {
        this.setStatus(STOPPING);
    }

    this.ps.write(data + '\r');
    return true;
};

Scales.prototype.listDirectory = function (base) {

    var directory = this.buildPath(base);
    var files = [];

    if (!Fs.existsSync(directory)) {
        return false;
    }

    Fs.readdirSync(directory).forEach(function (filename) {

        stat = Fs.statSync(Path.join(directory, filename));
        files.push({
            'name': filename,
            'created': stat.ctime,
            'modified': stat.mtime,
            'size': stat.size,
            'file': stat.isFile(),
            'symlink': stat.isSymbolicLink()
        });
    });

    return files;
};

Scales.prototype.returnFile = function (base) {

    var filepath = this.buildPath(base);

    if (!Fs.existsSync(filepath) || !Fs.statSync(filepath).isFile()) {
        return false;
    }

    return Fs.readFileSync(filepath, 'UTF-8');
};

Scales.prototype.writeFile = function (base, contents) {

    var filepath = this.buildPath(base);

    try {
        Fs.outputFileSync(filepath, contents);
        return true;
    } catch (ex) {
        Logger.error(Util.format('An exception occured while trying to write a file to %s for %s', filepath, this.config.name), ex.stack);
        return false;
    }
};

Scales.prototype.deleteFile = function (base) {

    var filepath = this.buildPath(base);

    try {
        Fs.removeSync(filepath);
        return true;
    } catch (ex) {
        Logger.error(Util.format('An exception occured while trying to delete %s for %s', filepath, this.config.name), ex.stack);
        return false;
    }
};

Scales.prototype.logContents = function (parseLines) {

    var out = '';
    var lines = '';

    try {
        lines = Fs.readFileSync(this.buildPath(this.plugin.settings.log)).toString().split('\n');
    } catch (ex) {
        console.log(ex.stack);
        // Logger.warn(Util.format('No log was found to read from for %s', this.config.name), ex.stack);
        return 'No log was found to read from. [' + this.plugin.settings.log + ']';
    }

    parseLines = parseInt(parseLines) + parseInt(1);
    parseLines = (parseLines < 0) ? 1 : parseLines;
    for (i = lines.length - parseLines; i < lines.length; i++) {
        if (lines[i] !== undefined) {
            out += lines[i] + '\n';
        }
    }

    return out.trim() + '\n';
};

/**
 * Returns the root path for the specificed Scales instance.
 * @return {string} The root path in the format of /home/username
 */
Scales.prototype.getRootPath = function () {

    return Path.join(GlobalConfig.basepath, this.config.user);
};

/**
 * Builds a path to the specificed file or folder for the user.
 * @param  {string} extended Folder or file within the users public directory.
 * @return {string}          The full path to the file or folder within the users public folder.
 */
Scales.prototype.buildPath = function (extended) {

    var publicPath = Path.join(this.getRootPath(), '/public');

    if (typeof extended !== 'undefined' && extended !== null) {
        publicPath = Path.join(publicPath, Path.normalize(Querystring.unescape(extended)));
    }

    if (publicPath.indexOf(Path.join(GlobalConfig.basepath, this.config.user, 'public')) !== 0) {
        Logger.error('API attempted to access a file outside of base directory ' + GlobalConfig.basepath + this.config.user + '. Request denied.');
        return Path.join(this.getRootPath(), '/public');
    }

    return publicPath;
};

Scales.prototype.query = function (reference) {

    // Query Server
    // After 3 failed queries in a row kill process and report as crashed.
    if (reference.status !== OFF) {
        reference.plugin.queryServer(function (err) {

            // Disabled due to SRCDS/Gamedig being uncooperative curently.
            // if (err || reference.plugin.query.error !== undefined) {
            //
            //     reference.queryErrorCount++;
            //     if (reference.queryErrorCount >= 3) {
            //         Logger.warn(Util.format('Killing server %s because query returned an error 3 or more times in a row.', reference.config.name));
            //         reference.emit('console', 'Server has failed to respond to query after 3 attempts. Marked as crashed.');
            //         reference.dockerKillContainer();
            //     }
            //
            // } else {
            //     reference.queryErrorCount = 0;
            // }

            reference.emit('query');
        });
    }
};

Scales.prototype.statistics = function (reference) {

    if (reference.spawnedPID) {
        Usage.lookup(reference.spawnedPID, { keepHistory: true }, function (err, result) {

            if (err) {
                reference.statisticsErrorCount++;

                // Throw error after 3 times to allow for one-off issues that self-resolve.
                if (reference.statisticsErrorCount >= 3) {
                    Logger.warn(Util.format('Killing server %s because statistics lookup returned an error 3 or more times in a row.', reference.config.name));
                    reference.dockerKillContainer();
                    return;
                }
            } else {
                reference.statisticsErrorCount = 0;
            }

            result.cpu = parseInt((result.cpu).toFixed(2));
            reference.usageStatistics = result;
            reference.emit('stats');
        });
    }
};

/**
 * Returns information about the server.
 * @return {object} Returns an object containing the server status, plugin, query results, and proc stats.
 */
Scales.prototype.coreInfo = function () {

    return {
        'status': this.status,
        'plugin': this.plugin.settings.name,
        'query': this.plugin.query,
        'proc': this.usageStatistics
    };
};

/**
 * Configures basic information for a new server on the node.
 * @param  {Object} res          The restify response object.
 * @param  {string} hash         [description]
 * @param  {string} password     [description]
 * @param  {string} build_params [description]
 * @return {bool}              [description]
 */
Scales.prototype.install = function (res, hash, password, build_params) {

    var self = this;
    Async.series([
        function (next) {

            Logger.verbose('Creating base config file for ' + self.config.name);
            self.updateConfig(self.config, function (err) {
                return next(err);
            });
        },
        function (next) {

            // Add the User
            Logger.verbose('Creating user ' + self.config.user + ' on the server.');
            Proc.exec(Util.format('./lib/scripts/create_user.sh %s %s %s', GlobalConfig.basepath, self.config.user, password), function (err, stdout, stderr) {

                if (err) {
                    return next(err, 'Error occured trying to execute a command to add a user.');
                }

                return next();
            });
        }
    ], function (err, response) {

        if (err) {
            Logger.error(response, err);
            res.send(500, { 'error': response });
        } else {
            Logger.verbose('Finished basic install process for new server, preparing to complete full install process.');
            res.send(204);
            self.majorInstall(build_params);
        }
    });
};

Scales.prototype.majorInstall = function (buildParams, next) {

    var self = this;
    var processParams = [];
    var dockerProcessParams = [];
    var dockerUserInfo;

    Async.series([
        function (callback) {

            self.dockerCreateContainer(function (err) {

                return callback(err);
            });
        },
        function (callback) {

            if (typeof self.plugin.settings.install_script === undefined) {
                return callback('no script');
            }

            return callback();
        },
        function (callback) {

            Logger.verbose('Running major installer process for ' + self.config.name + ' which could take a few minutes to complete. Do not stop Scales during this process.');

            if (typeof buildParams !== undefined && buildParams !== '' && buildParams) {
                processParams = Util.format('-b %s -u %s %s', GlobalConfig.basepath, self.config.user, buildParams);
            } else {
                processParams = Util.format('-b %s -u %s', GlobalConfig.basepath, self.config.user);
            }

            // Create Installer Logger
            var logLocation = Util.format('./logs/installer/%s-%s.log', self.config.name, new Date().toFormat('YYYY.MM.DD.HH24.MI.SS'));
            var installerLogStream;

            Fs.ensureFile(logLocation, function (err) {

                if (err) {
                    return Logger.error('An error occured while trying to create an install log file for ' + self.config.name, err);
                }
                installerLogStream = Fs.createWriteStream(logLocation, { flags: 'a' });

            });

            var installerProcess = Pty.spawn('./lib/scripts/' + self.plugin.settings.install_script, processParams.match(/\S+/g));

            installerProcess.on('data', function (data) {

                // Log Output to File
                if (typeof installerLogStream !== 'undefined') {
                    installerLogStream.write(StripANSI(data));
                }

                self.emit('installer', StripANSI(data));

            });

            installerProcess.on('exit', function (code) {

                if (typeof installerLogStream !== 'undefined') {
                    installerLogStream.end(Util.format('=== Script exited with code %s ===', code));
                }

                if (code !== 0) {
                    return callback(new Error(Util.format('An error was encountered with the installer script for %s. Script edited with code %s and was logged to %s', self.config.name, code, logLocation)));
                }

                Logger.verbose('Installer process has completed for for ' + self.config.name);
                return callback();

            });
        }
    ], function (err) {

        if (err && err !== 'no script') {
            // Error (todo: add graceful fallback to PP to alert admins)
            Logger.error('Unable to complete the installer process. Please check the logs for more information.', err);
            self.emit('installer', 'error: unable to contact remote service to alert to completed install process.');

            if (typeof next === 'function') {
                return next(err);
            }
        } else {
            // Update PufferPanel
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
            Request.post({
                url: GlobalConfig.urls.install,
                formData: {
                    server: self.config.name
                },
                timeout: 10000
            }, function (err, httpResponse, body) {

                if (err) {
                    Logger.error('Failed to alert PufferPanel of completed install status. [PufferPanel said: ' + body + ']', err);

                    if (typeof next === 'function') {
                        return next(err);
                    }
                }

                self.emit('installer', 'Install completed successfully.');
                Logger.verbose('Major install process completed and PufferPanel notified.');

                if (typeof next === 'function') {
                    return next();
                }
            });
        }
    });
};

Scales.prototype.reinstallServer = function (plugin, build_params, next) {

    var self = this;

    Async.series([
        function (callback) {

            if (this.status !== OFF) {
                self.kill(function (err) {
                    return callback(err);
                });
            }
            return callback();
        },
        function (callback) {

            self.dockerDeleteContainer(function (err) {

                return callback(err);
            });
        },
        function (callback) {

            if (plugin !== null) {
                self.config.plugin = plugin;
                self.updateConfig(self.config, function (err) {
                    return callback(err);
                });
            }

            return callback();
        },
        function (callback) {

            self.majorInstall(build_params);
            return callback();
        }
    ], function (err) {

        if (err) {
            Logger.error('An error occured while attempting to reinstall a server.', err);
        }

        return next(err);
    });
};

Scales.prototype.updateConfig = function (config, next) {

    var self = this;
    Fs.outputJson('./data/' + config.name + '.json', config, function (err) {

        if (!err) {

            self.config = config;

            var Plugin = Rfr('lib/plugins/' + config.plugin + '/main.js');
            self.plugin = new Plugin(self.getRootPath(), self.buildPath(), self.config);

        }

        return next(err);

    });

};

Scales.prototype.resetPassword = function (newPassword, res) {

    var self = this;
    Logger.verbose(Util.format('Resetting account SFTP password for %s', this.config.user));

    Proc.exec(Util.format('./lib/scripts/reset_password.sh %s %s', self.config.user, newPassword), function (err, stdout, stderr) {

        if (err) {
            Logger.error('Error occured trying to reset account password for ' + s.config.user + ' on the server.', stderr);
            res.send(500);
        } else {
            Logger.verbose(Util.format('SFTP password for %s was reset.', self.config.user));
            res.send(204);
        }
    });
};

/**
 * Merges two JSON structures for the Server Data
 * Deprecated as of v0.2.0, please use Scales.prototype.updateConfig();
 * @deprecated since Scales version 0.2.0; PufferPanel version 0.9.0
 * @param  {[type]} json      [description]
 * @param  {[type]} obj       [description]
 * @param  {[type]} overwrite [description]
 * @param  {[type]} res       [description]
 * @return {[type]}           [description]
 */
Scales.prototype.mergeJson = function (json, obj, overwrite, res) {

    var finalObject = this.config;
    var self = this;

    if (!obj) {
        if (!overwrite) {
            finalObject = Extend({}, this.config, JSON.parse(json));
        } else {
            finalObject = JSON.parse(json);
        }
    } else {
        var object = obj.split(':');
        if (object[1] !== undefined) {
            finalObject = this.config[object[1]];
        }

        if (!overwrite) {
            finalObject[object[0]] = Extend({}, this.config[object[0]], JSON.parse(json));
        } else {
            finalObject[object[0]] = JSON.parse(json);
        }
    }

    self.updateConfig(finalObject, function (err) {

        if (err) {
            Logger.error('An error occured while trying to update the config for a server.', err);
            return res.send(500);
        }

        Logger.verbose('Config for server ' + self.config.name + ' has been updated by a remote source.');
        self.config = finalObject;
        res.send(204);

        if (self.status !== OFF) {
            Logger.warn(Util.format('Server %s is still running. Any changes to memory, CPU, or disk allocation will take place upon server restart.', self.config.name));
            self.dockerRebuildContainer = true;
            return;
        }

        self.rebuildDockerContainer(function (err) {

            if (err) {
                Logger.error(Util.format('An error occured while attempting to rebuild container for %s, it will be re-attempted on boot.', self.config.name), err);
                self.dockerRebuildContainer = true;
            }

            Logger.verbose(Util.format('Container rebuilt for %s.', self.config.name));
            return;
        });
    });
};

Scales.prototype.delete = function (res) {

    if (this.status !== OFF) {
        this.kill();
    }

    var self = this;

    Async.series([
        function (next) {
            Proc.exec(Util.format('./lib/scripts/remove_user.sh %s %s', GlobalConfig.basepath, self.config.user), function (err, stdout, stderr) {

                if (err) {
                    Logger.error('Error occured trying to execute a command to remove a user.', stderr);
                    return next('Error occured trying to execute a command to remove a user.');
                }

                Logger.verbose(Util.format('User %s was deleted from the system.', self.config.user));
                return next();
            });
        },
        function (next) {

            Fs.remove('./data/' + self.config.name + '.json', function (err) {

                if (err) {
                    Logger.error('An error occured while trying to remove the server data JSON file.', err);
                    return next(err);
                }

                return next();
            });
        }
    ], function (err) {

        if (err) {
            res.send(500, { 'message': error });
        } else {
            self.dockerDeleteContainer(function (err) {
                res.send(204);
            });
        }
    });
};

module.exports = Scales;

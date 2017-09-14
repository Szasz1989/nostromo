'use strict';

const util = require('util');
const spawn = require('child_process').spawn;
const BrowserSpanwerBase = require('../browser-spawner-base');

exports = module.exports = BrowserSpawnerChrome;

function BrowserSpawnerChrome(options) {
    BrowserSpanwerBase.call(this, options);
}

util.inherits(BrowserSpawnerChrome, BrowserSpanwerBase);

BrowserSpawnerChrome.prototype._startBrowser = async function (spawnerControlUrl) {
    if (this._process) {
        throw new Error('Process is already running');
    }

    // TODO what if folder exists?

    // params mostly from: https://github.com/karma-runner/karma-chrome-launcher/blob/master/index.js
    const params = [
        `--user-data-dir=${this._opts.tempDir}`,
        '--no-default-browser-check',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-popup-blocking',
        '--disable-translate',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-device-discovery-notifications',

        // TODO?
        // '--headless',
        // '--disable-gpu',
    ];

    if (this._opts.bounds) {
        const size = this._opts.bounds.size;
        const position = this._opts.bounds.position;

        params.push(`--window-size=${size.width},${size.height}`);

        if (position) {
            params.push(`--window-position=${position.x},${position.y}`);
        }
    }
    else {
        params.push('--start-maximized');
    }

    params.push(spawnerControlUrl);

    this._process = spawn(this._opts.path, params);

    this._process.on('error', () => this.emit('error'));
    this._process.on('close', () => {
        this.emit('close');
        this._deleteTempDir();
    });
};

BrowserSpawnerChrome.prototype._getDefaultTempDir = function () {
    return `_chrome_temp_${Date.now()}`;
};
'use strict';

var Promise = require('bluebird');
var $ = require('jquery'); $.noConflict();
var jQuery = $;
var MESSAGES = require('../messages');
var JSONF = require('../../../../modules/jsonf');
var UniqueSelector = require('../../../../modules/get-unique-selector');
var SS_MARKER_IMG = require('../screenshot-marker').base64;
var debounce = require('lodash.debounce');
var Ws4ever = require('../../../../modules/ws4ever');
var defaults = require('lodash.defaults');
var objectAssign = require('object-assign');
var BrowserPuppetCommands = require('./browser-puppet-commands.partial');
var promiseWhile = require('../../../../modules/promise-while')(Promise);
var Loggr = require('../../../../modules/loggr');

// TODO option to transmit console?
// TODO transmit uncaught exceptions
// TODO throw error on incorrect argument types/values (e.g. string numbers)

// TODO use MutationObserver if available, fallback to polling ?
var AUTODETECT_INTERVAL_MS = 200;
var INSERT_ASSERTION_DEBOUNCE = 500;

var DEFAULT_SERVER_URL = 'ws://localhost:47225';

exports = module.exports = BrowserPuppet;

/**
 * @param {Object} [opts]
 * @param {String} [opts.serverUrl=DEFAULT_SERVER_URL] - BrowserPuppeteer websocket server URL
 */
function BrowserPuppet(opts) {
    this._opts = defaults({}, opts, {
        serverUrl: DEFAULT_SERVER_URL,
    });

    assert(/^ws:\/\/.+/.test(this._opts.serverUrl), 'BrowserPuppet: missing or invalid serverUrl, expected "ws://..."');

    this._transmitEvents = false;
    this._isExecuting = false;
    this._isTerminating = false;

    this._wsConn = null;

    this.$ = $;

    this._uniqueSelector = new UniqueSelector();

    this._onSelectorBecameVisibleData = {
        intervalId: null,
        // Array<String>
        selectors: [],
        // Array<{previousState:Boolean}>
        states: [],
    };

    this._mouseoverSelector = null;

    this._activeElementBeforeWindowBlur = null;

    this._log = new Loggr({
        namespace: 'BrowserPuppet',
        // TODO logLevel
        logLevel: Loggr.LEVELS.ALL,
    });

    this._ssMarkerTopLeft = document.createElement('div');
    this._ssMarkerTopLeft.setAttribute('style', 'position:absolute;top:0;left:0;width:4px;height:4px;z-index:16777000;');
    this._ssMarkerTopLeft.style.background = 'url(' + SS_MARKER_IMG + ')';

    this._ssMarkerBottomRight = document.createElement('div');
    this._ssMarkerBottomRight.setAttribute('style', 'position:absolute;bottom:0;right:0;width:4px;height:4px;z-index:16777000;');
    this._ssMarkerBottomRight.style.background = 'url(' + SS_MARKER_IMG + ')';
}

objectAssign(BrowserPuppet.prototype, BrowserPuppetCommands.prototype);

BrowserPuppet.prototype.start = function () {
    this._startWs();
    this._attachCaptureEventListeners();
    this._startOnSelectorBecameVisiblePolling();
};

BrowserPuppet.prototype._startWs = function () {
    var self = this;

    self._wsConn = new Ws4ever(self._opts.serverUrl);
    self._wsConn.onmessage = function (e) {
        self._onMessage(e.data);
    };
    self._wsConn.onerror = function (err) {
        console.error(err);
    };
};

BrowserPuppet.prototype._sendMessage = function (rawData) {
    var data = rawData;

    if (typeof data === 'object') {
        data = JSONF.stringify(data);
    }

    this._wsConn.send(data);
};

BrowserPuppet.prototype.isSelectorVisible = function (selector) {
    var $els = this.$(selector);

    if ($els.length === 0) {
        return false;
    }
    if (!$els.is(':visible')) {
        return false;
    }

    for (var i = 0; i < $els.length; i++) {
        var el = $els[i];
        var rect = el.getBoundingClientRect();
        var elCenterX = rect.left + rect.width / 2;
        var elCenterY = rect.top + rect.height / 2;
        var elFromPoint = document.elementFromPoint(elCenterX, elCenterY);

        if (elFromPoint === el || el.contains(elFromPoint)) {
            return true;
        }
    }

    return false;
};

BrowserPuppet.prototype._onMessage = function (rawData) {
    var self = this;

    if (self._isTerminating) {
        throw new Error('BrowserPuppet::_onMessage: cannot process message, puppet is terminating');
    }

    // no return
    Promise.try(function () {
        var data = JSONF.parse(rawData);

        switch (data.type) {
            case MESSAGES.DOWNSTREAM.EXEC_COMMAND:
            case MESSAGES.DOWNSTREAM.EXEC_FUNCTION:
                self._isExecuting = true;
                return self._onExecMessage(data);

            case MESSAGES.DOWNSTREAM.SET_SELECTOR_BECAME_VISIBLE_DATA:
                return self.setOnSelectorBecameVisibleSelectors(data.selectors);

            case MESSAGES.DOWNSTREAM.SHOW_SCREENSHOT_MARKER:
                return self.setScreenshotMarkerState(true);
            case MESSAGES.DOWNSTREAM.HIDE_SCREENSHOT_MARKER:
                return self.setScreenshotMarkerState(false);

            case MESSAGES.DOWNSTREAM.SET_TRANSMIT_EVENTS:
                return self.setTransmitEvents(data.value);

            case MESSAGES.DOWNSTREAM.CLEAR_PERSISTENT_DATA:
                return self.clearPersistentData();

            case MESSAGES.DOWNSTREAM.SET_MOUSEOVER_SELECTORS:
                self._mouseoverSelector = data.selectors.join(', ');
                self._attachMouseoverCaptureEventListener();
                return;

            case MESSAGES.DOWNSTREAM.SET_IGNORED_CLASSES:
                // TODO ugly
                self._uniqueSelector._opts.ignoredClasses = data.classes;
                return;

            // case MESSAGES.DOWNSTREAM.TERMINATE_PUPPET:
            //     self._isTerminating = true;
            //     return;

            default:
                throw new Error('BrowserPuppet: unknown message type: ' + data.type);
        }
    })
    .then(function (result) {
        self._log.info('Sending ACK message');
        self._sendMessage({ type: MESSAGES.UPSTREAM.ACK, result: result });
    })
    .catch(function (err) {
        var errorDTO = {};

        Object.keys(err).forEach(function (key) {
            if (!err.hasOwnProperty(key)) {
                return;
            }
            errorDTO[key] = err[key];
        });

        errorDTO.message = err.message;

        self._sendMessage({ type: MESSAGES.UPSTREAM.NAK, error: errorDTO });
    })
    .finally(function () {
        self._isExecuting = false;

        if (self._isTerminating) {
            self._wsConn.close();
            self._wsConn = null;
        }
    });
};

BrowserPuppet.prototype._canCapture = function () {
    return this._transmitEvents && !this._isExecuting;
};

BrowserPuppet.prototype._attachCaptureEventListeners = function () {
    document.addEventListener('click', this._onClickCapture.bind(this), true);
    document.addEventListener('focus', this._onFocusCapture.bind(this), true);
    document.addEventListener('input', this._onInputCapture.bind(this), true);
    document.addEventListener('scroll', this._onScrollCapture.bind(this), true);
    document.addEventListener('keydown', this._onKeydownCapture.bind(this), true);

    window.addEventListener('blur', this._onWindowBlur.bind(this));
};

BrowserPuppet.prototype._attachMouseoverCaptureEventListener = function () {
    // TODO check if listener is already attached
    document.body.addEventListener('mouseover', this._onMouseoverCapture.bind(this), true);
};

var SHIFT_KEY = 16;
var CTRL_KEY = 17;

BrowserPuppet.prototype._onClickCapture = function (event) {
    if (!this._canCapture()) {
        return;
    }

    var target = event.target;

    try {
        var selector = this._uniqueSelector.get(target);
        var fullSelectorPath = this._uniqueSelector.getFullSelectorPath(target);
    }
    catch (err) {
        console.error(err);
        return;
    }

    this._sendMessage({
        type: MESSAGES.UPSTREAM.CAPTURED_EVENT,
        event: {
            type: 'click',
            $timestamp: Date.now(),
            selector: selector,
            $fullSelectorPath: fullSelectorPath,
            target: cleanTarget(target),
        },
    });
};

BrowserPuppet.prototype._onFocusCapture = function (event) {
    if (!this._canCapture()) {
        return;
    }

    var target = event.target;

    if (this._activeElementBeforeWindowBlur === target) {
        this._log.debug('focus capture prevented during window re-focus');
        this._activeElementBeforeWindowBlur = null;
        return;
    }

    try {
        var selector = this._uniqueSelector.get(target);
        var fullSelectorPath = this._uniqueSelector.getFullSelectorPath(target);
    }
    catch (err) {
        console.error(err);
        return;
    }

    this._sendMessage({
        type: MESSAGES.UPSTREAM.CAPTURED_EVENT,
        event: {
            type: 'focus',
            $timestamp: Date.now(),
            selector: selector,
            $fullSelectorPath: fullSelectorPath,
            target: cleanTarget(target),
        },
    });
};

BrowserPuppet.prototype._onInputCapture = function (event) {
    if (!this._canCapture()) {
        return;
    }

    var target = event.target;

    try {
        var selector = this._uniqueSelector.get(target);
    }
    catch (err) {
        console.error(err);
        return;
    }

    this._sendMessage({
        type: MESSAGES.UPSTREAM.CAPTURED_EVENT,
        event: {
            type: 'input',
            $timestamp: Date.now(),
            selector: selector,
            value: target.value,
            target: cleanTarget(target),
        },
    });
};

var SCROLL_DEBOUNCE = 500;

BrowserPuppet.prototype._onScrollCapture = debounce(function (event) {
    if (!this._canCapture()) {
        return;
    }

    var target = event.target;

    try {
        var selector = this._uniqueSelector.get(target);
    }
    catch (err) {
        console.error(err);
        return;
    }

    var targetDTO = cleanTarget(target);
    targetDTO.scrollTop = target.scrollTop;

    this._sendMessage({
        type: MESSAGES.UPSTREAM.CAPTURED_EVENT,
        event: {
            type: 'scroll',
            $timestamp: Date.now(),
            selector: selector,
            target: targetDTO,
        },
    });
}, SCROLL_DEBOUNCE);

BrowserPuppet.prototype._onKeydownCapture = function (event) {
    if (!this._canCapture()) {
        return;
    }

    if (event.keyCode === SHIFT_KEY && event.ctrlKey === true ||
        event.keyCode === CTRL_KEY && event.shiftKey === true) {

        this._sendInsertAssertionDebounced();
        return;
    }

    var target = event.target;

    try {
        var selector = this._uniqueSelector.get(target);
    }
    catch (err) {
        console.error(err);
        return;
    }

    this._sendMessage({
        type: MESSAGES.UPSTREAM.CAPTURED_EVENT,
        event: {
            type: 'keydown',
            $timestamp: Date.now(),
            selector: selector,
            keyCode: event.keyCode || event.charCode,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            target: cleanTarget(target),
        },
    });
};

BrowserPuppet.prototype._onMouseoverCapture = function (event) {
    if (!this._canCapture()) {
        return;
    }

    var target = event.target;

    if (this.$(target).is(this._mouseoverSelector)) {
        try {
            var selector = this._uniqueSelector.get(target);
        }
        catch (err) {
            console.error(err);
            return;
        }

        this._sendMessage({
            type: MESSAGES.UPSTREAM.CAPTURED_EVENT,
            event: {
                type: 'mouseover',
                $timestamp: Date.now(),
                selector: selector,
                target: cleanTarget(target),
            },
        });
    }

};

BrowserPuppet.prototype._onWindowBlur = function () {
    this._activeElementBeforeWindowBlur = document.activeElement;
};

BrowserPuppet.prototype._sendInsertAssertionDebounced = debounce(function () {
    this._sendMessage({ type: MESSAGES.UPSTREAM.INSERT_ASSERTION });
}, INSERT_ASSERTION_DEBOUNCE);

BrowserPuppet.prototype.setOnSelectorBecameVisibleSelectors = function (selectors) {
    this._onSelectorBecameVisibleData.selectors = deepCopy(selectors);
    this._onSelectorBecameVisibleData.states = selectors.map(function () {
        return { previousState: null };
    });
};

BrowserPuppet.prototype.setTransmitEvents = function (value) {
    if (typeof value !== 'boolean') {
        throw new Error('BrowserPuppet::setTransmitEvents: invalid type for value');
    }
    this._transmitEvents = value;
};

BrowserPuppet.prototype._startOnSelectorBecameVisiblePolling = function () {
    this._onSelectorBecameVisibleData.intervalId =
        setInterval(this._onSelectorBecameVisiblePoll.bind(this), AUTODETECT_INTERVAL_MS);
};

BrowserPuppet.prototype._onSelectorBecameVisiblePoll = function () {
    var self = this;

    self._onSelectorBecameVisibleData.selectors.forEach(function (selector, i) {
        var state = self._onSelectorBecameVisibleData.states[i];

        // TODO send warning in message if selector is ambiguous

        var currentState = self.isSelectorVisible(selector);

        if (state.previousState !== null && !state.previousState && currentState) {
            self._sendMessage({ type: MESSAGES.UPSTREAM.SELECTOR_BECAME_VISIBLE, selector: selector });
        }

        state.previousState = currentState;
    });
};

BrowserPuppet.prototype._onExecMessage = Promise.method(function (data) {
    if (data.type === MESSAGES.DOWNSTREAM.EXEC_COMMAND) {
        return this.execCommand(data.command);
    }
    else if (data.type === MESSAGES.DOWNSTREAM.EXEC_FUNCTION) {
        return this.execFunction(data.fn, data.args);
    }

    throw new Error('Unknown exec type: ' + data.type);

});

BrowserPuppet.prototype.execFunction = Promise.method(function (fn/* , args*/) {
    var context = {
        driver: this,
        $: this.$,
        // TODO kell?
        jQuery: this.$,
        promiseWhile: promiseWhile,
        Promise: Promise,
    };

    // TODO args
    return fn.apply(context);
});

BrowserPuppet.prototype.execCommand = Promise.method(function (command) {
    switch (command.type) {
        case 'click':
            return this.click(command.selector);
        case 'setValue':
            return this.setValue(command.selector, command.value);
        case 'getValue':
            return this.getValue(command.selector);
        case 'pressKey':
            return this.pressKey(command.selector, command.keyCode);
        case 'waitForVisible':
            return this.waitForVisible(command.selector);
        case 'waitWhileVisible':
            return this.waitWhileVisible(command.selector);
        case 'focus':
            return this.focus(command.selector);
        case 'isVisible':
            return this.isVisible(command.selector);
        case 'scroll':
            return this.scroll(command.selector, command.scrollTop);
        case 'composite':
            return this.execCompositeCommand(command.commands);
        case 'mouseover':
            return this.mouseover(command.selector);
        case 'uploadFileAndAssign':
            return this.uploadFileAndAssign(command.fileData, command.destinationVariable);
        default:
            throw new Error('Unknown command type: ' + command.type);
    }
});

BrowserPuppet.prototype.execCompositeCommand = Promise.method(function (commands) {
    var self = this;

    return Promise.each(commands, function (command) {
        return self.execCommand(command);
    });
});

BrowserPuppet.prototype._execFn = Promise.method(function (fnData) {
    var argNames = fnData.argNames || [];
    var argValues = fnData.argValues || [];
    var fnBody = fnData.body;

    var fn;

    /* eslint-disable no-new-func */

    switch (argNames.length) {
        case 0: fn = new Function(fnBody);
            break;
        case 1: fn = new Function(argNames[0], fnBody);
            break;
        case 2: fn = new Function(argNames[0], argNames[1], fnBody);
            break;
        case 3: fn = new Function(argNames[0], argNames[1], argNames[2], fnBody);
            break;
        case 4: fn = new Function(argNames[0], argNames[1], argNames[2], argNames[3], fnBody);
            break;
        case 5: fn = new Function(argNames[0], argNames[1], argNames[2], argNames[3], argNames[4], fnBody);
            break;
        case 6: fn = new Function(argNames[0], argNames[1], argNames[2], argNames[3], argNames[4], argNames[5], fnBody);
            break;
        default:
            throw new Error('Too many args');
    }

    /* eslint-enable no-new-func */

    // TODO custom context?
    var context = {
        driver: this,
        $: this.$,
        // TODO kell?
        jQuery: this.$,
        promiseWhile: promiseWhile,
        Promise: Promise,
    };

    return fn.apply(context, argValues);
});

BrowserPuppet.prototype.clearPersistentData = function () {
    document.cookie = '';
    window.localStorage.clear();
};

BrowserPuppet.prototype.setScreenshotMarkerState = function (state) {
    if (state) {
        document.body.appendChild(this._ssMarkerTopLeft);
        document.body.appendChild(this._ssMarkerBottomRight);
    }
    else {
        document.body.removeChild(this._ssMarkerTopLeft);
        document.body.removeChild(this._ssMarkerBottomRight);
    }
};

// TODO rename to getTargetDTO
function cleanTarget(target) {
    return {
        className: target.className,
        id: target.id,
        innerText: target.innerText,
        tagName: target.tagName,
        type: target.type,
    };
}


function deepCopy(o) {
    return JSON.parse(JSON.stringify(o));
}

function assert(v, m) {
    if (!v) {
        throw new Error(m);
    }
}




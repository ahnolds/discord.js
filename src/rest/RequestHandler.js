'use strict';

const DiscordAPIError = require('./DiscordAPIError');
const HTTPError = require('./HTTPError');
const {
  Events: { RATE_LIMIT, INVALID_REQUEST_WARNING },
  browser,
} = require('../util/Constants');
const Util = require('../util/Util');

function parseResponse(res) {
  if (res.headers.get('content-type').startsWith('application/json')) return res.json();
  if (browser) return res.blob();
  return res.buffer();
}

function getAPIOffset(serverDate) {
  return new Date(serverDate).getTime() - Date.now();
}

function calculateReset(reset, serverDate) {
  return new Date(Number(reset) * 1000).getTime() - getAPIOffset(serverDate);
}

/* Invalid request limiting is done on a per-IP basis, not a per-token basis.
 * The best we can do is track invalid counts process-wide (on the theory that
 * users could have multiple bots run from one process) rather than per-bot.
 * Therefore, store these at file scope here rather than in the client's
 * RESTManager object.
 */
let invalidCount = 0;
let invalidCountResetTime = null;

class RequestHandler {
  constructor(manager) {
    this.manager = manager;
    this.busy = false;
    this.queue = [];
    this.reset = -1;
    this.remaining = -1;
    this.limit = -1;
  }

  push(request) {
    if (this.busy) {
      this.queue.push(request);
      return this.run();
    } else {
      return this.execute(request);
    }
  }

  run() {
    if (this.queue.length === 0) return Promise.resolve();
    return this.execute(this.queue.shift());
  }

  get globalLimited() {
    return this.manager.globalRemaining <= 0 && Date.now() < this.manager.globalReset;
  }

  get localLimited() {
    return this.remaining <= 0 && Date.now() < this.reset;
  }

  get limited() {
    return this.globalLimited || this.localLimited;
  }

  get _inactive() {
    return this.queue.length === 0 && !this.limited && this.busy !== true;
  }

  globalDelayFor(ms) {
    return new Promise(resolve => {
      this.manager.client.setTimeout(
        manager => {
          manager.globalDelay = null;
          resolve();
        },
        ms,
        this.manager,
      );
    });
  }

  async execute(item) {
    // Insert item back to the beginning if currently busy
    if (this.busy) {
      this.queue.unshift(item);
      return null;
    }

    this.busy = true;
    const { reject, request, resolve } = item;

    /*
     * After calculations have been done, pre-emptively stop further requests
     * Potentially loop until this task can run if e.g. the global rate limit is hit twice
     */
    while (this.limited) {
      let global, limit, timeout, delayPromise;

      if (this.globalLimited) {
        // Set the variables based on the global rate limit
        global = true;
        limit = this.manager.globalLimit;
        timeout = this.manager.globalReset + this.manager.client.options.restTimeOffset - Date.now();
        // If this is the first task to reach the global timeout, set the global delay
        if (!this.manager.globalDelay) {
          // The global delay function should clear the global delay state when it is resolved
          this.manager.globalDelay = this.globalDelayFor(timeout);
        }
        delayPromise = this.manager.globalDelay;
      } else {
        // Set the variables based on the route-specific rate limit
        global = false;
        limit = this.limit;
        timeout = this.reset + this.manager.client.options.restTimeOffset - Date.now();
        delayPromise = Util.delayFor(timeout);
      }

      if (this.manager.client.listenerCount(RATE_LIMIT)) {
        /**
         * Emitted when the client hits a rate limit while making a request
         * @event Client#rateLimit
         * @param {Object} rateLimitInfo Object containing the rate limit info
         * @param {number} rateLimitInfo.timeout Timeout in ms
         * @param {number} rateLimitInfo.limit Number of requests that can be made to this endpoint
         * @param {string} rateLimitInfo.method HTTP method used for request that triggered this event
         * @param {string} rateLimitInfo.path Path used for request that triggered this event
         * @param {string} rateLimitInfo.route Route used for request that triggered this event
         * @param {boolean} rateLimitInfo.global Whether the rate limit that was reached was the global limit
         */
        this.manager.client.emit(RATE_LIMIT, {
          timeout,
          limit: limit,
          method: request.method,
          path: request.path,
          route: request.route,
          global: global,
        });
      }

      // Wait for the timeout to expire in order to avoid an actual 429
      await delayPromise; // eslint-disable-line no-await-in-loop
    }

    // As the request goes out, update the global usage information
    if (!this.manager.globalReset || this.manager.globalReset < Date.now()) {
      this.manager.globalReset = Date.now() + 1000;
      this.manager.globalRemaining = this.manager.globalLimit;
    }
    this.manager.globalRemaining--;

    // Perform the request
    let res;
    try {
      res = await request.make();
    } catch (error) {
      // NodeFetch error expected for all "operational" errors, which does **not** include 3xx-5xx status codes
      this.busy = false;
      return reject(new HTTPError(error.message, error.constructor.name, error.status, request.method, request.path));
    }

    if (res && res.headers) {
      const serverDate = res.headers.get('date');
      const limit = res.headers.get('x-ratelimit-limit');
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = res.headers.get('x-ratelimit-reset');
      this.limit = limit ? Number(limit) : Infinity;
      this.remaining = remaining ? Number(remaining) : 1;
      this.reset = reset ? calculateReset(reset, serverDate) : Date.now();

      // https://github.com/discordapp/discord-api-docs/issues/182
      if (item.request.route.includes('reactions')) {
        this.reset = new Date(serverDate).getTime() - getAPIOffset(serverDate) + 250;
      }

      // Handle retryAfter, which means we have actually hit a rate limit
      let retryAfter = res.headers.get('retry-after');
      retryAfter = retryAfter ? Number(retryAfter) : -1;
      if (retryAfter > 0) {
        // If the global ratelimit header is set, that means we hit the global rate limit
        if (res.headers.get('x-ratelimit-global')) {
          this.manager.globalRemaining = 0;
          this.manager.globalReset = Date.now() + retryAfter;
        } else if (!this.localLimited) {
          /*
           * This is a sublimit (e.g. 2 channel name changes/10 minutes) since the headers don't indicate a
           * route-wide rate limit. Don't update remaining or reset to avoid rate limit the whole endpoint,
           * just set a reset time on the request itself to avodi retrying too soon.
           */
          res.sublimit = retryAfter;
        }
      }
    }

    // Finished handling headers, safe to unlock manager
    this.busy = false;

    // Count the invalid requests
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      if (!invalidCountResetTime || invalidCountResetTime < Date.now()) {
        invalidCountResetTime = Date.now() + 1000 * 60 * 10;
        invalidCount = 0;
      }
      invalidCount++;

      const emitInvalid =
        this.manager.client.listenerCount(INVALID_REQUEST_WARNING) &&
        this.manager.client.options.invalidRequestWarningInterval > 0 &&
        invalidCount % this.manager.client.options.invalidRequestWarningInterval === 0;
      if (emitInvalid) {
        /**
         * Emitted periodically when the process sends invalid messages to let users avoid the
         * 10k invalid messages in 10 minutes threshold that causes a ban
         * @event Client#invalidRequestWarning
         * @param {number} invalidRequestWarningInfo.count Number of invalid requests that have been made in the window
         * @param {number} invalidRequestWarningInfo.remainingTime Time in ms remaining before the count resets
         */
        this.manager.client.emit(INVALID_REQUEST_WARNING, {
          count: invalidCount,
          remainingTime: invalidCountResetTime - Date.now(),
        });
      }
    }

    if (res.ok) {
      const success = await parseResponse(res);
      // Nothing wrong with the request, proceed with the next one
      resolve(success);
      return this.run();
    } else if (res.status === 429) {
      // A ratelimit was hit - this should never happen
      this.manager.client.emit('debug', `429 hit on route ${item.request.route}${res.sublimit ? ' for sublimit' : ''}`);
      // If caused by a sublimit, wait it out here so other requests on the route can be handled
      if (res.sublimit) {
        await Util.delayFor(res.sublimit);
        delete res.sublimit;
      }
      // Don't put the item back on the queue until after waiting out any sublimit it may have
      this.queue.unshift(item);
      return this.run();
    } else if (res.status >= 500 && res.status < 600) {
      // Retry the specified number of times for possible serverside issues
      if (item.retries === this.manager.client.options.retryLimit) {
        return reject(
          new HTTPError(res.statusText, res.constructor.name, res.status, item.request.method, request.path),
        );
      } else {
        item.retries++;
        this.queue.unshift(item);
        return this.run();
      }
    } else {
      // Handle possible malformed requests
      try {
        const data = await parseResponse(res);
        if (res.status >= 400 && res.status < 500) {
          return reject(new DiscordAPIError(request.path, data, request.method, res.status));
        }
        return null;
      } catch (err) {
        return reject(new HTTPError(err.message, err.constructor.name, err.status, request.method, request.path));
      }
    }
  }
}

module.exports = RequestHandler;

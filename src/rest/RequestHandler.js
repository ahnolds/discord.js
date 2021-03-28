'use strict';

const AsyncQueue = require('./AsyncQueue');
const DiscordAPIError = require('./DiscordAPIError');
const HTTPError = require('./HTTPError');
const {
  Events: { RATE_LIMIT, INVALID_REQUEST_WARNING },
} = require('../util/Constants');
const Util = require('../util/Util');

function parseResponse(res) {
  if (res.headers.get('content-type').startsWith('application/json')) return res.json();
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
    this.queue = new AsyncQueue();
    this.reset = -1;
    this.remaining = -1;
    this.limit = -1;
  }

  async push(request) {
    await this.queue.wait();
    try {
      return await this.execute(request);
    } finally {
      this.queue.shift();
    }
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
    return this.queue.remaining === 0 && !this.limited;
  }

  globalDelayFor(ms) {
    return new Promise(resolve => {
      this.manager.client.setTimeout(() => {
        this.manager.globalDelay = null;
        resolve();
      }, ms);
    });
  }

  async execute(request) {
    /*
     * After calculations have been done, pre-emptively stop further requests
     * Potentially loop until this task can run if e.g. the global rate limit is hit twice
     */
    while (this.limited) {
      const isGlobal = this.globalLimited;
      let limit, timeout, delayPromise;

      if (isGlobal) {
        // Set the variables based on the global rate limit
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
          limit,
          method: request.method,
          path: request.path,
          route: request.route,
          global: isGlobal,
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
      // Retry the specified number of times for request abortions
      if (request.retries === this.manager.client.options.retryLimit) {
        throw new HTTPError(error.message, error.constructor.name, error.status, request.method, request.path);
      }

      request.retries++;
      return this.execute(request);
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
      if (request.route.includes('reactions')) {
        this.reset = new Date(serverDate).getTime() - getAPIOffset(serverDate) + 250;
      }

      // Handle retryAfter, which means we have actually hit a rate limit
      let retryAfter = res.headers.get('retry-after');
      retryAfter = retryAfter ? Number(retryAfter) * 1000 : -1;
      if (retryAfter > 0) {
        // If the global ratelimit header is set, that means we hit the global rate limit
        if (res.headers.get('x-ratelimit-global')) {
          this.manager.globalRemaining = 0;
          this.manager.globalReset = Date.now() + retryAfter;
        } else if (!this.localLimited) {
          /*
           * This is a sublimit (e.g. 2 channel name changes/10 minutes) since the headers don't indicate a
           * route-wide rate limit. Don't update remaining or reset to avoid rate limiting the whole
           * endpoint, just set a reset time on the request itself to avoid retrying too soon.
           */
          res.sublimit = retryAfter;
        }
      }
    }

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
         * 10k invalid requests in 10 minutes threshold that causes a ban
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

    // Handle 2xx and 3xx responses
    if (res.ok) {
      // Nothing wrong with the request, proceed with the next one
      return parseResponse(res);
    }

    // Handle 4xx responses
    if (res.status >= 400 && res.status < 500) {
      // Handle ratelimited requests
      if (res.status === 429) {
        // A ratelimit was hit - this should never happen
        this.manager.client.emit('debug', `429 hit on route ${request.route}${res.sublimit ? ' for sublimit' : ''}`);
        // If caused by a sublimit, wait it out here so other requests on the route can be handled
        if (res.sublimit) {
          await Util.delayFor(res.sublimit);
          delete res.sublimit;
        }
        return this.execute(request);
      }

      // Handle possible malformed requests
      let data;
      try {
        data = await parseResponse(res);
      } catch (err) {
        throw new HTTPError(err.message, err.constructor.name, err.status, request.method, request.path);
      }

      throw new DiscordAPIError(request.path, data, request.method, res.status);
    }

    // Handle 5xx responses
    if (res.status >= 500 && res.status < 600) {
      // Retry the specified number of times for possible serverside issues
      if (request.retries === this.manager.client.options.retryLimit) {
        throw new HTTPError(res.statusText, res.constructor.name, res.status, request.method, request.path);
      }

      request.retries++;
      return this.execute(request);
    }

    // Fallback in the rare case a status code outside the range 200..=599 is returned
    return null;
  }
}

module.exports = RequestHandler;

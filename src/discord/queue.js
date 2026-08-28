/**
 * Serialized, rate-limit-aware operation queue for Discord REST mutations.
 */

const MIN_OP_DELAY_MS = 350;
const MAX_429_RETRIES = 3;

class OpQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.lastOpFinishedAt = 0;
  }

  /**
   * Enqueue a mutation task to run through the serialized queue.
   * @param {() => Promise<any>} task - Async function performing the mutation.
   * @param {string} description - Brief description for logging/debugging.
   * @returns {Promise<any>}
   */
  enqueue(task, description = 'Discord Op') {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, description, resolve, reject, retries: 0 });
      this.processNext();
    });
  }

  async processNext() {
    if (this.processing) return;
    if (this.queue.length === 0) return;

    this.processing = true;
    const item = this.queue.shift();

    try {
      // Respect minimum delay between operations
      const now = Date.now();
      const elapsed = now - this.lastOpFinishedAt;
      if (elapsed < MIN_OP_DELAY_MS) {
        await new Promise((r) => setTimeout(r, MIN_OP_DELAY_MS - elapsed));
      }

      const result = await this.executeWithRetry(item);
      this.lastOpFinishedAt = Date.now();
      item.resolve(result);
    } catch (err) {
      this.lastOpFinishedAt = Date.now();
      item.reject(err);
    } finally {
      this.processing = false;
      // Process next item in microtask/next tick
      setTimeout(() => this.processNext(), 0);
    }
  }

  async executeWithRetry(item) {
    while (true) {
      try {
        return await item.task();
      } catch (err) {
        const isRateLimit =
          err.status === 429 ||
          err.code === 429 ||
          err.name === 'RateLimitError' ||
          err.global ||
          (err.rawError && err.rawError.retry_after !== undefined);

        if (isRateLimit && item.retries < MAX_429_RETRIES) {
          item.retries++;
          const retryAfterSec =
            err.retryAfter ||
            (err.rawError && err.rawError.retry_after) ||
            1;
          const waitMs = Math.ceil(retryAfterSec * 1000) + 150;
          console.warn(`[OpQueue] Rate limited (429) on "${item.description}". Retrying ${item.retries}/${MAX_429_RETRIES} in ${waitMs}ms...`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        // For other 4xx/5xx or max retries exceeded, throw to handler
        throw err;
      }
    }
  }
}

export const opQueue = new OpQueue();

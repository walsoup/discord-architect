/**
 * Server-Sent Events (SSE) manager with run-specific buffers and heartbeat.
 */

class SSEManager {
  constructor() {
    this.runs = new Map(); // runId -> { clients: Set, buffer: Array, heartbeatTimer, closed: boolean }
  }

  /**
   * Initialize a new run stream.
   */
  createRun(runId) {
    if (this.runs.has(runId)) {
      return this.runs.get(runId);
    }

    const run = {
      runId,
      clients: new Set(),
      buffer: [],
      closed: false,
      heartbeatTimer: null
    };

    // 15s heartbeat to keep connection alive
    run.heartbeatTimer = setInterval(() => {
      this.sendRaw(run, ': heartbeat\n\n');
    }, 15000);

    this.runs.set(runId, run);

    // Auto cleanup abandoned runs after 10 minutes
    setTimeout(() => {
      this.cleanup(runId);
    }, 10 * 60 * 1000);

    return run;
  }

  /**
   * Attach an Express response object to a runId stream.
   */
  attach(runId, res) {
    let run = this.runs.get(runId);
    if (!run) {
      run = this.createRun(runId);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();

    run.clients.add(res);

    // Send all buffered events that happened before client connected
    for (const message of run.buffer) {
      res.write(message);
    }

    res.on('close', () => {
      run.clients.delete(res);
      if (run.clients.size === 0 && run.closed) {
        this.cleanup(runId);
      }
    });
  }

  /**
   * Emit an event to all connected clients for a runId.
   */
  emit(runId, eventType, data = {}) {
    let run = this.runs.get(runId);
    if (!run) {
      run = this.createRun(runId);
    }

    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const message = `event: ${eventType}\ndata: ${payload}\n\n`;

    // Add to buffer in case frontend connected slightly late
    run.buffer.push(message);

    this.sendRaw(run, message);
  }

  /**
   * Send raw text chunk to all active clients for a run.
   */
  sendRaw(run, rawText) {
    for (const client of run.clients) {
      try {
        client.write(rawText);
      } catch (err) {
        console.error('Error writing to SSE client:', err.message);
      }
    }
  }

  /**
   * Close a run stream and notify clients.
   */
  close(runId) {
    const run = this.runs.get(runId);
    if (!run) return;

    run.closed = true;

    // Give clients 1 second to receive final events before closing
    setTimeout(() => {
      for (const client of run.clients) {
        try {
          client.end();
        } catch (_) {}
      }
      this.cleanup(runId);
    }, 1000);
  }

  /**
   * Free memory and timers for a run.
   */
  cleanup(runId) {
    const run = this.runs.get(runId);
    if (!run) return;

    if (run.heartbeatTimer) {
      clearInterval(run.heartbeatTimer);
    }
    this.runs.delete(runId);
  }
}

export const sseManager = new SSEManager();

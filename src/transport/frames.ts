import type { RawData, WebSocket } from 'ws';

export interface Frame {
  data: Buffer;
  isBinary: boolean;
}

/** Turns session messages into wire frames and back. Implementations must throw on bad input. */
export interface FrameCodec {
  encode(text: string): string | Buffer;
  decode(frame: Frame): string;
}

export function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** A peer that floods frames before the handshake finishes is cut off. */
const MAX_QUEUED_FRAMES = 32;

export class FrameQueueClosedError extends Error {
  constructor() {
    super('Socket closed');
  }
}

export class FrameTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for peer');
  }
}

/**
 * Buffers incoming frames so the handshake can be written as sequential `await next()` calls.
 * `detach()` hands any frames that arrived early over to the session that takes the socket next.
 */
export class FrameQueue {
  private readonly frames: Frame[] = [];
  private waiter: { resolve: (f: Frame) => void; reject: (e: Error) => void } | undefined;
  private closed = false;

  constructor(private readonly ws: WebSocket) {
    ws.on('message', this.onMessage);
    ws.on('close', this.onClose);
  }

  next(timeoutMs: number): Promise<Frame> {
    const queued = this.frames.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new FrameQueueClosedError());
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new FrameTimeoutError());
      }, timeoutMs);
      this.waiter = {
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  detach(): Frame[] {
    this.ws.off('message', this.onMessage);
    this.ws.off('close', this.onClose);
    return this.frames.splice(0);
  }

  private readonly onMessage = (data: RawData, isBinary: boolean) => {
    const frame = { data: toBuffer(data), isBinary };
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter.resolve(frame);
    } else if (this.frames.length >= MAX_QUEUED_FRAMES) {
      this.ws.terminate();
    } else {
      this.frames.push(frame);
    }
  };

  private readonly onClose = () => {
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(new FrameQueueClosedError());
  };
}

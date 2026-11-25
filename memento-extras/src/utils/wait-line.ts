// A waiting line: at most `running` jobs at once; the rest wait their turn, first come first
// served. At most `waiting` can wait, each for at most `timeoutMs`; beyond that a job fails
// with the error given, rather than the line growing without bound.

type Waiter = { start: () => void; timer: NodeJS.Timeout };

export class WaitLine {
  readonly #running: number;
  readonly #waiting: number;
  readonly #timeoutMs: number;
  readonly #tooMany: () => Error;
  readonly #tooLong: () => Error;
  #active = 0;
  readonly #line: Waiter[] = [];

  constructor(opts: { running: number; waiting: number; timeoutMs: number; tooMany: () => Error; tooLong: () => Error }) {
    this.#running = opts.running;
    this.#waiting = opts.waiting;
    this.#timeoutMs = opts.timeoutMs;
    this.#tooMany = opts.tooMany;
    this.#tooLong = opts.tooLong;
  }

  // Runs `job` when its turn comes.
  async run<T>(job: () => Promise<T>): Promise<T> {
    await this.#turn();
    try {
      return await job();
    } finally {
      this.#next();
    }
  }

  #turn(): Promise<void> {
    if (this.#active < this.#running && this.#line.length === 0) {
      this.#active++;
      return Promise.resolve();
    }
    if (this.#line.length >= this.#waiting) return Promise.reject(this.#tooMany());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        start: resolve,
        timer: setTimeout(() => {
          this.#line.splice(this.#line.indexOf(waiter), 1);
          reject(this.#tooLong());
        }, this.#timeoutMs),
      };
      this.#line.push(waiter);
    });
  }

  // A job ended: its place goes straight to the first in line, if any.
  #next(): void {
    const waiter = this.#line.shift();
    if (!waiter) {
      this.#active--;
      return;
    }
    clearTimeout(waiter.timer);
    waiter.start();
  }
}

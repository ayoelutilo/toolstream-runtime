export class AsyncEventChannel<T> {
  private readonly queue: T[] = [];
  private readonly waiters: Array<(value: T | undefined) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
      return;
    }

    this.queue.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(undefined);
      }
    }
  }

  private async nextValue(): Promise<T | undefined> {
    if (this.queue.length > 0) {
      return this.queue.shift();
    }

    if (this.closed) {
      return undefined;
    }

    return new Promise<T | undefined>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async *values(): AsyncGenerator<T, void, undefined> {
    while (true) {
      const value = await this.nextValue();
      if (value === undefined) {
        return;
      }
      yield value;
    }
  }
}

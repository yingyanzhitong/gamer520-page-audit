export class TaskControl {
  #interrupted = false;
  #waiters = new Set();

  get interrupted() {
    return this.#interrupted;
  }

  interrupt() {
    if (this.#interrupted) return false;
    this.#interrupted = true;
    return true;
  }

  resume() {
    if (!this.#interrupted) return false;
    this.#interrupted = false;
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
    return true;
  }

  async checkpoint() {
    while (this.#interrupted) {
      await new Promise((resolve) => {
        this.#waiters.add(resolve);
      });
    }
  }
}

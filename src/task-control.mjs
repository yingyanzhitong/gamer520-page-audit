export class TaskTerminatedError extends Error {
  constructor(message = "管理员已终止任务") {
    super(message);
    this.name = "TaskTerminatedError";
    this.code = "TASK_TERMINATED";
  }
}

export function isTaskTerminatedError(error) {
  return (
    error instanceof TaskTerminatedError ||
    error?.code === "TASK_TERMINATED"
  );
}

export class TaskControl {
  #interrupted = false;
  #terminated = false;
  #waiters = new Set();
  #abortController = new AbortController();

  get interrupted() {
    return this.#interrupted;
  }

  get terminated() {
    return this.#terminated;
  }

  get signal() {
    return this.#abortController.signal;
  }

  pause() {
    return this.interrupt();
  }

  interrupt() {
    if (this.#terminated || this.#interrupted) return false;
    this.#interrupted = true;
    return true;
  }

  resume() {
    if (this.#terminated || !this.#interrupted) return false;
    this.#interrupted = false;
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
    return true;
  }

  terminate() {
    if (this.#terminated) return false;
    this.#terminated = true;
    this.#interrupted = false;
    this.#abortController.abort(new TaskTerminatedError());
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
    return true;
  }

  async checkpoint() {
    if (this.#terminated) throw new TaskTerminatedError();
    while (this.#interrupted) {
      await new Promise((resolve) => {
        this.#waiters.add(resolve);
      });
      if (this.#terminated) throw new TaskTerminatedError();
    }
  }
}

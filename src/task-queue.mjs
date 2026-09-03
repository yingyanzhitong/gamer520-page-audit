function taskSummary(task) {
  return {
    id: task.id,
    taskType: task.taskType,
    reason: task.reason,
    mode: task.mode,
    accountIds: task.options.accountIds ?? [],
    gameIds: task.options.gameIds ?? [],
    queuedAt: task.queuedAt,
  };
}

export class TaskQueue {
  constructor({ now = () => new Date().toISOString() } = {}) {
    this.now = now;
    this.sequence = 0;
    this.tasks = [];
  }

  enqueue({ taskType, reason, mode = null, options = {} }) {
    const task = {
      id: `queue-${Date.now()}-${++this.sequence}`,
      taskType,
      reason,
      mode,
      options: structuredClone(options),
      queuedAt: this.now(),
    };
    this.tasks.push(task);
    return {
      ...taskSummary(task),
      queuePosition: this.tasks.length,
    };
  }

  dequeue() {
    return this.tasks.shift() ?? null;
  }

  remove(id) {
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index < 0) return null;
    return taskSummary(this.tasks.splice(index, 1)[0]);
  }

  clear() {
    const removed = this.tasks.map(taskSummary);
    this.tasks = [];
    return removed;
  }

  list() {
    return this.tasks.map(taskSummary);
  }

  get size() {
    return this.tasks.length;
  }
}

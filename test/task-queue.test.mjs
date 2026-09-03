import assert from "node:assert/strict";
import test from "node:test";

import { TaskQueue } from "../src/task-queue.mjs";

test("任务队列按提交顺序保存快照，并可删除指定任务", () => {
  const queue = new TaskQueue({
    now: () => "2026-09-03T00:00:00.000Z",
  });
  const options = { accountIds: ["account-a"], gameIds: [118842] };
  const first = queue.enqueue({
    taskType: "sync",
    reason: "manual-game",
    mode: "all",
    options,
  });
  options.gameIds.push(118843);
  const second = queue.enqueue({
    taskType: "crawl",
    reason: "manual",
  });

  assert.equal(first.queuePosition, 1);
  assert.equal(second.queuePosition, 2);
  assert.deepEqual(queue.list(), [
    {
      id: first.id,
      taskType: "sync",
      reason: "manual-game",
      mode: "all",
      accountIds: ["account-a"],
      gameIds: [118842],
      queuedAt: "2026-09-03T00:00:00.000Z",
    },
    {
      id: second.id,
      taskType: "crawl",
      reason: "manual",
      mode: null,
      accountIds: [],
      gameIds: [],
      queuedAt: "2026-09-03T00:00:00.000Z",
    },
  ]);

  assert.equal(queue.remove(first.id).id, first.id);
  assert.equal(queue.remove(first.id), null);
  assert.equal(queue.dequeue().id, second.id);
  assert.equal(queue.size, 0);
});

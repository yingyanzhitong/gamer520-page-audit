import assert from "node:assert/strict";
import test from "node:test";

import { TaskControl } from "../src/task-control.mjs";

test("任务在安全检查点中断并可继续执行", async () => {
  const control = new TaskControl();
  control.interrupt();

  let continued = false;
  const waiting = control.checkpoint().then(() => {
    continued = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(control.interrupted, true);
  assert.equal(continued, false);

  control.resume();
  await waiting;
  assert.equal(control.interrupted, false);
  assert.equal(continued, true);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskControl,
  TaskTerminatedError,
} from "../src/task-control.mjs";

test("任务可立即进入暂停状态并在恢复后继续执行", async () => {
  const control = new TaskControl();
  assert.equal(control.pause(), true);
  assert.equal(control.pause(), false);

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

test("终止会唤醒暂停任务并使后续检查点不可恢复", async () => {
  const control = new TaskControl();
  control.pause();

  const waiting = control.checkpoint();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(control.terminate(), true);
  assert.equal(control.terminate(), false);
  await assert.rejects(waiting, TaskTerminatedError);
  assert.equal(control.interrupted, false);
  assert.equal(control.terminated, true);
  assert.equal(control.resume(), false);
  await assert.rejects(control.checkpoint(), TaskTerminatedError);
});

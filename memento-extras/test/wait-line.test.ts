// The waiting line saves take turns in (utils/wait-line.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { WaitLine } from "../src/utils/wait-line.ts";

const line = (running: number, waiting: number, timeoutMs = 1000) =>
  new WaitLine({ running, waiting, timeoutMs, tooMany: () => new Error("too many"), tooLong: () => new Error("too long") });

// A job that runs until released.
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("runs at most `running` at once; the rest wait and go in the order they came", async () => {
  const saves = line(2, 10);
  const started: number[] = [];
  const gates = [gate(), gate(), gate(), gate()];
  const runs = gates.map((g, i) =>
    saves.run(async () => {
      started.push(i);
      await g.opened;
      return i;
    }),
  );
  await tick();
  assert.deepEqual(started, [0, 1]);
  gates[1]!.open();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  gates[0]!.open();
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[2]!.open();
  gates[3]!.open();
  assert.deepEqual(await Promise.all(runs), [0, 1, 2, 3]);
});

test("a failed job frees its place too", async () => {
  const saves = line(1, 10);
  await assert.rejects(saves.run(async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(await saves.run(async () => "next"), "next");
});

test("no more than `waiting` can wait: the next is refused at once", async () => {
  const saves = line(1, 1);
  const g = gate();
  const running = saves.run(() => g.opened);
  const waiting = saves.run(async () => "waited");
  await assert.rejects(saves.run(async () => "refused"), /too many/);
  g.open();
  await running;
  assert.equal(await waiting, "waited");
});

test("waiting too long fails, and the one that gave up doesn't take a place later", async () => {
  const saves = line(1, 5, 30);
  const g = gate();
  const running = saves.run(() => g.opened);
  await assert.rejects(saves.run(async () => "never"), /too long/);
  g.open();
  await running;
  const g2 = gate();
  const next = saves.run(() => g2.opened.then(() => "next"));
  const after = saves.run(async () => "after"); // waits behind `next`, not behind a ghost
  g2.open();
  assert.deepEqual(await Promise.all([next, after]), ["next", "after"]);
});

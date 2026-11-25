// Runs vips, ffmpeg and the other tools at the lowest CPU priority (nice 19, on top of the
// container's own low CPU weight), with a time limit. Fails with the end of what the tool printed.

import { type ChildProcess, spawn } from "node:child_process";

export class Deadline {
  private readonly end: number;
  constructor(ms: number) {
    this.end = Date.now() + ms;
  }
  left(): number {
    const ms = this.end - Date.now();
    if (ms <= 0) throw new Error("took too long");
    return ms;
  }
}

export function run(command: string, args: string[], deadline: Deadline, perCommandMs = 120_000): Promise<string> {
  return pipeline([[command, args]], deadline, perCommandMs);
}

// Runs the commands with each one's output going straight into the next (`a | b`), and returns
// what the last one printed. All are stopped at the time limit, and all of them if one fails
// (the others couldn't finish without it).
export function pipeline(commands: Array<[string, string[]]>, deadline: Deadline, perCommandMs = 120_000): Promise<string> {
  const limit = Math.min(perCommandMs, deadline.left());
  const children: ChildProcess[] = [];
  const stopAll = () => children.forEach((child) => child.kill("SIGKILL"));
  try {
    for (const [command, args] of commands) {
      const before = children.at(-1);
      children.push(spawn("nice", ["-n", "19", command, ...args], { stdio: [before ? before.stdout! : "ignore", "pipe", "pipe"] }));
      // The next command has the pipe now; ours would keep it open (the one before would never
      // see the next one go, and its output would never end).
      before?.stdout!.destroy();
    }
  } catch (error) {
    stopAll(); // one couldn't be started: none is left running
    return Promise.reject(error);
  }
  // Our own timer, so a kill for time can be told apart from the kernel's for memory.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stopAll();
  }, limit);
  const finished = children.map((child, i) => new Promise<string>((resolve, reject) => {
    let out = "";
    let err = "";
    if (i === children.length - 1) child.stdout!.on("data", (d: Buffer) => (out = (out + d.toString()).slice(-4096)));
    child.stderr!.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2048)));
    child.on("error", (error) => {
      stopAll();
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (code === 0) return resolve(out);
      stopAll();
      const why = timedOut
        ? `took too long (over its ${Math.round(limit / 1000)} s)`
        : signal === "SIGKILL"
          ? "was stopped by the system, most likely for running out of memory"
          : signal ? `was stopped (${signal})` : `failed (${code})`;
      reject(new Error(`${commands[i]![0]} ${why}: ${err.trim().slice(-500)}`.replace(/: $/, "")));
    });
  }));
  return Promise.all(finished).then((outs) => outs.at(-1)!).finally(() => clearTimeout(timer));
}

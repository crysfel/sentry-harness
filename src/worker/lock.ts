import fs from "node:fs";
import path from "node:path";

/**
 * Machine-wide lock: one worker process, hence one job at a time (PLAN §6:
 * simulators and Xcode's build system do not share well). Inside the worker,
 * jobs already run strictly one after another; this file stops a second worker.
 */
export class ProcessLock {
  constructor(private file: string) {}

  acquire(): boolean {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    for (let i = 0; i < 2; i++) {
      try {
        const fd = fs.openSync(this.file, "wx");
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const pid = Number(fs.readFileSync(this.file, "utf8").trim());
        if (pid && pid !== process.pid && isAlive(pid)) return false;
        fs.rmSync(this.file, { force: true }); // stale lock from a crashed worker
      }
    }
    return false;
  }

  release() {
    try {
      if (fs.readFileSync(this.file, "utf8").trim() === String(process.pid)) fs.rmSync(this.file, { force: true });
    } catch {
      /* already gone */
    }
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

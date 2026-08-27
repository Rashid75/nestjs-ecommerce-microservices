/**
 * Kills whatever is listening on this project's development ports.
 *
 * WHY THIS EXISTS
 *
 * `nx serve` spawns each application as a CHILD process. On Windows, stopping
 * the parent — Ctrl+C, closing the terminal, or the IDE stopping the task —
 * does not reliably take the children with it. The result is an orphan: the
 * terminal is back at a prompt, so the servers look stopped, but node is still
 * holding 3000 and 3001.
 *
 * The next `npm start` then fails with EADDRINUSE, and because `serve` is a
 * long-running watch task Nx keeps it alive rather than exiting — which looks
 * exactly like a hang.
 *
 * Run `npm run stop` whenever the ports feel haunted.
 *
 * Usage:
 *   node tools/free-ports.mjs            # the default set below
 *   node tools/free-ports.mjs 3000 4000  # specific ports
 */
import { execSync } from 'node:child_process';

/**
 * 3000/3001 are the HTTP ports. 9229/9230 are the Node INSPECTOR ports that
 * @nx/js:node attaches — an orphan holding 9229 produces
 * "Starting inspector on localhost:9229 failed: address already in use",
 * which stops the second service from booting even when its HTTP port is free.
 */
const DEFAULT_PORTS = [3000, 3001, 9229, 9230];

const ports = process.argv.slice(2).length
  ? process.argv.slice(2).map(Number)
  : DEFAULT_PORTS;

/** Returns the PIDs listening on `port`, or an empty array. */
function findListeners(port) {
  try {
    if (process.platform === 'win32') {
      // netstat -ano: -a all connections, -n numeric, -o owning PID.
      // Filter to LISTENING so we do not kill a client that merely connected.
      const output = execSync(`netstat -ano -p TCP | findstr ":${port} "`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return [
        ...new Set(
          output
            .split(/\r?\n/)
            .filter((line) => line.includes('LISTENING'))
            .map((line) => line.trim().split(/\s+/).pop())
            .filter((pid) => pid && pid !== '0'),
        ),
      ];
    }

    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split(/\r?\n/).filter(Boolean);
  } catch {
    // Both netstat|findstr and lsof exit non-zero when nothing matches, which
    // is the normal "port is free" case, not an error.
    return [];
  }
}

function kill(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' });
    } else {
      process.kill(Number(pid), 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}

let killed = 0;

for (const port of ports) {
  const pids = findListeners(port);

  if (pids.length === 0) {
    console.log(`port ${port}: free`);
    continue;
  }

  for (const pid of pids) {
    if (kill(pid)) {
      console.log(`port ${port}: killed pid ${pid}`);
      killed += 1;
    } else {
      console.log(
        `port ${port}: could not kill pid ${pid} — it may belong to another user`,
      );
    }
  }
}

console.log(
  killed === 0
    ? 'nothing to clean up.'
    : `cleaned up ${killed} process(es). safe to run npm start.`,
);

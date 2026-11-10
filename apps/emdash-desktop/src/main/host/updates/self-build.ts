import { spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { buildExternalToolEnv } from '@main/lib/childProcessEnv';

/**
 * Fork-only self-build updates. When `~/.local/bin/emdash-update` exists, "Download" runs that
 * script (sync fork with upstream, pull, build, sign) instead of fetching the official release,
 * and "Restart" quits so the script's helper can swap the new build into /Applications and
 * relaunch it. Official builds are signed by a different team, so Squirrel cannot install them
 * over a self-signed fork build anyway.
 */
const SCRIPT_PATH = path.join(os.homedir(), '.local', 'bin', 'emdash-update');
const STATE_DIR = path.join(os.homedir(), 'Library', 'Caches', 'emdash-update');
const RELAUNCH_MARKER = path.join(STATE_DIR, 'relaunch-requested');
const LOG_HINT = '~/Library/Logs/emdash-update.log';
/** Script exit code when another build already holds its lock (EX_TEMPFAIL). */
const EXIT_ALREADY_RUNNING = 75;

export function isSelfBuildEnabled(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    accessSync(SCRIPT_PATH, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the update script detached so the build survives the app quitting. Resolves once the
 * build is ready to swap in; the script then waits for the app to quit before installing.
 */
export function runSelfBuild(): Promise<void> {
  const env = buildExternalToolEnv();
  // A production NODE_ENV would make `pnpm install` skip devDependencies the build needs.
  delete env.NODE_ENV;
  delete env.ELECTRON_RUN_AS_NODE;
  env.EMDASH_UPDATE_RELAUNCH_MARKER = RELAUNCH_MARKER;

  return new Promise((resolve, reject) => {
    const child = spawn(SCRIPT_PATH, [], { detached: true, stdio: 'ignore', env });
    child.once('error', (error) => {
      reject(new Error(`Could not start ${SCRIPT_PATH}: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else if (code === EXIT_ALREADY_RUNNING)
        reject(new Error('An update build is already running'));
      else reject(new Error(`Update build failed (${signal ?? `exit ${code}`}). See ${LOG_HINT}`));
    });
    child.unref();
  });
}

/** Asks the script's helper to relaunch after the swap, then quits through the normal flow. */
export function quitForSwap(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(RELAUNCH_MARKER, '');
  app.quit();
}

export function cancelRelaunchRequest(): void {
  rmSync(RELAUNCH_MARKER, { force: true });
}

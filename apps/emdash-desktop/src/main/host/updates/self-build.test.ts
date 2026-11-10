import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSelfBuild } from './self-build';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), quit: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('electron', () => ({ app: { quit: mocks.quit } }));

let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };

beforeEach(() => {
  child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  mocks.spawn.mockReset().mockReturnValue(child);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runSelfBuild', () => {
  it('runs the script detached with a clean env and the relaunch marker', async () => {
    const result = runSelfBuild();
    child.emit('exit', 0, null);
    await expect(result).resolves.toBeUndefined();

    const [command, args, options] = mocks.spawn.mock.calls[0];
    expect(command).toMatch(/\.local\/bin\/emdash-update$/);
    expect(args).toEqual([]);
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(options.env.EMDASH_UPDATE_RELAUNCH_MARKER).toMatch(/emdash-update\/relaunch-requested$/);
    expect(options.env).not.toHaveProperty('NODE_ENV');
    expect(options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(child.unref).toHaveBeenCalled();
  });

  it('reports a concurrent build distinctly', async () => {
    const result = runSelfBuild();
    child.emit('exit', 75, null);
    await expect(result).rejects.toThrow('An update build is already running');
  });

  it('points at the log when the build fails', async () => {
    const result = runSelfBuild();
    child.emit('exit', 1, null);
    await expect(result).rejects.toThrow(/exit 1.*emdash-update\.log/);
  });

  it('reports a script that cannot be started', async () => {
    const result = runSelfBuild();
    child.emit('error', new Error('EACCES'));
    await expect(result).rejects.toThrow(/Could not start .*EACCES/);
  });
});

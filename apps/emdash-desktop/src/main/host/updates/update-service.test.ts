import { EventEmitter } from 'node:events';
import { deferred } from '@emdash/shared/testing';
import { createInProcessWire } from '@emdash/wire/rpc';
import type { UpdateInfo } from 'electron-updater';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updatesContract } from '@core/features/updates/api/contract';
import { createUpdatesWireController } from '@core/features/updates/node/wire-controller';
import { UpdateService } from './update-service';
import { formatUpdaterError } from './utils';

const mocks = vi.hoisted(() => ({ getUpdater: vi.fn() }));
vi.mock('electron-updater', () => ({
  default: {
    get autoUpdater() {
      return mocks.getUpdater();
    },
  },
}));
vi.mock('@main/core/app/utils', () => ({ resolveAppVersion: async () => '1.2.5' }));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const selfBuild = vi.hoisted(() => ({
  isSelfBuildEnabled: vi.fn(() => false),
  runSelfBuild: vi.fn<() => Promise<void>>(),
  quitForSwap: vi.fn(),
  cancelRelaunchRequest: vi.fn(),
}));
vi.mock('./self-build', () => selfBuild);

const info: UpdateInfo = { version: '1.2.6', files: [], path: '', sha512: '', releaseDate: '' };
const updater = Object.assign(new EventEmitter(), {
  checkForUpdatesAndNotify: vi.fn(async () => {
    updater.emit('checking-for-update');
    updater.emit('update-available', info);
    return { updateInfo: info };
  }),
  downloadUpdate: vi.fn<() => Promise<string[]>>(),
  quitAndInstall: vi.fn(),
});
let service: UpdateService;
let transfer: ReturnType<typeof deferred<string[]>>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv('DEV', false);
  updater.removeAllListeners();
  vi.clearAllMocks();
  mocks.getUpdater.mockReturnValue(updater);
  selfBuild.isSelfBuildEnabled.mockReturnValue(false);
  transfer = deferred<string[]>();
  updater.downloadUpdate.mockImplementation(() => transfer.promise);
  service = new UpdateService();
  await service.initialize();
  await service.checkForUpdates();
});
afterEach(() => {
  service.dispose();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('desktop update lifecycle', () => {
  it('acknowledges a download over Wire without waiting for the transfer or its deadline', async () => {
    const wire = createInProcessWire(
      updatesContract,
      createUpdatesWireController({
        checkForUpdates: () => service.checkForUpdates(),
        downloadUpdate: () => service.downloadUpdate(),
        quitAndInstall: () => service.quitAndInstall(),
        openLatestRelease: async () => {},
        getState: () => service.getState(),
        fetchReleaseNotes: async () => null,
        formatError: formatUpdaterError,
      })
    );
    try {
      const result = wire.client.download(undefined);
      const received = vi.fn();
      void result.then(received, received);
      await vi.advanceTimersByTimeAsync(1);
      expect(received).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(service.getState().status).toBe('downloading');
      updater.emit('update-downloaded', info);
      transfer.resolve([]);
      expect(service.getState().status).toBe('downloaded');
    } finally {
      await wire.dispose();
    }
  });

  it('accepts repeated start requests without a second transfer', async () => {
    service.downloadUpdate();
    expect(() => service.downloadUpdate()).not.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    updater.emit('update-downloaded', info);
    transfer.resolve([]);
    expect(() => service.downloadUpdate()).not.toThrow();
    service.quitAndInstall();
    expect(() => service.downloadUpdate()).not.toThrow();
  });

  it('preserves active and ready updates when checks or late check events arrive', async () => {
    service.downloadUpdate();
    await service.checkForUpdates();
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    updater.emit('checking-for-update');
    updater.emit('update-available', { ...info, version: '1.2.7' });
    updater.emit('update-not-available');
    expect(service.getState()).toMatchObject({ status: 'downloading', availableVersion: '1.2.6' });
    updater.emit('update-downloaded', info);
    transfer.resolve([]);
    await service.checkForUpdates();
    expect(service.getState().status).toBe('downloaded');
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
  });

  it('publishes a real transfer failure once and clears it on retry', async () => {
    const publisher = { available: vi.fn(), downloaded: vi.fn(), error: vi.fn() };
    service.setNotificationPublisher(publisher);
    service.downloadUpdate();
    const error = new Error('Connection interrupted');
    updater.emit('error', error);
    transfer.reject(error);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.getState()).toMatchObject({ status: 'error', error: 'Connection interrupted' });
    expect(publisher.error).toHaveBeenCalledTimes(1);
    transfer = deferred<string[]>();
    service.downloadUpdate();
    expect(service.getState()).toMatchObject({
      status: 'downloading',
      error: undefined,
      downloadProgress: undefined,
    });
    updater.emit('update-downloaded', info);
    transfer.resolve([]);
    expect(service.getState().error).toBeUndefined();
  });
});

describe('self-build updates', () => {
  let build: ReturnType<typeof deferred<void>>;

  beforeEach(() => {
    build = deferred<void>();
    selfBuild.isSelfBuildEnabled.mockReturnValue(true);
    selfBuild.runSelfBuild.mockImplementation(() => build.promise);
  });

  async function buildReady(): Promise<void> {
    service.downloadUpdate();
    build.resolve();
    await vi.advanceTimersByTimeAsync(1);
  }

  it('builds from source instead of downloading the release, then offers restart', async () => {
    const publisher = { available: vi.fn(), downloaded: vi.fn(), error: vi.fn() };
    service.setNotificationPublisher(publisher);
    service.downloadUpdate();
    await vi.advanceTimersByTimeAsync(1);
    expect(selfBuild.runSelfBuild).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(service.getState().status).toBe('downloading');
    build.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(service.getState()).toMatchObject({ status: 'downloaded', rollbackVersion: '1.2.5' });
    expect(publisher.downloaded).toHaveBeenCalledWith('1.2.6');
  });

  it('surfaces a failed build as a retryable error', async () => {
    service.downloadUpdate();
    build.reject(new Error('Update build failed (exit 1)'));
    await vi.advanceTimersByTimeAsync(1);
    expect(service.getState()).toMatchObject({
      status: 'error',
      error: 'Update build failed (exit 1)',
    });
    selfBuild.runSelfBuild.mockResolvedValueOnce();
    service.downloadUpdate();
    await vi.advanceTimersByTimeAsync(1);
    expect(selfBuild.runSelfBuild).toHaveBeenCalledTimes(2);
    expect(service.getState().status).toBe('downloaded');
  });

  it('restarts by quitting for the swap instead of running the Squirrel installer', async () => {
    await buildReady();
    service.quitAndInstall();
    expect(service.getState().status).toBe('installing');
    await vi.advanceTimersByTimeAsync(250);
    expect(selfBuild.quitForSwap).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('withdraws the relaunch request when the app does not quit', async () => {
    await buildReady();
    service.quitAndInstall();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(selfBuild.cancelRelaunchRequest).toHaveBeenCalledTimes(1);
    expect(service.getState().status).toBe('downloaded');
  });
});

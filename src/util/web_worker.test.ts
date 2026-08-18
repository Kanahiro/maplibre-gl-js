import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {workerFactory} from './web_worker.ts';
import {config} from './config.ts';
import {WORKER_READY_MESSAGE} from './worker_protocol.ts';

function createWorkerMock(initialEvent: 'ready' | 'error' = 'ready') {
    const listeners = new Map<string, EventListener>();
    const worker = {
        postMessage: vi.fn(),
        addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
        removeEventListener: vi.fn((type: string, listener: EventListener) => {
            if (listeners.get(type) === listener) listeners.delete(type);
        }),
        terminate: vi.fn()
    };

    queueMicrotask(() => {
        if (initialEvent === 'ready') {
            listeners.get('message')?.({data: WORKER_READY_MESSAGE} as MessageEvent);
        } else {
            listeners.get('error')?.({
                message: 'Worker script failed to load'
            } as any);
        }
    });

    return worker;
}

describe('workerFactory', () => {
    const originalWorker = (globalThis as any).Worker;
    const originalWorkerUrl = config.WORKER_URL;

    beforeEach(() => {
        config.WORKER_URL = '';
    });

    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        config.WORKER_URL = originalWorkerUrl;
        vi.restoreAllMocks();
    });

    test('creates a module worker when WORKER_URL is empty', async () => {
        const WorkerSpy = vi.fn(function() { return createWorkerMock(); });
        (globalThis as any).Worker = WorkerSpy;

        await workerFactory();

        expect(WorkerSpy).toHaveBeenCalledTimes(1);
        expect(WorkerSpy.mock.calls[0]).toEqual(['', {type: 'module'}]);
    });

    test('creates a classic worker when WORKER_URL ends with .cjs', async () => {
        const WorkerSpy = vi.fn(function() { return createWorkerMock(); });
        (globalThis as any).Worker = WorkerSpy;
        config.WORKER_URL = '/path/to/worker.cjs';

        await workerFactory();

        expect(WorkerSpy).toHaveBeenCalledTimes(1);
        expect(WorkerSpy.mock.calls[0]).toEqual(['/path/to/worker.cjs']);
    });

    test('creates a module worker when WORKER_URL ends with .mjs', async () => {
        const WorkerSpy = vi.fn(function() { return createWorkerMock(); });
        (globalThis as any).Worker = WorkerSpy;
        config.WORKER_URL = '/path/to/worker.mjs';

        await workerFactory();

        expect(WorkerSpy).toHaveBeenCalledTimes(1);
        expect(WorkerSpy.mock.calls[0]).toEqual(['/path/to/worker.mjs', {type: 'module'}]);
    });

    test('falls back to classic worker if module worker construction throws', async () => {
        let workerConstructionCount = 0;
        const WorkerSpy = vi.fn(function() {
            if (workerConstructionCount++ === 0) throw new Error('module workers not supported');
            return createWorkerMock();
        });
        (globalThis as any).Worker = WorkerSpy;
        config.WORKER_URL = '/path/to/worker.mjs';

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await workerFactory();

        expect(WorkerSpy).toHaveBeenCalledTimes(2);
        expect(WorkerSpy.mock.calls[0]).toEqual(['/path/to/worker.mjs', {type: 'module'}]);
        expect(WorkerSpy.mock.calls[1]).toEqual(['/path/to/worker.mjs']);
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Module worker not supported'),
            expect.any(Error)
        );
    });

    test('cross-origin module worker URL is converted to an import script and the worker is constructed from a Blob URL', async () => {
        const WorkerSpy = vi.fn(function() { return createWorkerMock(); });
        (globalThis as any).Worker = WorkerSpy;

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            text: () => Promise.resolve('// worker code'),
        } as any);
        const BlobSpy = vi.spyOn(globalThis, 'Blob');
        const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/abc');
        const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

        config.WORKER_URL = 'https://unpkg.com/maplibre-gl/dist/maplibre-gl-worker.mjs';

        await workerFactory();

        expect(fetchSpy).toHaveBeenCalledTimes(0);
        expect(BlobSpy).toHaveBeenCalledWith(['import "https://unpkg.com/maplibre-gl/dist/maplibre-gl-worker.mjs"'], {type: 'text/javascript'});
        expect(createObjectURLSpy).toHaveBeenCalled();
        expect(WorkerSpy).toHaveBeenCalledTimes(1);
        expect(WorkerSpy.mock.calls[0]).toEqual(['blob:http://localhost/abc', {type: 'module'}]);
        expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/abc');
    });

    test('cross-origin classic worker URL is fetched and the worker is constructed from a Blob URL', async () => {
        const WorkerSpy = vi.fn(function() { return createWorkerMock(); });
        (globalThis as any).Worker = WorkerSpy;

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            text: () => Promise.resolve('// worker code'),
        } as any);
        const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/abc');
        const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

        config.WORKER_URL = 'https://unpkg.com/maplibre-gl/dist/maplibre-gl-worker.cjs';

        await workerFactory();

        expect(fetchSpy).toHaveBeenCalledWith('https://unpkg.com/maplibre-gl/dist/maplibre-gl-worker.cjs');
        expect(createObjectURLSpy).toHaveBeenCalled();
        expect(WorkerSpy).toHaveBeenCalledTimes(1);
        expect(WorkerSpy.mock.calls[0]).toEqual(['blob:http://localhost/abc']);
        expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/abc');
    });

    test('cross-origin fetch failure rejects the promise', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({ok: false, status: 404} as any);
        config.WORKER_URL = 'https://unpkg.com/maplibre-gl/dist/maplibre-gl-worker.cjs';

        await expect(workerFactory()).rejects.toThrow('Failed to fetch worker script (404)');
    });

    test('rejects and terminates the worker when its script fails to initialize', async () => {
        const worker = createWorkerMock('error');
        (globalThis as any).Worker = vi.fn(function() { return worker; });
        config.WORKER_URL = '/invalid-worker.mjs';

        await expect(workerFactory()).rejects.toThrow(
            'Failed to initialize MapLibre worker from "/invalid-worker.mjs": Worker script failed to load'
        );
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });
});

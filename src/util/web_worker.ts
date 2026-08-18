import {type AddProtocolAction, config} from './config.ts';
import type {default as MaplibreWorker} from '../source/worker.ts';
import type {WorkerSourceConstructor} from '../source/worker_source.ts';
import type {GetResourceResponse, RequestParameters} from './ajax.ts';
import {WORKER_READY_MESSAGE} from './worker_protocol.ts';

export interface WorkerGlobalScopeInterface {
    registerWorkerSource: (sourceName: string, sourceConstructor: WorkerSourceConstructor) => void;
    registerRTLTextPlugin: (_: any) => void;
    addProtocol: (customProtocol: string, loadFn: AddProtocolAction) => void;
    removeProtocol: (customProtocol: string) => void;
    makeRequest: (request: RequestParameters, abortController: AbortController) => Promise<GetResourceResponse<any>>;
    worker: MaplibreWorker;
}

function isCrossOrigin(url: string): boolean {
    if (!url) return false;
    const loc = (globalThis as any).location;
    if (!loc) return false;
    try {
        return new URL(url, loc.href).origin !== loc.origin;
    } catch {
        return false;
    }
}

function defaultWorkerUrl(): string {
    const moduleUrl = import.meta.url;
    if (!/^https?:/.test(moduleUrl)) return '';
    const workerName = moduleUrl.endsWith('-dev.mjs')
        ? 'maplibre-gl-worker-dev.mjs'
        : 'maplibre-gl-worker.mjs';
    return new URL(`./${workerName}`, moduleUrl).href;
}

function createWorker(url: string, asModule: boolean): Worker {
    if (asModule) {
        try {
            return new Worker(url, {type: 'module'});
        } catch (e) {
            console.warn('Module worker not supported, falling back to classic worker', e);
        }
    }
    return new Worker(url);
}

function waitForWorkerReady(worker: Worker, url: string): Promise<Worker> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
        };
        const onMessage = (event: MessageEvent) => {
            if (event.data !== WORKER_READY_MESSAGE) return;
            cleanup();
            resolve(worker);
        };
        const onError = (event: ErrorEvent) => {
            cleanup();
            worker.terminate();
            const details = event.message ? `: ${event.message}` : '';
            reject(new Error(`Failed to initialize MapLibre worker from ${JSON.stringify(url)}${details}`));
        };

        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
    });
}

async function fetchAsBlobUrl(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch worker script (${response.status}): ${url}`);
    }
    const code = await response.text();
    const blob = new Blob([code], {type: 'text/javascript'});
    return URL.createObjectURL(blob);
}

function importAsBlobUrl(url: string): string {
    const blob = new Blob([`import ${JSON.stringify(new URL(url, import.meta.url).href)}`], {type: 'text/javascript'});
    return URL.createObjectURL(blob);
}

export async function workerFactory(): Promise<Worker> {
    const url = config.WORKER_URL || defaultWorkerUrl();
    const asModule = url?.endsWith('.cjs') ? false : true;

    if (!isCrossOrigin(url)) {
        return waitForWorkerReady(createWorker(url, asModule), url);
    }

    if (asModule) {
        const blobUrl = importAsBlobUrl(url);
        try {
            return await waitForWorkerReady(createWorker(blobUrl, asModule), url);
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    }

    const blobUrl = await fetchAsBlobUrl(url);
    try {
        return await waitForWorkerReady(createWorker(blobUrl, asModule), url);
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}

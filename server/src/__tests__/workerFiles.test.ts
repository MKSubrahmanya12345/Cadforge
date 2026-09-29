import { describe, expect, test } from 'bun:test';
import { isWorkerLocal, workerBaseUrl, workerFileUrl, WorkerError } from '../worker.js';
import { env } from '../env.js';

function withWorkerUrl<T>(url: string | undefined, fn: () => T): T {
  const previous = process.env['CAD_WORKER_URL'];
  if (url === undefined) delete process.env['CAD_WORKER_URL'];
  else process.env['CAD_WORKER_URL'] = url;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env['CAD_WORKER_URL'];
    else process.env['CAD_WORKER_URL'] = previous;
  }
}

describe('worker base url', () => {
  test('a trailing slash is normalised away', () => {
    expect(withWorkerUrl('http://127.0.0.1:8000/', () => workerBaseUrl())).toBe(
      'http://127.0.0.1:8000',
    );
  });

  test('the process env wins over the frozen config', () => {
    expect(withWorkerUrl('http://example.test:9000', () => workerBaseUrl())).toBe(
      'http://example.test:9000',
    );
  });

  test('it falls back to .env when the process env is unset', () => {
    withWorkerUrl(undefined, () => {
      expect(workerBaseUrl()).toBe(env.CAD_WORKER_URL.replace(/\/$/, ''));
    });
  });
});

describe('isWorkerLocal decides who serves /files', () => {
  test('loopback addresses are local', () => {
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '[::1]']) {
      const url = host === '[::1]' ? 'http://[::1]:8000' : `http://${host}:8000`;
      expect(withWorkerUrl(url, () => isWorkerLocal())).toBe(true);
    }
  });

  test('a remote host is not local, so the server proxies the worker', () => {
    for (const url of [
      'https://cadforge-worker.onrender.com',
      'http://10.0.0.5:8000',
      'https://worker.internal.example',
    ]) {
      expect(withWorkerUrl(url, () => isWorkerLocal())).toBe(false);
    }
  });

  test('a sibling container reached by hostname is treated as remote', () => {
    // The bytes live in that container's filesystem, not this one's, so serving
    // them from local disk would 404. Proxying always works.
    expect(withWorkerUrl('http://cadforge-worker:8000', () => isWorkerLocal())).toBe(false);
  });

  test('a malformed URL is assumed local rather than crashing startup', () => {
    expect(withWorkerUrl('not a url', () => isWorkerLocal())).toBe(true);
  });
});

describe('workerFileUrl', () => {
  test('builds a files URL from a relative path', () => {
    const url = withWorkerUrl('http://127.0.0.1:8000', () =>
      workerFileUrl('abc123/assembly.glb'),
    );
    expect(url).toBe('http://127.0.0.1:8000/files/abc123/assembly.glb');
  });

  test('normalises backslashes and leading slashes', () => {
    expect(withWorkerUrl('http://127.0.0.1:8000', () => workerFileUrl('/abc/parts\\led.step'))).toBe(
      'http://127.0.0.1:8000/files/abc/parts/led.step',
    );
  });

  test('percent-encodes each segment so spaces and hashes are safe', () => {
    const url = withWorkerUrl('http://127.0.0.1:8000', () =>
      workerFileUrl('my project/assembly.FCStd'),
    );
    expect(url).toBe('http://127.0.0.1:8000/files/my%20project/assembly.FCStd');
  });

  test('refuses a traversing path', () => {
    expect(() =>
      withWorkerUrl('http://127.0.0.1:8000', () => workerFileUrl('../../etc/passwd')),
    ).toThrow(WorkerError);
  });

  test('refuses an embedded traversal even after normalisation', () => {
    expect(() =>
      withWorkerUrl('http://127.0.0.1:8000', () => workerFileUrl('abc/../../secrets')),
    ).toThrow(/traversing/);
  });

  test('a legitimate nested path is allowed', () => {
    expect(() =>
      withWorkerUrl('http://127.0.0.1:8000', () => workerFileUrl('abc/parts/led_5mm_1.glb')),
    ).not.toThrow();
  });

  test('a project id that is itself dotty is still caught', () => {
    // "a/.." normalises to "a", but a leading ".." never survives.
    expect(() => withWorkerUrl('http://x.test', () => workerFileUrl('..%2Fsecret'))).toThrow();
  });
});

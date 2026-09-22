import type { ElkNode } from 'elkjs/lib/elk-api';

/**
 * Resolving the ELK constructor across module systems.
 *
 * `elk.bundled.js` is a UMD build. Depending on the bundler and whether the
 * importer is the app or a worker, `import ELK from 'elkjs/lib/elk.bundled.js'`
 * yields either the constructor or a namespace object wrapping it — and the
 * two disagree between the dev server and a production build, so the mistake
 * only shows up once bundled. Getting it wrong throws
 * "X is not a constructor" at module scope, which kills a worker before it can
 * report anything useful.
 */

export interface ElkInstance {
  layout(root: ElkNode): Promise<ElkNode>;
}

/** `elk-api` takes options; the bundled build takes none. */
export interface ElkOptions {
  workerUrl?: string;
  workerFactory?: (url: string) => Worker;
}

export type ElkConstructor = new (options?: ElkOptions) => ElkInstance;

export function resolveElk(imported: unknown): ElkConstructor {
  const candidate =
    typeof imported === 'function'
      ? imported
      : (imported as { default?: unknown } | null)?.default;

  if (typeof candidate !== 'function') {
    throw new TypeError('elkjs did not export a constructor');
  }
  return candidate as ElkConstructor;
}

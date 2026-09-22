import { describe, expect, it } from 'vitest';
import { resolveElk } from './elk-interop';

describe('resolveElk', () => {
  class Fake {
    layout() {
      return Promise.resolve({ id: 'root' });
    }
  }

  it('accepts a bare constructor', () => {
    expect(resolveElk(Fake)).toBe(Fake);
  });

  it('unwraps a namespace that carries the constructor as default', () => {
    // What a bundled UMD import looks like from inside a worker chunk.
    expect(resolveElk({ default: Fake })).toBe(Fake);
  });

  it('throws a named error instead of "X is not a constructor"', () => {
    // The real failure was thrown at worker module scope, which kills the
    // worker before it can report why. A clear message is the difference
    // between a silent main-thread fallback and a diagnosable one.
    expect(() => resolveElk({ notIt: 1 })).toThrow(/did not export a constructor/);
    expect(() => resolveElk(null)).toThrow(/did not export a constructor/);
    expect(() => resolveElk(undefined)).toThrow(/did not export a constructor/);
  });

  it('constructs something layout-shaped', async () => {
    const Ctor = resolveElk({ default: Fake });
    await expect(new Ctor().layout({ id: 'root' })).resolves.toBeTruthy();
  });
});

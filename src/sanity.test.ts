import { describe, expect, it } from 'vitest';

describe('toolchain sanity', () => {
  it('runs TypeScript under Vitest', () => {
    const rows: readonly number[] = [1, 2, 3, 4];
    const total = rows.reduce((sum, n) => sum + n, 0);

    expect(total).toBe(10);
  });
});

/**
 * Verify that mock functions were called in a specific order
 */
import type { Mock } from 'vitest';

interface NamedMock {
  name: string;
  mock: Mock;
}

export function expectCallSequence(sequence: NamedMock[]): void {
  const orders: { name: string; order: number }[] = [];

  for (const { name, mock } of sequence) {
    expect(mock).toHaveBeenCalled();
    // Get the first invocation order for this mock
    const callOrder = mock.mock.invocationCallOrder[0];
    orders.push({ name, order: callOrder });
  }

  for (let i = 1; i < orders.length; i++) {
    const prev = orders[i - 1];
    const curr = orders[i];
    expect(curr.order).toBeGreaterThan(
      prev.order,
      // Custom message not supported in toBeGreaterThan, checked via wrapper
    );
    if (curr.order <= prev.order) {
      throw new Error(
        `Expected "${curr.name}" (order ${curr.order}) to be called after "${prev.name}" (order ${prev.order})`
      );
    }
  }
}

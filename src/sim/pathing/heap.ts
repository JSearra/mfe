/**
 * Binary min-heap over integer node indices, keyed by an integer priority.
 *
 * Ordering is a total order over (primary, secondary, node index), deliberately. A
 * heap's behaviour on equal keys is otherwise an implementation detail, and A*
 * open-list ties are one of the five classic sources of lockstep desync — two clients
 * expand the same frontier in a different order and produce different paths. A* passes
 * f as primary and h as secondary, which also happens to be the standard tie-break that
 * prefers nodes nearer the goal. See ARCHITECTURE section 1.
 */
export interface IntHeap {
  size: number;
  clear(): void;
  push(node: number, priority: number, secondary?: number): void;
  /** Returns the lowest-priority node, or -1 when empty. */
  pop(): number;
}

export function createIntHeap(capacity: number): IntHeap {
  let nodes = new Int32Array(capacity);
  let priorities = new Int32Array(capacity);
  let secondaries = new Int32Array(capacity);
  let size = 0;

  function grow(): void {
    const bigger = new Int32Array(nodes.length * 2);
    bigger.set(nodes);
    nodes = bigger;
    const biggerPriorities = new Int32Array(priorities.length * 2);
    biggerPriorities.set(priorities);
    priorities = biggerPriorities;
    const biggerSecondaries = new Int32Array(secondaries.length * 2);
    biggerSecondaries.set(secondaries);
    secondaries = biggerSecondaries;
  }

  /** Total order: primary, then secondary, then node index. */
  function before(a: number, b: number): boolean {
    if (priorities[a] !== priorities[b]) return priorities[a]! < priorities[b]!;
    if (secondaries[a] !== secondaries[b]) return secondaries[a]! < secondaries[b]!;
    return nodes[a]! < nodes[b]!;
  }

  function swap(a: number, b: number): void {
    const node = nodes[a]!;
    nodes[a] = nodes[b]!;
    nodes[b] = node;
    const priority = priorities[a]!;
    priorities[a] = priorities[b]!;
    priorities[b] = priority;
    const secondary = secondaries[a]!;
    secondaries[a] = secondaries[b]!;
    secondaries[b] = secondary;
  }

  const heap: IntHeap = {
    get size(): number {
      return size;
    },
    set size(value: number) {
      size = value;
    },

    clear(): void {
      size = 0;
    },

    push(node: number, priority: number, secondary = 0): void {
      if (size === nodes.length) grow();
      nodes[size] = node;
      priorities[size] = priority;
      secondaries[size] = secondary;

      let child = size++;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (!before(child, parent)) break;
        swap(child, parent);
        child = parent;
      }
    },

    pop(): number {
      if (size === 0) return -1;
      const top = nodes[0]!;

      size--;
      if (size > 0) {
        nodes[0] = nodes[size]!;
        priorities[0] = priorities[size]!;
        secondaries[0] = secondaries[size]!;

        let parent = 0;
        for (;;) {
          const left = parent * 2 + 1;
          if (left >= size) break;
          const right = left + 1;
          const best = right < size && before(right, left) ? right : left;
          if (!before(best, parent)) break;
          swap(best, parent);
          parent = best;
        }
      }
      return top;
    },
  };

  return heap;
}

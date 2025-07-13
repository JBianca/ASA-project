// ─────────────────────────────────────────────────────────────────────────────
// PRIORITY QUEUE (MIN‑HEAP) FOR A*
// ─────────────────────────────────────────────────────────────────────────────
class PriorityQueue {
  constructor() { this.heap = []; }

  parent(i) { return Math.floor((i - 1) / 2); }
  left(i)   { return 2 * i + 1; }
  right(i)  { return 2 * i + 2; }
  swap(i, j){ [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]]; }

  insert(node, priority) {
    this.heap.push({ node, priority });
    this._bubbleUp(this.heap.length - 1);
  }
  _bubbleUp(i) {
    while (i > 0) {
      const p = this.parent(i);
      if (this.heap[i].priority < this.heap[p].priority) {
        this.swap(i, p);
        i = p;
      } else break;
    }
  }

  extractMin() {
    if (this.heap.length === 0) return null;
    const min = this.heap[0].node;
    const last = this.heap.pop();
    if (this.heap.length) {
      this.heap[0] = last;
      this._bubbleDown(0);
    }
    return min;
  }
  _bubbleDown(i) {
    while (true) {
      const l = this.left(i), r = this.right(i);
      let smallest = i;
      if (l < this.heap.length && this.heap[l].priority < this.heap[smallest].priority) smallest = l;
      if (r < this.heap.length && this.heap[r].priority < this.heap[smallest].priority) smallest = r;
      if (smallest !== i) {
        this.swap(i, smallest);
        i = smallest;
      } else break;
    }
  }

  isEmpty() {
    return this.heap.length === 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A* DAEMON
// ─────────────────────────────────────────────────────────────────────────────
const key = node => `${node.x},${node.y}`;

function reconstruct_path(cameFrom, current) {
  const path = [current];
  while (cameFrom.has(key(current))) {
    current = cameFrom.get(key(current));
    path.unshift(current);
  }
  return path;
}

class AStarDaemon {
  constructor(mapTiles) {
    this.map = mapTiles;
  }
  /**
   * @param {{x,y}} start 
   * @param {{x,y}} goal 
   * @param {fn({x,y}):number} h 
   * @returns {Array<{x,y,action}>|string}
   */
  aStar(start, goal, h) {
    // quick OOB check
    if (!this.map.has(key(start)) || !this.map.has(key(goal))) return "failure";

    const openSet = new PriorityQueue();
    const cameFrom = new Map();
    const gScore   = new Map();
    const fScore   = new Map();

    gScore.set(key(start), 0);
    fScore.set(key(start), h(start));
    openSet.insert(start, fScore.get(key(start)));

    while (!openSet.isEmpty()) {
      const current = openSet.extractMin();
      if (h(current) === 0) {
        // reached goal
        const nodePath = reconstruct_path(cameFrom, current);
        // annotate actions
        const withActions = [];
        for (let i = 1; i < nodePath.length; i++) {
          const prev = nodePath[i - 1], nxt = nodePath[i];
          let action = null;
          if (nxt.x > prev.x) action = 'right';
          else if (nxt.x < prev.x) action = 'left';
          else if (nxt.y > prev.y) action = 'up';
          else if (nxt.y < prev.y) action = 'down';
          withActions.push({ x: nxt.x, y: nxt.y, action });
        }
        return withActions;
      }

      const [cx, cy] = [current.x, current.y];
      // four neighbors
      const neighbors = [
        { x: cx + 1, y: cy, action: 'right' },
        { x: cx - 1, y: cy, action: 'left'  },
        { x: cx, y: cy + 1, action: 'up'    },
        { x: cx, y: cy - 1, action: 'down'  },
      ];

      for (const nb of neighbors) {
        const k    = key(nb);
        const tile = this.map.get(k);
      
        // skip OOB, walls, or occupied tiles
        if (!tile || tile.type === 0 || tile.locked) {
          continue;
        }
      
        const tentative_g = (gScore.get(key(current)) ?? Infinity) + 1;
        if (tentative_g < (gScore.get(k) ?? Infinity)) {
          cameFrom.set(k, current);
          gScore.set(k, tentative_g);
          const f = tentative_g + h(nb);
          fScore.set(k, f);
          openSet.insert({ x: nb.x, y: nb.y }, f);
        }
      }
    }

    return "failure";
  }
}

export default AStarDaemon;
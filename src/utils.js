export const SECTOR_SIZE = 5;
export const sectorLastVisit = new Map(); // "sx,sy" → timestamp

/**
 * Manhattan distance between two grid points.
 */
export function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
  const dx = Math.abs(Math.round(x1) - Math.round(x2));
  const dy = Math.abs(Math.round(y1) - Math.round(y2));
  return dx + dy;
}

/**
 * Given a position and an array of delivery zones, find the closest zone.
 */
export function nearestDelivery(pos, deliveryZones, distanceFn) {
  return deliveryZones.reduce((a, b) =>
    distanceFn(pos, a) < distanceFn(pos, b) ? a : b
  );
}

/**
 * Generate all permutations of the given array.
 * @template T
 * @param {T[]} array
 * @returns {T[][]} an array of all orderings (permutations) of `array`
 */
export function permutations(array) {
    if (array.length <= 1) {
      return [array.slice()];  // single permutation: itself
    }
  
    const result = [];
    for (let i = 0; i < array.length; i++) {
      // take element i out
      const elem = array[i];
      const rest = array.slice(0, i).concat(array.slice(i + 1));
  
      // permute the rest
      for (const perm of permutations(rest)) {
        result.push([elem, ...perm]);
      }
    }
    return result;
  }

  /**
 * Generate all k‑element subsets (combinations) of the given array.
 *
 * @template T
 * @param {T[]} array   — input array
 * @param {number} k    — size of each combination
 * @returns {T[][]}     — list of all combinations (order of elements inside each combo matches the input order)
 */
export function combinations(array, k) {
    if (k === 0) {
      return [[]];
    }
    if (array.length < k) {
      return [];
    }
    if (array.length === k) {
      return [array.slice()];
    }
  
    const [head, ...rest] = array;
  
    // 1) Combinations that include the head
    const withHead = combinations(rest, k - 1).map(sub =>
      [head, ...sub]
    );
  
    // 2) Combinations that exclude the head
    const withoutHead = combinations(rest, k);
  
    return withHead.concat(withoutHead);
  }
  
  export function markSector(x, y) {
    const sx = Math.floor(x / SECTOR_SIZE);
    const sy = Math.floor(y / SECTOR_SIZE);
    sectorLastVisit.set(`${sx},${sy}`, Date.now());
  }
  
  export function pickOldestSector(mapTiles) {
    // 1) Scan every walkable tile and ensure its sector has an entry
    const tile1Sectors = new Set();
    for (const key of mapTiles.keys()) {
      const [x, y] = key.split(',').map(Number);
      const tile = mapTiles.get(key);
      if (tile.type === 1) {
        const sx = Math.floor(x / SECTOR_SIZE);
        const sy = Math.floor(y / SECTOR_SIZE);
        tile1Sectors.add(`${sx},${sy}`);
      }
    }

    // 2) Find the sector with the oldest timestamp *among tile1 sectors*
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const sk of tile1Sectors) {
      const ts = sectorLastVisit.get(sk) ?? 0;
      if (ts < oldestTime) {
        oldestTime = ts;
        oldestKey = sk;
      }
    }

    return oldestKey.split(',').map(Number);
  }
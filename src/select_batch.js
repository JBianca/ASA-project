import { combinations, distance } from './utils.js';
import { permutations } from './utils.js';

/**
 * Returns { batch: [p1,p2,...], order: [p1,p2,...], netUtil } for the best run.
 */
function selectOptimalBatch(
  parcels,        // Array of visible parcels
  start,          // {x,y}
  deliveryZones,  // Array of {x,y}
  aStar,          
  PENALTY,
  decayIntervalS,
  maxK = 3
) {
  let bestRun = { netUtil: -Infinity, route: null };

  // Precompute distances between every pair (+ start + zones)
  const points = [start, ...parcels];
  const dist = {};
  for (let i = 0; i < points.length; i++) {
    for (let j = 0; j < parcels.length; j++) {
      const a = points[i], b = parcels[j];
      const key = `${i}-${b.id}`;
      dist[key] = aStar.aStar(a, b, n=>distance(n, b)).length;
    }
  }
  // and start/delivery + parcel/delivery distances
  const deliveryDist = {};
  for (const p of parcels) {
    deliveryDist[p.id] = Math.min(
      ...deliveryZones.map(z => aStar.aStar(p, z, n=>distance(n,z)).length)
    );
  }

  // Utility of single‑parcel runs (also counts as subset of size 1)
  for (const p of parcels) {
    const d1 = dist[`0-${p.id}`];         // start→p
    const d2 = deliveryDist[p.id];        // p→deliver
    const net = p.expectedUtility - PENALTY*((d1+d2)/decayIntervalS);
    if (net > bestRun.netUtil) {
      bestRun = { netUtil: net, route: [p], order: [p] };
    }
  }

  // Now check all subsets of size 2..maxK
  const ids = parcels.map(p => p.id);
  for (let k = 2; k <= maxK; k++) {
    for (const subsetIds of combinations(ids, k)) {
      const subset = subsetIds.map(id => parcels.find(p=>p.id===id));
      // all possible visit orders
      for (const perm of permutations(subset)) {
        // compute total decay‑weighted travel cost
        let travelCost = 0;
        let carried = 0;
        let curr = start;

        // 1) pickup legs
        for (const p of perm) {
          const stepDist = aStar.aStar(curr, p, n=>distance(n,p)).length;
          carried++;
          travelCost += stepDist * carried;
          curr = p;
        }
        // 2) final delivery leg
        const d2 = Math.min(...deliveryZones.map(z=>
          aStar.aStar(curr, z, n=>distance(n,z)).length
        ));
        travelCost += d2 * carried;

        const rewardSum = perm.reduce((s,p)=>s+p.expectedUtility, 0);
        const net = rewardSum - PENALTY*(travelCost/decayIntervalS);
        if (net > bestRun.netUtil) {
          bestRun = { netUtil: net, route: perm };
        }
      }
    }
  }

  return bestRun;
}

export default selectOptimalBatch
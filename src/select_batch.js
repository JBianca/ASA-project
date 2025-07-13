import { combinations, permutations, distance } from './utils.js';

/**
 * Greedy approximation strategy to select the most valuable batch of parcels.
 * 
 * The algorithm incrementally selects parcels that maximize utility, defined as:
 *   expectedUtility - decayPenalty (based on travel cost).
 */
function selectOptimalBatchGreedy(
  parcels,
  start,
  deliveryZones,
  aStar,
  PENALTY,
  decayIntervalS,
  maxK = 20
) {
  const available = [...parcels];  
  const selected = [];            

  // Precompute delivery distance for each parcel
  const parcelToDeliveryDist = new Map();
  for (const p of available) {
    let bestToZone = Infinity;
    for (const z of deliveryZones) {
      const dist = aStar.aStar(p, z, n => distance(n, z)).length;
      if (dist < bestToZone) bestToZone = dist;
    }
    parcelToDeliveryDist.set(p.id, bestToZone);
  }

  // Initialize loop variables
  let curr = start;       // Current position in the route
  let carried = 0;        // Number of parcels already selected
  let travelCost = 0;     // Total travel time (weighted by load)
  let totalUtility = 0;   // Accumulated reward

  // Greedily select parcels to maximize net utility 
  while (carried < maxK && available.length > 0) {
    let bestParcel = null;
    let bestNetUtil = -Infinity;
    let distToBest = 0;

    for (const p of available) {
      // Compute travel cost to parcel (multiplied by carried+1)
      const toParcel = aStar.aStar(curr, p, n => distance(n, p)).length;
      const stepCost = toParcel * (carried + 1);

      const estimatedTravel = travelCost + stepCost;
      const netUtil = p.expectedUtility - PENALTY * (estimatedTravel / decayIntervalS);

      // Keep parcel if it's better than any seen before
      if (netUtil > bestNetUtil) {
        bestParcel = p;
        bestNetUtil = netUtil;
        distToBest = toParcel;
      }
    }

    // No suitable parcel found (e.g., all net utility negative)
    if (!bestParcel) break;

    // Add selected parcel to the route
    selected.push(bestParcel);
    totalUtility += bestParcel.expectedUtility;
    travelCost += distToBest * (carried + 1); // Time penalty increases with load
    curr = bestParcel;
    carried++;

    // Remove parcel from availability list
    available.splice(available.findIndex(p => p.id === bestParcel.id), 1);
  }

  // Add final leg to nearest delivery zone
  const finalLeg = Math.min(...deliveryZones.map(z =>
    aStar.aStar(curr, z, n => distance(n, z)).length
  ));
  travelCost += finalLeg * carried;

  // Return total net utility and selected parcel route 
  const netUtil = totalUtility - PENALTY * (travelCost / decayIntervalS);
  return { netUtil, route: selected, order: selected };
}

/**
 * Returns { batch: [p1,p2,...], order: [p1,p2,...], netUtil } for the best run.
 */
function selectOptimalBatchExact(
  parcels,        // Array of visible parcels
  start,          // {x,y}
  deliveryZones,  // Array of {x,y}
  aStar,          
  PENALTY,
  decayIntervalS,
  maxK = 3
) {
  // console.log('[select_batch] Using EXACT (combinatorial) batch selection');
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

/**
 * Hybrid strategy: exact if maxK ≤ threshold, else greedy
 */
function selectOptimalBatchHybrid(
  parcels,
  start,
  deliveryZones,
  aStar,
  PENALTY,
  decayIntervalS,
  maxK = 3,
  exactThreshold = 3
) {
  if (maxK <= exactThreshold) {
    return selectOptimalBatchExact(
      parcels, start, deliveryZones, aStar, PENALTY, decayIntervalS, maxK
    );
  } else {
    return selectOptimalBatchGreedy(
      parcels, start, deliveryZones, aStar, PENALTY, decayIntervalS, maxK
    );
  }
}

export default selectOptimalBatchHybrid;
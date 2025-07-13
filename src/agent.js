import { DeliverooApi, ioClientSocket } from "@unitn-asa/deliveroo-js-client";
import AStarDaemon from "./astar_daemon_single.js";
import { distance, pickOldestSector, markSector, SECTOR_SIZE } from './utils.js';
import selectOptimalBatch from "./select_batch.js";
import { 
  state,
  config,
  CONTEST_RADIUS,
  CONTEST_PENALTY,
  MAX_SECTORS_TO_TRY,
  MAX_TILES_PER_SECTOR,
  SCOUT_STEPS
} from './state.js';
import { GoPickUp, GoDeliver, Patrolling, AstarMove, BulkCollect, aStarDaemon } from "./plans.js";
import { IntentionRevisionReplace } from './intentions.js';

const {
  me, parcels, deliveryZones, mapTiles, agents, 
  suspendedDeliveries
} = state
const client = new DeliverooApi(
  config.host,
  config.token
);

let PENALTY;
let DECAY_INTERVAL_MS;

client.onConfig(cfg => {
  PENALTY = cfg.PENALTY;
  DECAY_INTERVAL_MS = parseInt(cfg.PARCEL_DECADING_INTERVAL) * 1000;
});

client.onYou(({id, name, x, y, score}) => {
    me.id = id;
    me.name = name;
    me.x = x;
    me.y = y;
    me.score = score;
});

client.onParcelsSensing(pp => {
  const now     = Date.now();
  const seenIds = new Set(pp.map(p => p.id));

  // 1) Update or insert every parcel you currently see
  for (const p of pp) {
    const old = parcels.get(p.id);

    // A) some other agent stole it?
    if (old && p.carriedBy && p.carriedBy !== me.id) {
      parcels.delete(p.id);
      continue;
    }

    // anybody else strictly closer (or tie) to this parcel?
    const rivals = [...agents.values()]
      .filter(a => a.id !== me.id);
    const contested = rivals.some(a =>
      distance(a, p) <= distance(me, p)
    );

    const expectedUtility = contested
      ? p.reward * (1 - CONTEST_PENALTY)
      : p.reward;

    // Otherwise upsert with stamps
    const spawnTime     = old ? old.spawnTime     : now;
    const initialReward = old ? old.initialReward : p.reward;

    parcels.set(p.id, {
      ...p,
      lastSeen:      now,
      spawnTime,
      initialReward,
      expectedUtility
    });
  }

  // 2) Now expire truly gone parcels:
  for (const [id, p] of parcels) {

    // A) stolen by other agent?
    if (p.carriedBy && p.carriedBy !== me.id) {
      parcels.delete(id);
      continue;
    }

    // B) _you_ delivered it?  i.e. you were carrying it, now you no longer see it
    if (p.carriedBy === me.id && !seenIds.has(id)) {
      // you just dropped it → clear both from parcels _and_ any suspension
      suspendedDeliveries.delete(id);
      parcels.delete(id);
      continue;
    }

    // C) fully decayed?
    if (p.reward <= 0) {
      parcels.delete(id);
      continue;
    }

    // D) exceeded true lifetime?
    const maxLifetime = p.initialReward * DECAY_INTERVAL_MS;
    if (now - p.spawnTime > maxLifetime) {
      parcels.delete(id);
      continue;
    }
  }

  for (const id of Array.from(suspendedDeliveries)) {
    if (!parcels.has(id)) {
      // it was delivered, stolen, or decayed away
      suspendedDeliveries.delete(id);
      console.log('[unsuspend]', id);
    }
  }
});

client.onMap((width, height, tiles) => {
  deliveryZones.length = 0;

  for (const tile of tiles) {
    if (tile.type === 2) {
      deliveryZones.push({ x: tile.x, y: tile.y });
    }
  }
});

client.onTile(tile => {
  if (tile.type === 2) {
    deliveryZones.push({ x: tile.x, y: tile.y });
  }
  else {
    for (let i = deliveryZones.length - 1; i >= 0; i--) {
      if (deliveryZones[i].x === tile.x && deliveryZones[i].y === tile.y) {
        deliveryZones.splice(i, 1);
      }
    }
  }
});

client.onMap((width, height, tiles) => {
  mapTiles.clear();
  for (const t of tiles) {
    // store an object, with both type and locked flag
    mapTiles.set(
      `${t.x},${t.y}`,
      { type: t.type, locked: false }
    );
  }
});

// When a single tile updates:
client.onTile(tile => {
  const key = `${tile.x},${tile.y}`;
  const entry = mapTiles.get(key);
  if (entry) {
    entry.type = tile.type;
  }
});

client.onAgentsSensing(sensedAgents => {
  for (const a of sensedAgents) {
    agents.set(a.id, { id: a.id, x: a.x, y: a.y, score: a.score });
  }

  const seenIds = new Set(sensedAgents.map(a => a.id));
  for (const id of agents.keys()) {
    if (!seenIds.has(id)) {
      agents.delete(id);
    }
  }

  // 2a) clear ALL old locks:
  for (const entry of mapTiles.values()) {
    entry.locked = false;
  }

  // 2b) lock the tiles under each sensed agent:
  for (const a of sensedAgents) {
    const key = `${a.x},${a.y}`;
    const tile = mapTiles.get(key);
    if (tile) tile.locked = true;
  }

  // 3) mark every parcel.p.contested = true if some other agent is near it
  for (const p of parcels.values()) {
    let contested = false;
    for (const a of sensedAgents) {
      if (a.id !== me.id) {
        const d = Math.abs(a.x - p.x) + Math.abs(a.y - p.y);
        if (d <= CONTEST_RADIUS) {
          contested = true;
          break;
        }
      }
    }
    p.contested = contested;
  }

  for (const p of parcels.values()) {
    if (!p.contested && suspendedDeliveries.has(p.id)) {
      suspendedDeliveries.delete(p.id);
      console.log('[unsuspend]', p.id, 'no longer contested');
    }
  }
});

//export const aStarDaemon = new AStarDaemon(mapTiles);
export const planLibrary = [
  GoPickUp,
  Patrolling,
  GoDeliver,
  AstarMove,
  BulkCollect
];

export function optionsGeneration() {
  // if the *current* intention is BulkCollect, do nothing (don't replan!)
  // console.log('[opts] all parcels:', [...parcels.keys()]);
  // console.log('[opts] suspended:', Array.from(suspendedDeliveries));

  const current = myAgent.intention_queue[0];
  if (current && current.predicate[0] !== 'patrolling') {
    return;
  }

  const options   = [];
  const carried = [...parcels.values()]
    .find(p => p.carriedBy === me.id && !suspendedDeliveries.has(p.id));
  const available = [...parcels.values()]
    .filter(p => !p.carriedBy && !suspendedDeliveries.has(p.id));
  // console.log('[opts] actually available →', available.map(p=>p.id));
  for (const p of parcels.values()) {
    if (suspendedDeliveries.has(p.id) && typeof p.id !== 'string') {
      console.warn('[type-mismatch] suspended has', p.id, 'typeof p.id=', typeof p.id);
    }
  }

  const LOCAL_RADIUS = 6;
  const localCount = available.reduce((cnt, p) => {
    const d = Math.abs(p.x - me.x) + Math.abs(p.y - me.y);
    return cnt + (d <= LOCAL_RADIUS ? 1 : 0);
  }, 0);

  // 1) If you're carrying something, go deliver.
  if (carried && deliveryZones.length) {
    const dz = deliveryZones.reduce((a, b) =>
      distance(me, a) < distance(me, b) ? a : b
    );
    options.push(['go_deliver', dz.x, dz.y]);
  }
  else if (available.length > 0) {
    // 2) Try bulk first…
    const batchResult = selectOptimalBatch(
      available,
      { x: me.x, y: me.y },
      deliveryZones,
      aStarDaemon,
      PENALTY,
      DECAY_INTERVAL_MS/1000,
      localCount
    );
  
    if (
      batchResult &&
      Array.isArray(batchResult.route) &&
      batchResult.route.length > 0
    ) {
      const { route } = batchResult;
      if (route.length > 1) {
        options.push(['bulk_collect', ...route.map(p => p.id)]);
      } else {
        const p = route[0];
        options.push(['go_pick_up', p.x, p.y, p.id]);
      }
    }
    else {
      console.warn('bulk plan failed → falling back to single‐pickup');
      // 3) Fallback: try each parcel individually (by nearest first)
      const byDist = available
        .slice()
        .sort((a,b)=> distance(me,a) - distance(me,b));
      let found = false;
      for (const p of byDist) {
        const singleRoute = aStarDaemon.aStar(
           { x: me.x, y: me.y },
           { x: p.x, y: p.y },
           n => Math.abs(n.x - p.x) + Math.abs(n.y - p.y)
        );
        if (Array.isArray(singleRoute) && singleRoute.length > 0) {
          options.push(['go_pick_up', p.x, p.y, p.id]);
          found = true;
          break;
        }
      }
      if (!found) {
        console.warn('no single parcel reachable → patrol');
        options.push(['patrolling']);
      }
    }
  }
  else {
    // Nothing to do: patrol
    options.push(['patrolling']);
  }

  // 4) don’t re‐push the same intention twice
  const best = options[0];
  const last = myAgent.intention_queue.at(-1);
  const same = last?.predicate?.length === best.length
    && last.predicate.every((v,i)=>String(v)===String(best[i]));
  if (!same) myAgent.push(best);
} 

client.onParcelsSensing(optionsGeneration);
client.onAgentsSensing(optionsGeneration);
client.onYou(optionsGeneration);

const myAgent = new IntentionRevisionReplace();
myAgent.loop()





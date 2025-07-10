import { DeliverooApi, ioClientSocket, sleep } from "@unitn-asa/deliveroo-js-client";
import AStarDaemon from "./astar_daemon.js";
import { distance, pickOldestSector, markSector, SECTOR_SIZE, detectCorridors } from './utils.js';
import selectOptimalBatch from "./select_batch.js";
import { default as argsParser } from "args-parser";

const args = argsParser(process.argv);
const host = args.host;
const token = args.token;
const teamMateId= args.teamId;

var pickupCoordination = {};

const client = new DeliverooApi(host, token);

let PENALTY;
let DECAY_INTERVAL_MS;

const CONTEST_RADIUS = 3;         // Manhattan distance threshold
const CONTEST_PENALTY = 0.5;      // 50% discount on contested parcels
const MAX_SECTORS_TO_TRY = 5;
const MAX_TILES_PER_SECTOR = 10;
const SCOUT_STEPS = 5;            // scouting steps around parcel-spawning tiles

const suspendedDeliveries = new Set();

globalThis.disableCorridorLocks = false;
let corridorCellMap  = new Map();
const corridorCellsById = new Map();
const pendingCorridorPromises = new Map();
let corridorSegments = [];
let corridorLocks = {};

const STATE_IDLE             = 'IDLE';
const STATE_HANDOFF_PENDING  = 'HANDOFF_PENDING';
const STATE_HANDOFF_ACTIVE   = 'HANDOFF_IN_PROGRESS';
let state = STATE_IDLE;

client.onConfig(cfg => {
  PENALTY = cfg.PENALTY;
  DECAY_INTERVAL_MS = parseInt(cfg.PARCEL_DECADING_INTERVAL) * 1000;
});

const me = {id: null, name: null, x: null, y: null, score: null};
let lastSeenMate = null;

client.onYou(({id, name, x, y, score}) => {
    me.id = id;
    me.name = name;
    // console.log([${name}] Connected with ID: ${id});
    me.x = x;
    me.y = y;
    me.score = score;
});

setInterval(() => {
  client.emitSay(teamMateId, {
    action: 'position_update',
    x: me.x,
    y: me.y
  });
}, 1000);

// add function to exchange message between teammate
client.onMsg(async (id, name, msg, reply) => {
  //console.log(Received message from ${name}:, msg);
  if (msg.action === 'position_update') {
    lastSeenMate = { x: msg.x, y: msg.y };
    return;
  }

  if (msg.action === 'parcel_snapshot') {
    const now = Date.now();
    for (const p of msg.parcels) {
      const existing = parcels.get(p.id) || { ...p };
      const rivals = [...agents.values()]
      .filter(a => a.id !== me.id);
      const contested = rivals.some(a =>
      distance(a, p) <= distance(me, p)
      );

      parcels.set(p.id, {
        ...existing,
        ...p,    // update x,y,reward,carriedBy
        spawnTime:     existing.spawnTime ?? now,
        initialReward: existing.initialReward ?? p.reward,
        lastSeen: existing.lastSeen ?? p.lastSeen ?? now,
        expectedUtility: contested
          ? p.reward * (1 - CONTEST_PENALTY)
          : p.reward,
        seenBy: {
          ...(existing.seenBy || {}),
          [id]: now    // mark “seen by teammate”
        }
      });
    }
    return;
  }

  if (msg?.action === 'pickup') {
    await sleep(Math.random() * 50); // Random delay to avoid race conditions
    if (reply) {
      try {
        if (pickupCoordination[msg.parcelId]?.id === me.id) {
          console.log("Replying NO: I'm already picking up parcel", msg.parcelId);
          reply(false);
        } else if (pickupCoordination[msg.parcelId]?.id === id || !pickupCoordination[msg.parcelId]) {
          console.log("Replying YES: Teammate can pick up parcel", msg.parcelId);
          pickupCoordination[msg.parcelId] = { id: id, ts: Date.now() };
          reply(true);
        }
      } catch (error) {
        console.error(error);
      }
    }
  }

  if (msg.action === 'handoff_request') {
    const { parcels, rendezvous } = msg;
    state = STATE_HANDOFF_PENDING;

    const tile = mapTiles.get(`${rendezvous.x},${rendezvous.y}`);
    const occupied = tile?.locked && !(rendezvous.x === agents.get(id)?.x && rendezvous.y === agents.get(id)?.y);
    const granted = !occupied;
    console.log(
      `[${me.name}] ← handoff_request for [${parcels}] at (${rendezvous.x},${rendezvous.y}) ` +
      `→ granted=${granted}`
    );

    reply(granted);

    if (granted) {
      console.log(`[${me.name}] scheduling handoff_execute from=${id}`);
      const adjacents = getAdjacentUnblocked(rendezvous, mapTiles);
      let target = adjacents[0];
      
      myAgent.unconditionalPush([
          'handoff_execute',
          id,          // requester
          target.x,    // adjacent tile, not rendezvous!
          target.y,
          ...parcels
      ]);
    }
    console.log('queue now =', myAgent.intention_queue.map(i=>i.predicate));
    return;
  }

  if (msg.action === 'handoff_done') {
    const { x, y } = msg;
    const cid = getCorridorId(x, y);
    if (cid) {
      // broadcast to yourself as well, not just your teammate
      client.emitSay(null, {
        action: 'corridor_release',
        corridorId: cid,
        ts: Date.now()
      });
      delete corridorLocks[cid];
    }
  }

  switch (msg.action) {

    // 1) SHOUT: everyone (including you) hears “this corridor is now owned by X”
    case 'corridor': {
      const { corridorId, owner: locker, ts } = msg;
      console.log(
        `[${me.name}] ← SHOUT corridor ${corridorId} now owned by ${locker} @ ${new Date(ts).toISOString()}`
      );

      // update who holds the lock
      if (!corridorLocks[corridorId] || ts >= corridorLocks[corridorId].ts) {
        corridorLocks[corridorId] = { owner: locker, ts };
        const cells = corridorCellsById.get(corridorId) || [];
        for (const key of cells) {
          mapTiles.get(key).corridorLocked = (locker !== me.id);
        }
      }
      return;
    }

    // 2) REQUEST: someone asks *you* to grant access → decide & reply,
    //    but don’t touch mapTiles here
    case 'corridor_request': {
      const { corridorId, owner: requester, ts } = msg;
      if (requester === me.id) return;
      console.log(
        `[${me.name}] ← REQUEST corridor ${corridorId} from ${requester} @ ${new Date(ts).toISOString()}`
      );
      const current = corridorLocks[corridorId];
      const willGrant = !current || current.owner === requester || ts < current.ts;
      console.log(`[${me.name}] → willGrant=${willGrant} (current owner=${current?.owner||'none'})`);

      if (willGrant) {
        corridorLocks[corridorId] = { owner: requester, ts };
      }
      client.emitSay(id, {
        action: 'corridor_response',
        corridorId,
        granted: willGrant
      });
      return;
    }

    // 3) RESPONSE: the reply to *your* request → just resolve the promise
    //    (the shout that you immediately emit next will run the SHOUT handler)
    case 'corridor_response': {
      const { corridorId, granted } = msg;
      console.log(`[${me.name}] ← RESPONSE corridor ${corridorId}: granted=${granted}`);
      const resolve = pendingCorridorPromises.get(corridorId);
      if (resolve) {
        resolve(granted);
        pendingCorridorPromises.delete(corridorId);
      }

      // if denied, mark it locked locally so you stop asking
      if (!granted) {
        corridorLocks[corridorId] = { owner: 'other', ts: Date.now() };
        const cells = corridorCellsById.get(corridorId) || [];
        for (const key of cells) {
          mapTiles.get(key).corridorLocked = true;
        }
      }
      return;
    }

    // 4) RELEASE: someone frees it → clear both your table and the tiles
    case 'corridor_release': {
    const { corridorId, ts } = msg;
    // only clear if the release matches the lock we think we hold
    if (corridorLocks[corridorId]?.ts === ts) {
      delete corridorLocks[corridorId];
      const cells = corridorCellsById.get(corridorId) || [];
      for (const key of cells) {
        mapTiles.get(key).corridorLocked = false;
      }
    }
      return;
    }
  }
});

const parcels = new Map();
client.onParcelsSensing(async (pp) => {
  const now = Date.now();
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
      lastSeen: now,
      spawnTime,
      initialReward,
      expectedUtility,
      seenBy: { [me.id]: now }
    });
  }

  await client.emitSay(teamMateId, {
    action: 'parcel_snapshot',
    parcels: pp
  });

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

  // 3) Cleanup suspendedDeliveries
  for (const id of Array.from(suspendedDeliveries)) {
    if (!parcels.has(id)) {
      // it was delivered, stolen, or decayed away
      suspendedDeliveries.delete(id);
      // console.log('[unsuspend]', id);
    }
  }
});

const deliveryZones = [];
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

export const mapTiles = new Map();

client.onMap((width, height, tiles) => {
  mapTiles.clear();
  for (const t of tiles) {
    // store an object, with both type and locked flag
    mapTiles.set(
      `${t.x},${t.y}`,
      { type: t.type, locked: false }
    );
  }
  buildCorridorMap(width, height, tiles);
  // if there is exactly one corridor that spans the map edge‐to‐edge, assume hallway:
  // console.log('[DISABLE?] segment length:', corridorSegments[0].cells.length, 'max(width,height):', Math.max(width, height));
  if (true) {
    console.log('[DISABLE] hallway detected → disabling all corridor locks');
    globalThis.disableCorridorLocks = true;

    // clear any existing locks & cells
    corridorLocks = {};
    corridorCellsById.clear();
    corridorCellMap.clear();
    for (const entry of mapTiles.values()) {
      entry.corridorLocked = false;
    }
  }
});

function buildCorridorMap(width, height, tiles) {
  // console.log(`[${me.name}] 🔄 got onMap, building corridor map…`);

  deliveryZones.length = 0;
  for (const tile of tiles) {
    if (tile.type === 2) deliveryZones.push({ x: tile.x, y: tile.y });
  }

  mapTiles.clear();
  for (const t of tiles) {
    mapTiles.set(
      `${t.x},${t.y}`,
      { type: t.type, locked: false, corridorLocked: false }
    );
  }

  corridorSegments = detectCorridors(mapTiles);
  corridorCellMap.clear();
  corridorCellsById.clear();

  for (const [cid, {owner, ts}] of Object.entries(corridorLocks)) {
    const cells = corridorCellsById.get(cid) || [];
    for (const key of cells) {
      mapTiles.get(key).corridorLocked = true;
    }
  }

  for (const seg of corridorSegments) {
    const keys = seg.cells.map(c => `${c.x},${c.y}`);
    corridorCellsById.set(seg.id, keys);
    for (const key of keys) corridorCellMap.set(key, seg.id);
  }

  console.log('[DEBUG] detected corridors:', corridorSegments.map(s => ({
    id: s.id, span: s.cells.length+' cells', exampleCell: `${s.cells[0].x},${s.cells[0].y}`
  })));
}

function getCorridorId(x,y) {
  const key = `${x},${y}`;
  const cid = corridorCellMap.get(key) || null;
  //console.log(`[${me.name}] getCorridorId(${key}) →`, cid);
  return cid;
}

async function askCorridorLock(toId, corridorId, owner) {
  return new Promise(resolve => {
    pendingCorridorPromises.set(corridorId, resolve);
    client.emitSay(toId, {
      action: 'corridor_request',
      corridorId,
      owner,
      ts: Date.now()
    });
    // optionally: add a timeout here to auto‐reject if no answer
  });
}

function getAdjacentUnblocked(tile, mapTiles) {
    const directions = [
        {dx: 1, dy: 0}, {dx: -1, dy: 0}, {dx: 0, dy: 1}, {dx: 0, dy: -1}
    ];
    return directions
        .map(d => ({x: tile.x + d.dx, y: tile.y + d.dy}))
        .filter(n =>
            mapTiles.has(`${n.x},${n.y}`) &&
            !mapTiles.get(`${n.x},${n.y}`).locked &&
            !mapTiles.get(`${n.x},${n.y}`).corridorLocked &&
            mapTiles.get(`${n.x},${n.y}`).type === 3
        );
}

function chooseReachableMeetpoint() {
  const mePt = { x: me.x, y: me.y };
  const matePt = agents.get(teamMateId) || lastSeenMate;

  let best = null;
  let bestScore = Infinity;

  for (const [key, tile] of mapTiles.entries()) {
    if (![1, 3].includes(tile.type)) continue;   // Only skip if NOT floor or corridor
    const [x, y] = key.split(',').map(Number);
    if (x === mePt.x && y === mePt.y) continue;
    if (tile.locked || tile.corridorLocked) {
      continue;
    }

    const myDist = Math.abs(mePt.x - x) + Math.abs(mePt.y - y);
    const mateDist = matePt ? (Math.abs(matePt.x - x) + Math.abs(matePt.y - y)) : 0;

    // No need for Infinity check with manhattan
    const score = myDist + mateDist;
    if (score < bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }
  return best;  // can be null if map is totally blocked
}

// 2) Updated proposeHandoff: bail if no meet-point or it's unreachable
async function proposeHandoff(parcelIds) {
  console.log('[DBG] proposeHandoff called, parcels=', parcelIds);
  const meet = await chooseReachableMeetpoint();
  if (!meet) {
    console.log('[DBG] no valid rendezvous → cancelling handoff');
    state = STATE_IDLE;
    return false;
  }
  console.log('[DBG] proposeHandoff rendezvous =', meet);

  state = STATE_HANDOFF_PENDING;
  const granted = await client.emitAsk(teamMateId, {
    action:     'handoff_request',
    parcels:    parcelIds,
    rendezvous: meet,
    ts:         Date.now()
  });
  console.log('[DBG] handoff_request reply =', granted);

  if (!granted) {
    state = STATE_IDLE;
    console.log('[DBG] handoff denied → back to IDLE');
    return false;
  }

  console.log('[DBG] handoff granted, queueing handoff_execute');
  state = STATE_HANDOFF_PENDING;
  setImmediate(() => {
    myAgent.unconditionalPush([
      'handoff_execute', me.id, meet.x, meet.y, ...parcelIds
    ]);
  });
  console.log('queue now =', myAgent.intention_queue.map(i=>i.predicate));
}

// When a single tile updates:
client.onTile(tile => {
  const key = `${tile.x},${tile.y}`;
  const entry = mapTiles.get(key);
  if (entry) {
    entry.type = tile.type;
  }
});

const agents = new Map();
client.onAgentsSensing(sensedAgents => {
  for (const a of sensedAgents) {
    agents.set(a.id, { id: a.id, x: a.x, y: a.y, score: a.score });
    if (a.id === teamMateId) {
      lastSeenMate = { x: a.x, y: a.y };
    }
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

const aStarDaemon = new AStarDaemon(mapTiles);

function estimateCost(start, parcel) {
  const pathToParcel = aStarDaemon
    .aStar(start, parcel, n => distance(n, parcel)) || [];
  const d1 = pathToParcel.length;

  const bestZoneDist = Math.min(
    ...deliveryZones.map(z =>
      (aStarDaemon.aStar(parcel, z, n => distance(n, z)) || []).length
    )
  );

  const loadFactor = 1
    + [...parcels.values()].filter(p => p.carriedBy === me.id).length;

  return (d1 + bestZoneDist) * loadFactor;
}

const PARCEL_TTL = 30_000;     // how long we keep “shared” drops

function assignParcelsToMe() {
  const assigned = new Set();
  const matePos = agents.get(teamMateId) || lastSeenMate;

  // 0) prune any old private‐claim entries
  const CLAIM_TTL = 10_000;
  for (const [pid, claim] of Object.entries(pickupCoordination)) {
    if (Date.now() - (claim.ts||0) > CLAIM_TTL) {
      delete pickupCoordination[pid];
    }
  }

  const now = Date.now();

  for (const [id, p] of parcels) {
    // 1) drop parcels neither of us has refreshed recently
    const lastSeenAny = Math.max(
      ...Object.values(p.seenBy || {}).map(ts => ts || 0),
      0
    );
    if (now - lastSeenAny > PARCEL_TTL) {
      parcels.delete(id);
      continue;
    }

    // 2) skip if someone else is already carrying it
    if (p.carriedBy && p.carriedBy !== me.id) continue;

    // 3) compute net utilities
    const myCost = estimateCost({ x: me.x,      y: me.y }, p);
    const theirCost = matePos
      ? estimateCost({ x: matePos.x, y: matePos.y }, p)
      : Infinity;

    const myNet = p.expectedUtility - PENALTY * ( myCost    / (DECAY_INTERVAL_MS/1000) );
    const theirNet = p.expectedUtility - PENALTY * ( theirCost / (DECAY_INTERVAL_MS/1000) );

    //console.log(
      //`[assign] parcel ${id}: reward=${p.expectedUtility.toFixed(1)}, `,
      //`myCost=${myCost.toFixed(1)}, theirCost=${theirCost.toFixed(1)}, `,
      //`myNet=${myNet.toFixed(2)}, theirNet=${theirNet.toFixed(2)}`
    //);

    if (myNet > theirNet) {
      assigned.add(id);
    }
    else if (Math.abs(myNet - theirNet) < 1e-6) {
      // a) private‐claim wins
      if (pickupCoordination[id]?.id === me.id) {
        assigned.add(id);
      }
      // b) otherwise, whoever saw it first wins
      else if (
        (p.seenBy[me.id] || 0) >
        (p.seenBy[teamMateId] || 0)
      ) {
        assigned.add(id);
      }
    }
  }

  return assigned;
}

function optionsGeneration() {
  // console.trace(`[${me.name}] optionsGeneration()`);
  // if the *current* intention is BulkCollect, do nothing (don't replan!)
  // console.log('[opts] all parcels:', [...parcels.keys()]);
  // console.log('[opts] suspended:', Array.from(suspendedDeliveries));
  if (state === STATE_HANDOFF_PENDING || state === STATE_HANDOFF_ACTIVE) {
    // console.log('[opts] Skipping option generation—handoff in progress');
    return;
  }

  const current = myAgent.intention_queue[0];
  if (current && current.predicate[0] !== 'patrolling') {
    return;
  }

  const options = [];
  const assignedToMe = assignParcelsToMe();

  const carried = [...parcels.values()]
    .find(p => p.carriedBy === me.id && !suspendedDeliveries.has(p.id));
  const available = [...parcels.values()]
    .filter(p =>
      assignedToMe.has(p.id) &&
      !p.carriedBy &&
      !suspendedDeliveries.has(p.id)
    );
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

  // 0) physical handoff?
  const carriedIds = [...parcels.values()]
    .filter(p => p.carriedBy === me.id && !suspendedDeliveries.has(p.id))
    .map(p => p.id);

  if (carriedIds.length && deliveryZones.length) {
    // pick your closest zone
    const dz = deliveryZones.reduce((a, b) =>
      distance(me, a) < distance(me, b) ? a : b
    );

    // compute solo vs. mate distance
    const soloDist = Math.abs(me.x - dz.x) + Math.abs(me.y - dz.y);
    const matePos  = agents.get(teamMateId) || lastSeenMate;
    if (matePos) {
      const mateDist = Math.abs(matePos.x - dz.x) + Math.abs(matePos.y - dz.y);
      
      // 👉 if teammate can deliver faster, hand off
      if (mateDist < soloDist) {
        console.log('[DBG] mateDist < soloDist:', mateDist, '<', soloDist);
        await proposeHandoff(carriedIds);
        return;   // drop out of normal planning
      }
    }
  }

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
    console.log('pushing patrolling from optionsGeneration()');
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

class Intention {
  #current_plan;
  #stopped = false;
  #started = false;
  #parent;
  #predicate;

  constructor(parent, predicate) {
      this.#parent = parent;
      this.#predicate = predicate;
  }

  get stopped() { return this.#stopped; }
  get predicate() { return this.#predicate; }

  stop() {
      this.#stopped = true;
      if (this.#current_plan) this.#current_plan.stop();
  }

  log(...args) {
      if (this.#parent?.log)
          this.#parent.log('\t', ...args);
      else
          console.log(...args);
  }

  async achieve() {
      if (this.#started) return this;
      this.#started = true;
      for (const planClass of planLibrary) {
          if (this.stopped) throw ['stopped intention', ...this.predicate];
          if (planClass.isApplicableTo(...this.predicate)) {
              this.#current_plan = new planClass(this.#parent);
              try {
                  return await this.#current_plan.execute(...this.predicate);
              } catch (error) {}
          }
      }
      if (this.stopped) throw ['stopped intention', ...this.predicate];
      throw ['no plan satisfied the intention', ...this.predicate];
  }
}

class IntentionRevision {
  #intention_queue = [];
  get intention_queue() { return this.#intention_queue; }

async loop() {
  console.log('Intention loop running, queue:', this.#intention_queue.map(i => i.predicate));
  let lastActionTime = Date.now();
  const STUCK_THRESHOLD = 3000; // ms

  while (true) {
    // ─── 1) Preempt everything once we enter a handoff ───
    const first = this.intention_queue[0];
    if ((state === STATE_HANDOFF_PENDING || state === STATE_HANDOFF_ACTIVE)
        && first
        && first.predicate[0] !== 'handoff_execute'
        && this.intention_queue.some(i => i.predicate[0] === 'handoff_execute')) {
      console.log('[handoff] preempting to handoff_execute');
      // stop *all* running plans
      for (const intent of this.#intention_queue) intent.stop();
      // keep only the handoff_execute intent in the queue (if it’s there)
      this.#intention_queue = this.#intention_queue
        .filter(i => i.predicate[0] === 'handoff_execute');
    }

    // ─── 2) If handoff_execute is queued, run *only* that ───
    if (this.#intention_queue.length > 0) {
      const intention = this.#intention_queue[0];
      let ran = false;
      try {
        await intention.achieve();
        ran = true;
      } catch (err) {
        console.log('[LOOP] Exception in achieve:', err);
        ran = true;
      }
      // Only shift if this is STILL the head of the queue!
      if (this.#intention_queue[0] === intention && ran) {
        this.#intention_queue.shift();
      }
      await new Promise(r => setImmediate(r));
      continue;
    }

    // ─── 3) If we’re still in handoff but nothing to execute yet, just wait ───
    if (state !== STATE_IDLE) {
      await new Promise(r => setTimeout(r, 50));
      continue;
    }

    // ─── 4) Normal planning when truly idle ───
    await optionsGeneration();
    lastActionTime = Date.now();

    // ─── 5) Stuck recovery ───
    if (Date.now() - lastActionTime > STUCK_THRESHOLD) {
      console.log("Force resetting intentions due to inactivity");
      this.#intention_queue = [];
      await optionsGeneration();
      lastActionTime = Date.now();
    }

    // small yield so we don’t spin the loop too hard
    await new Promise(r => setImmediate(r));
  }
}

  // Regular push: avoid queueing the same intention
  async push(predicate) {
    console.log(`[PUSH] State: ${state}, predicate:`, predicate);
    const last = this.intention_queue.at(-1);
    if (last && last.predicate.join(' ') == predicate.join(' ')) return;
    const intention = new Intention(this, predicate);
    this.intention_queue.push(intention);

    // If there was a previous intention, stop it so we only follow one at a time
    if (last) last.stop();
  }

  unconditionalPush(predicate) {
    console.log(`[UNCONDPUSH] State: ${state}, predicate:`, predicate);
    for (const intent of this.#intention_queue) {
      intent.stop();
    }
    this.#intention_queue = [];
    const intent = new Intention(this, predicate);
    this.#intention_queue.push(intent);
    console.log('[UNCONDPUSH after]', this.#intention_queue.map(i => i.predicate));
  }
}

const myAgent = new IntentionRevision();
myAgent.loop();

const planLibrary = [];

class Plan {
    #stopped = false;
    #parent;
    #sub_intentions = [];

    constructor(parent) {
        this.#parent = parent;
    }

    stop() {
        this.#stopped = true;
        for (const i of this.#sub_intentions) {
            i.stop();
        }
    }

    get stopped() { return this.#stopped; }

    log(...args) {
        if (this.#parent?.log)
            this.#parent.log('\t', ...args);
        else
            console.log(...args);
    }

    async subIntention(predicate) {
        const sub = new Intention(this, predicate);
        this.#sub_intentions.push(sub);
        return sub.achieve();
    }
}

class GoPickUp extends Plan {
  static isApplicableTo(goal, x, y, id) {
    return goal === 'go_pick_up';
  }

  async execute(goal, x, y, id) {
    if (this.stopped) throw ['stopped'];

    const p = parcels.get(id);
    const mate = agents.get(teamMateId);
    const myCost = estimateCost(me, p);
    const theirCost = mate
      ? estimateCost({x:mate.x, y:mate.y}, p)
      : Infinity;
    const myNet = p.expectedUtility  - PENALTY * (myCost / (DECAY_INTERVAL_MS/1000));
    const theirNet = p.expectedUtility  - PENALTY * (theirCost / (DECAY_INTERVAL_MS/1000));

    if (Math.abs(myNet - theirNet) < 1e-6) {
      const tieReply = await client.emitAsk(teamMateId, {
        action: 'pickup',
        parcelId: id
      });

      if (!tieReply) {
        // Teammate says “I will take it”
        pickupCoordination[id] = { id: teamMateId, ts: Date.now() };
        throw ['stopped'];
      }
    }
    // else: they declined → we take it
    pickupCoordination[id] = { id: me.id, ts: Date.now() };

    // 0) already standing on the target?
    if (me.x === x && me.y === y) {
      this.log(`GoPickUp: already on parcel ${id}, attempting pickup`);
      const ok = await client.emitPickup();
      if (!ok) {
        this.log(`GoPickUp: no parcel ${id} here → removing`);
        parcels.delete(id);
        suspendedDeliveries.delete(id);
        delete pickupCoordination[id];
        throw ['stopped'];
      }
      // success!
      parcels.delete(id);
      suspendedDeliveries.delete(id);
      delete pickupCoordination[id];
      return true;
    }

    // 1) otherwise walk to it once
    try {
      this.log(`GoPickUp → moving to parcel ${id} @(${x},${y})`);
      await this.subIntention(['go_to', x, y, id]);
    } catch {
      this.log(`GoPickUp: parcel ${id} unreachable — removing`);
      parcels.delete(id);
      suspendedDeliveries.delete(id);
      delete pickupCoordination[id];
      throw ['stopped'];
    }

    // 2) try the pickup
    this.log(`GoPickUp → picking up parcel ${id}`);
    const ok = await client.emitPickup();
    if (!ok) {
      this.log(`GoPickUp: pickup failed for ${id} — removing`);
      parcels.delete(id);
      suspendedDeliveries.delete(id);
      delete pickupCoordination[id];
      throw ['stopped'];
    }

    // 3) success!
    parcels.delete(id);
    suspendedDeliveries.delete(id);
    delete pickupCoordination[id];
    return true;
  }
}

class GoDeliver extends Plan {
  static isApplicableTo(goal, x, y) {
    return goal === 'go_deliver';
  }

  async execute(goal, x, y) {
    // collect the *active* carried IDs
    const toDeliver = [...parcels.values()]
      .filter(p => p.carriedBy === me.id && !suspendedDeliveries.has(p.id))
      .map(p => p.id);

    if (!toDeliver.length) {
      this.log('GoDeliver: nothing to deliver (all suspended)');
      return true;
    }

    // same “try each delivery‐zone with back-off” you already have…
    const zones = deliveryZones.slice().sort((a,b)=>distance(me,a)-distance(me,b));
    for (const dz of zones) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          this.log(`GoDeliver → to ${dz.x},${dz.y} [attempt ${attempt}]`);
          await this.subIntention(['go_to', dz.x, dz.y]);
          // success!
          for (const id of toDeliver) suspendedDeliveries.delete(id);
          await client.emitPutdown();  // drop one by one if you like
          return true;
        } catch (_) {
          this.log(  `GoDeliver: blocked at (${dz.x},${dz.y}) on attempt ${attempt}`);
        }
      }
      this.log(  `GoDeliver: giving up on zone (${dz.x},${dz.y}), trying next`);
    }

    // if we get here, *all* zones failed → suspend these parcels
    for (const id of toDeliver) suspendedDeliveries.add(id);
    this.log('GoDeliver: all zones blocked → suspending delivery of', toDeliver);
    throw ['stopped'];   // abort so that optionsGeneration will pick something else
  }
}

class Patrolling extends Plan {
  static isApplicableTo(goal) {
    return goal === 'patrolling';
  }

  async execute(goal) {
    if (this.stopped) throw ['stopped'];

    // Try a handful of different sectors
    for (let sTry = 1; sTry <= MAX_SECTORS_TO_TRY; sTry++) {
      const [sx, sy] = pickOldestSector(mapTiles);
      markSector(me.x, me.y);    // mark *current* sector so we age others
      markSector(sx * SECTOR_SIZE, sy * SECTOR_SIZE); // also mark chosen sector

      // collect all tiles in that sector
      const x0 = sx * SECTOR_SIZE, y0 = sy * SECTOR_SIZE;
      const candidates = [];
      for (const key of mapTiles.keys()) {
        const [x, y] = key.split(',').map(Number);
        if (x >= x0 && x < x0 + SECTOR_SIZE
          && y >= y0 && y < y0 + SECTOR_SIZE) {
          const tile = mapTiles.get(key);
          // Filter for type 1 tiles ---
          if (tile.type === 1) {
            candidates.push({ x, y });
          }
        }
      }

      if (candidates.length === 0) {
        this.log(`Patrolling: sector ${sx},${sy} has no spawn-tiles, skipping…`);
        continue;
      }

      // try up to MAX_TILES_PER_SECTOR random picks
      for (let tTry = 1; tTry <= MAX_TILES_PER_SECTOR; tTry++) {
        if (this.stopped) throw ['stopped'];

        const { x, y } = candidates[Math.floor(Math.random() * candidates.length)];
        this.log(`Patrolling → sector ${sx},${sy} → attempt ${tTry} @ (${x},${y})`);
        try {
          await this.subIntention(['go_to', x, y]);
          
          const dirs = [{dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1}];
          for (let i = 0; i < SCOUT_STEPS; i++) {
            if (this.stopped) throw ['stopped'];
            const {dx,dy} = dirs[Math.floor(Math.random()*4)];
            const nx = me.x + dx, ny = me.y + dy;
            const key = `${nx},${ny}`, tile = mapTiles.get(key);
            if (!tile.locked) {
              try {
                this.log(`scouting → (${nx},${ny})`);
                await this.subIntention(['go_to', nx, ny]);
              } catch {
                this.log(`blocked @ (${nx},${ny}), stay put`);
              }
            } else {
              this.log(`skip invalid (${nx},${ny})`);
            }
            // small pause so you don’t zip instantly:
            await new Promise(r => setTimeout(r, 50));
          }

          this.log('Patrolling: scouting done, ready for next sector');
          return true;

        } catch {
          this.log(  `Patrolling: (${x},${y}) blocked, retrying…`);
          // immediate retry; no setTimeout
        }
      }

      this.log(`Patrolling: sector ${sx},${sy} exhausted, picking new sector…`);
    }

    // all sectors & tiles tried, give up
    this.log('Patrolling: all sectors exhausted—aborting patrol');
    throw ['stopped'];
  }
}

function cleanupCorridorLocks() {
  const now = Date.now();
  const TTL =  3000;
  for (const [cid, { ts }] of Object.entries(corridorLocks)) {
    if (now - ts > TTL) {
      delete corridorLocks[cid];
      const cells = corridorCellsById.get(cid) || [];
      for (const key of cells) {
        mapTiles.get(key).corridorLocked = false;
      }
    }
  }
}

class AstarMove extends Plan {
  static isApplicableTo(goal, x, y, id) {
    return goal === 'go_to';
  }

  async execute(goal, targetX, targetY, parcelId) {
    cleanupCorridorLocks();

    const MAX_RETRIES = 4;              // Max times to replan the full path
    const MAX_LOCK_WAIT = 4;            // Max num of short waits if a tile is locked
    const STEP_CONFIRM_TIMEOUT = 4;     // Max attempts to confirm that the agent moved

    let currentX = me.x;
    let currentY = me.y;
    let retries = 0;

    while (retries < MAX_RETRIES) {

      const plan = aStarDaemon.aStar(
        { x: currentX, y: currentY },
        { x: targetX, y: targetY },
        n => {
          const tile = mapTiles.get(`${n.x},${n.y}`);
          // Heuristic: Manhattan distance + penalty if tile is currently locked
          return Math.abs(n.x - targetX) + Math.abs(n.y - targetY) + (tile?.locked || tile?.corridorLocked ? 15 : 0);
        }
      );

      if (!plan || plan === 'failure' || plan.length === 0) {
        this.log(`AstarMove: No path to (${targetX}, ${targetY}) [retry ${retries + 1}]`);
        retries++;
        await sleep(300 + Math.random() * 200); // Prevent sync retries
        continue;
      }

      let prevCorridor = null;
      for (const step of plan) {
        if (this.stopped) throw ['stopped'];

        // —— corridor lock logic begins ——
        const cid = getCorridorId(step.x, step.y);
        if (!disableCorridorLocks && cid && cid !== prevCorridor) {
          // request new corridor
          const granted = await askCorridorLock(teamMateId, cid, me.id);
          if (!granted) {
            throw new Error(`Corridor ${cid} denied`);
          }

          // **immediately update your own local state** so you see it unlocked
          const ts = Date.now();
          corridorLocks[cid] = { owner: me.id, ts };
          const cells = corridorCellsById.get(cid) || [];
          console.log("CLEARED locally:", cid, cells);
          for (const key of cells) {
            mapTiles.get(key).corridorLocked = false;
          }

          // then broadcast the shout so others lock it
          client.emitSay(teamMateId, {
            action: 'corridor',
            corridorId: cid,
            owner: me.id,
            ts
          });

          // release previous corridor REMOTELY…
          if (prevCorridor) {
            client.emitSay(teamMateId, {
              action: 'corridor_release',
              corridorId: prevCorridor
            });
            // …and also clear it LOCALLY
            delete corridorLocks[prevCorridor];
            const oldCells = corridorCellsById.get(prevCorridor) || [];
            for (const key of oldCells) {
              mapTiles.get(key).corridorLocked = false;
            }
          }

          prevCorridor = cid;
        }
        // —— corridor lock logic ends ——

        const p = parcels.get(parcelId);
        if (parcelId && p?.carriedBy && p.carriedBy !== me.id) {
          delete pickupCoordination[parcelId];
          throw ['stolen', parcelId];
        }

        const tileKey = `${step.x},${step.y}`;
        const tile = mapTiles.get(tileKey);

        // Wait a few cycles if the tile is locked 
        let lockWaits = 0;
        while ((tile?.locked || (!disableCorridorLocks && tile?.corridorLocked)) && lockWaits++ < MAX_LOCK_WAIT) {
          await sleep(30 + Math.random() * 50);
        }

        // If still locked, penalize tile and continue with the rest of the plan
        if (tile?.locked || (!disableCorridorLocks && tile?.corridorLocked)) {
          aStarDaemon.addTempPenalty(step.x, step.y, 10);
          await sleep(30 + Math.random() * 50);
          continue;
        }

        try {
          const beforeX = me.x;
          const beforeY = me.y;

          // Attempt the move
          const moveResult = await client.emitMove(step.action);

          if (!moveResult) {
            this.log(`AstarMove: Move blocked (action: ${step.action})`);
            retries++;
            break; // Replan if move was denied
          }

          // Wait to confirm movement was successful
          let confirmed = false;
          for (let i = 0; i < STEP_CONFIRM_TIMEOUT; i++) {
            await sleep(20);
            if (me.x !== beforeX || me.y !== beforeY) {
              confirmed = true;
              break;
            }
          }

          // If not move, trigger replanning
          if (!confirmed) {
            this.log('AstarMove: Move unconfirmed → aborting path');
            retries++;
            break;
          }

          // Update current position
          currentX = me.x;
          currentY = me.y;

          await this.checkOpportunisticActions();

          // Exit early if target reached
          if (currentX === targetX && currentY === targetY) {
            if (prevCorridor) {
              client.emitSay(teamMateId, {
                action: 'corridor_release',
                corridorId: prevCorridor
              });
          }
            return true;
          }

        } catch (err) {
          this.log('AstarMove: Exception during move → skipping step');
          retries++;
          break;
        }
      }
    }

    // Too many retries, give up
    this.log('AstarMove: Max retries reached → aborting');
    throw ['stopped'];
  }

  async checkOpportunisticActions() {
    // Get all parcels currently carried
    const carried = [...parcels.values()].filter(p => p.carriedBy === me.id);

    // Opportunistically pick up parcel at current location if reward is still good
    if (carried.length < 3) {
      const parcelHere = [...parcels.values()].find(p =>
        p.x === me.x && p.y === me.y && !p.carriedBy
      );
      if (parcelHere && parcelHere.reward > 5) {
        console.log('Opportunistic pickup');
        await client.emitPickup();
      }
    }

    // Opportunistically deliver if standing on a delivery zone
    if (deliveryZones.some(z => z.x === me.x && z.y === me.y)) {
      if (carried.length > 0) {
        console.log('Opportunistic delivery');
        await client.emitPutdown();
      }
    }
  }
}

class BulkCollect extends Plan {
  static isApplicableTo(goal) {
    return goal === 'bulk_collect';
  }

  /**
   * predicate = ['bulk_collect', id1, id2, ..., idN]
   */
  async execute(goal, ...ids) {
    if (this.stopped) throw ['stopped'];
    this.log('BulkCollect starting…');

    // 1) map IDs to parcel objects (may have moved or been stolen so filter those out)
    const batch = ids
      .map(id => parcels.get(id))
      .filter(p => p && !p.carriedBy);

    if (batch.length === 0) {
      this.log('BulkCollect: nothing to batch, falling back to patrol');
      await this.subIntention(['patrolling']);
      return true;
    }

    // 2) Walk and pickup each in turn
    for (const p of batch) {
      if (this.stopped) throw ['stopped'];
      this.log(`BulkCollect → heading to pickup ${p.id} @ (${p.x},${p.y})`);
      if (me.x !== p.x || me.y !== p.y) {
        await this.subIntention(['go_to', p.x, p.y, p.id]);
      }
      if (this.stopped) throw ['stopped'];
      this.log(`BulkCollect → picking up ${p.id}`);
      const ok = await client.emitPickup();
      if (!ok) {
        this.log('BulkCollect: pickup failed — discounting', p.id);
        const q = parcels.get(p.id);
        if (q) {
          q.expectedUtility = q.expectedUtility * CONTEST_PENALTY;
          parcels.set(p.id, q);
        }
        break;
      }
      parcels.delete(p.id);
    }

    // 3) Deliver if we got at least one
    const carriedCount = batch.length;
    if (carriedCount && deliveryZones.length) {
      const dz = deliveryZones.reduce((a, b) =>
        distance(me, a) < distance(me, b) ? a : b
      );
      this.log('BulkCollect → delivering to', dz);
      await this.subIntention(['go_to', dz.x, dz.y]);
      for (let i = 0; i < carriedCount; i++) {
        if (this.stopped) throw ['stopped'];
        this.log('BulkCollect → putdown parcel');
        await client.emitPutdown();
      }
    }

    this.log('BulkCollect → DONE');
    return true;
  }
}

class HandoffExecute extends Plan {
  static isApplicableTo(goal, from, x, y, ...ids) {
    return goal === 'handoff_execute';
  }

  async execute(_, from, x, y, ...ids) {
    console.log("[HANDOFF] Entering execute for", from, x, y, ids);
    state = STATE_HANDOFF_ACTIVE;
    try {
      console.log(`[${me.name}] ▶ handoff_execute → rendezvous (${x},${y})`);
      if (me.x === x && me.y === y) {
        console.log(`[${me.name}] ▶ already at rendezvous`);
      } else {
        try {
          await this.subIntention(['go_to', x, y]);
        } catch (err) {
          console.log(`[${me.name}] ✘ rendezvous unreachable → abort handoff`);
          return false;  // bail softly
        }
      }

      if (me.id === from) {
        for (const id of ids) {
          console.log(`[${me.name}] ▶ putdown ${id}`);
          await client.emitPutdown();
        }
      } else {
        for (const id of ids) {
          console.log(`[${me.name}] ▶ pickup ${id}`);
          await client.emitPickup();
        }
      }

      client.emitSay(teamMateId, {
        action:  'handoff_done',
        from, x, y,
        parcels: ids
      });
    } catch (err) {
      console.log("[HANDOFF] Exception:", err);
      throw err;
    } finally {
      state = STATE_IDLE;
    }
    return true;
  }
}

planLibrary.push(GoPickUp);
planLibrary.push(Patrolling)
planLibrary.push(GoDeliver);
planLibrary.push(AstarMove);
planLibrary.push(BulkCollect);
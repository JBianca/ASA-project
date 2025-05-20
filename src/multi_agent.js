import { DeliverooApi, ioClientSocket, sleep } from "@unitn-asa/deliveroo-js-client";
import config from "../config.js";
import AStarDaemon from "./astar_daemon.js";
import { distance, pickOldestSector, markSector, SECTOR_SIZE } from './utils.js';
import selectOptimalBatch from "./select_batch.js";
import { default as argsParser } from "args-parser";

const args = argsParser(process.argv);
const teamMateId = args['teamId'];
var currentIntention = null;
var pickupCoordination = {};

const client = new DeliverooApi(
  config.host,
  config.token
);

let PENALTY;
let DECAY_INTERVAL_MS;

const CONTEST_RADIUS = 3;         // Manhattan distance threshold
const CONTEST_PENALTY = 0.5;      // 50% discount on contested parcels
const MAX_SECTORS_TO_TRY = 5;
const MAX_TILES_PER_SECTOR = 10;
const SCOUT_STEPS = 5;            // scouting steps around parcel-spawning tiles

const suspendedDeliveries = new Set();

client.onConfig(cfg => {
  PENALTY = cfg.PENALTY;
  DECAY_INTERVAL_MS = parseInt(cfg.PARCEL_DECADING_INTERVAL) * 1000;
});

const me = {id: null, name: null, x: null, y: null, score: null};

client.onYou(({id, name, x, y, score}) => {
    me.id = id;
    me.name = name;
    // console.log(`[${name}] Connected with ID: ${id}`);
    me.x = x;
    me.y = y;
    me.score = score;
});

// add function to exchange message between teammate
client.onMsg(async (id, name, msg, reply) => {
  //console.log(`Received message from ${name}:`, msg);
  if (msg?.action === 'pickup') {
    await sleep(Math.random() * 50); // Random delay to avoid race conditions
    if (reply) {
      try {
        if (pickupCoordination[msg.parcelId] === me.id) {
          console.log("Replying NO: I'm already picking up parcel", msg.parcelId);
          reply(false);
        } else if (pickupCoordination[msg.parcelId] === id || !pickupCoordination[msg.parcelId]) {
          console.log("Replying YES: Teammate can pick up parcel", msg.parcelId);
          pickupCoordination[msg.parcelId] = id;
          reply(true);
        }
      } catch (error) {
        console.error(error);
      }
    }
  }
});

const parcels = new Map();
client.onParcelsSensing(async (pp) => {
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

  // 3) Cleanup suspendedDeliveries
  for (const id of Array.from(suspendedDeliveries)) {
    if (!parcels.has(id)) {
      // it was delivered, stolen, or decayed away
      suspendedDeliveries.delete(id);
      // console.log('[unsuspend]', id);
    }
  }

  // 4) Try to coordinate pickup ---
  if (pp.length > 0 && !currentIntention) {
    // Select best available unassigned parcel (by utility)
    const candidates = pp.filter(p => !pickupCoordination[p.id]);
    if (candidates.length === 0) return;

    // sort by expectedUtility
    candidates.sort((a, b) => {
      const utilA = parcels.get(a.id)?.expectedUtility || 0;
      const utilB = parcels.get(b.id)?.expectedUtility || 0;
      return utilB - utilA;
    });

    const parcel = candidates[0];
    console.log('[coordination] Trying for parcel', parcel.id);

    const reply = await client.emitAsk(teamMateId, {
      action: 'pickup',
      parcelId: parcel.id
    });

    if (reply) {
      // I'm authorized
      if (!pickupCoordination[parcel.id]) {
        pickupCoordination[parcel.id] = client.id;
        console.log(`[coordination] I'm assigned to pick up parcel ${parcel.id}`);
      }
    } else {
      console.log(`[coordination] Teammate ${teamMateId} will pick up parcel ${parcel.id}`);
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
});

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

function optionsGeneration() {
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
          void 0
          // console.log(...args);
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
    _intention_queue = [];
    get intention_queue() {
        return this._intention_queue;
    }

    async loop() {
        while (true) {
            if (this.intention_queue.length > 0) {
                const intention = this.intention_queue[0];
                let id = intention.predicate[3];
                let p = parcels.get(id);
                if (p && p.carriedBy) {
                    continue;
                }
                await intention.achieve().catch(() => {});
                this.intention_queue.shift();
            } else {
              // queue empty → pick a new intention immediately
              optionsGeneration();
            }
            await new Promise(res => setImmediate(res));
        }
    }

    log(...args) {
        // console.log(...args);
    }
}

class IntentionRevisionReplace extends IntentionRevision {
  // Keep track when the last intention was added
  #lastPushTime = 0;

  // Do not add new intention more than once in - second
  COOLDOWN_MS = 1000; // 1 second cooldown

   /**
   * Add a new goal  to the list.
   * If it's the same as the last one, or if it's too soon, do nothing.
   */
  async push(predicate) {
    // Less than 1 second since the last push, skip it
    if (Date.now() - this.#lastPushTime < this.COOLDOWN_MS) return;

    // Update the last push time to now
    this.#lastPushTime = Date.now();

    // Get the most recent intention from the list
    const last = this.intention_queue.at(-1);

    // If the new goal is exactly the same as the last one, skip it
    if (last && last.predicate.join(' ') == predicate.join(' ')) return;

    // Create and push a new intention
    const intention = new Intention(this, predicate);
    this.intention_queue.push(intention);

    // If there was a previous intention, stop it so we only follow one at a time
    if (last) last.stop();
  }

  
  // If the agent hasn't done anything for too long, it resets intentions to recover
  async loop() {
    const STUCK_THRESHOLD = 3000; // 3 seconds of inactivity before reset
    let lastActionTime = Date.now();

    while (true) {
      // If too much time has passed without any change, assume we're stuck and clear intentions
      if (Date.now() - lastActionTime > STUCK_THRESHOLD) {
        console.log('Force resetting intentions due to inactivity');
        this._intention_queue = [];
        optionsGeneration(); // regenerate available options
      }

      // Reset the timer 
      lastActionTime = Date.now();

      // Allow the rest of the program to run
      await new Promise(res => setImmediate(res));
    }
  }
}

const myAgent = new IntentionRevisionReplace();
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
            void O
            // console.log(...args);
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

    // Check if the parcel is already assigned
    if (pickupCoordination[id] && pickupCoordination[id] !== me.id) {
      this.log(`Parcel ${id} is handled by teammate. Skipping.`);
      parcels.delete(id);
      suspendedDeliveries.delete(id);
      throw ['stopped'];
    }

    // Request pickup permission from the teammate
    const reply = await client.emitAsk(teamMateId, {
      action: 'pickup',
      parcelId: id
    });

    if (!reply) {
      this.log(`Teammate denied pickup for ${id}. Aborting.`);
      pickupCoordination[id] = teamMateId; // Assign to teammate
      parcels.delete(id);
      suspendedDeliveries.delete(id);
      throw ['stopped'];
    }

    // Assign the parcel to self
    pickupCoordination[id] = me.id;

    // 0) already standing on the target?
    if (me.x === x && me.y === y) {
      this.log(`GoPickUp: already on parcel ${id}, attempting pickup`);
      const ok = await client.emitPickup();
      if (!ok) {
        this.log(`GoPickUp: no parcel ${id} here → removing`);
        parcels.delete(id);
        suspendedDeliveries.delete(id);
        throw ['stopped'];
      }
      // success!
      parcels.delete(id);
      suspendedDeliveries.delete(id);
      return true;
    }

    // 1) otherwise walk to it once
    try {
      this.log(`GoPickUp → moving to parcel ${id} @(${x},${y})`);
      await this.subIntention(['go_to', x, y]);
    } catch {
      this.log(`GoPickUp: parcel ${id} unreachable — removing`);
      parcels.delete(id);
      suspendedDeliveries.delete(id);
      throw ['stopped'];
    }

    // 2) try the pickup
    this.log(`GoPickUp → picking up parcel ${id}`);
    const ok = await client.emitPickup();
    if (!ok) {
      this.log(`GoPickUp: pickup failed for ${id} — removing`);
      parcels.delete(id);
      suspendedDeliveries.delete(id);
      throw ['stopped'];
    }

    // 3) success!
    parcels.delete(id);
    suspendedDeliveries.delete(id);
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
          this.log(`  GoDeliver: blocked at (${dz.x},${dz.y}) on attempt ${attempt}`);
        }
      }
      this.log(`  GoDeliver: giving up on zone (${dz.x},${dz.y}), trying next`);
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
      const [sx, sy] = pickOldestSector();
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
          this.log(`  Patrolling: (${x},${y}) blocked, retrying…`);
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

class AstarMove extends Plan {
  static isApplicableTo(goal, x, y) {
    return goal === 'go_to';
  }

  async execute(goal, targetX, targetY) {
    const MAX_RETRIES = 4;              // Max times to replan the full path
    const Max_LOCK_WAIT = 4;            // Max num of short waits if a tile is locked
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
          return Math.abs(n.x - targetX) + Math.abs(n.y - targetY) + (tile?.locked ? 15 : 0);
        }
      );

      if (!plan || plan === 'failure' || plan.length === 0) {
        this.log(`AstarMove: No path to (${targetX}, ${targetY}) [retry ${retries + 1}]`);
        retries++;
        await sleep(300 + Math.random() * 200); // Prevent sync retries
        continue;
      }

      for (const step of plan) {
        if (this.stopped) throw ['stopped'];

        const tileKey = `${step.x},${step.y}`;
        const tile = mapTiles.get(tileKey);

        // Wait a few cycles if the tile is locked
        let lockWaits = 0;
        while (tile?.locked && lockWaits++ < MAX_LOCK_WAIT) {
          await sleep(30 + Math.random() * 50);
        }

        // If still locked, penalize tile and continue with the rest of the plan
        if (tile?.locked) {
          aStarDaemon.addTempPenalty(step.x, step.y, 10);
          await sleep(30 + Math.random() * 50);
          continue;
        }

        try {
          const beforeX = me.x;
          const beforeY = me.y;

          // If coordination assignment was lost, skip this step
          if (pickupCoordination[id] !== me.id) {
            this.log('Coordination lost → skipping move, not aborting');
            await sleep(100); // Let coordination resolve
            continue;
          }

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
        await this.subIntention(['go_to', p.x, p.y]);
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



planLibrary.push(GoPickUp);
planLibrary.push(Patrolling)
planLibrary.push(GoDeliver);
planLibrary.push(AstarMove);
planLibrary.push(BulkCollect)

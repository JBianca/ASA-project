import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import config from "../config.js";
import AStarDaemon from "./astar_daemon.js";
import { distance, pickOldestSector, markSector, SECTOR_SIZE } from './utils.js';
import selectOptimalBatch from "./select_batch.js";

const client = new DeliverooApi(
  config.host,
  config.token
);

let PENALTY;
let DECAY_INTERVAL_MS;

const CONTEST_RADIUS = 3;    // Manhattan distance threshold
const CONTEST_PENALTY = 0.5;  // 50% discount on contested parcels
const MAX_SECTORS_TO_TRY = 5;
const MAX_TILES_PER_SECTOR = 10;

const suspendedDeliveries = new Set();

client.onConfig(cfg => {
  PENALTY = cfg.PENALTY;
  DECAY_INTERVAL_MS = parseInt(cfg.PARCEL_DECADING_INTERVAL) * 1000;
});

const me = {id: null, name: null, x: null, y: null, score: null};

client.onYou(({id, name, x, y, score}) => {
    me.id = id;
    me.name = name;
    me.x = x;
    me.y = y;
    me.score = score;
});

const parcels = new Map();
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

  // 3) Finally, if any suspended deliveries are no longer carriedBy you at all,
  //    un-suspend them (they must’ve been dropped elsewhere).
  const stillCarried = new Set(
    pp.filter(p => p.carriedBy === me.id).map(p => p.id)
  );
  for (const id of suspendedDeliveries) {
    if (!stillCarried.has(id)) {
      suspendedDeliveries.delete(id);
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
});

const aStarDaemon = new AStarDaemon(mapTiles);

function optionsGeneration() {
  // if the *current* intention is BulkCollect, do nothing (don't replan!)
  const current = myAgent.intention_queue[0];
  if (current?.predicate[0] === 'bulk_collect') {
    return;
  }

  const options   = [];
  const carried = [...parcels.values()]
    .find(p => p.carriedBy === me.id && !suspendedDeliveries.has(p.id));
  const available = [...parcels.values()].filter(p => !p.carriedBy);

  // 1) If you're carrying something, go deliver.
  if (carried && deliveryZones.length) {
    const dz = deliveryZones.reduce((a, b) =>
      distance(me, a) < distance(me, b) ? a : b
    );
    options.push(['go_deliver', dz.x, dz.y]);
  }
  else if (available.length > 0) {
    // 2) Compute the optimal batch (size up to 3)
    // TODO: think about how to set this dynimically?
    const { netUtil, route } = selectOptimalBatch(
      available,
      { x: me.x, y: me.y },
      deliveryZones,
      aStarDaemon,
      PENALTY,
      DECAY_INTERVAL_MS/1000,
      /*maxK=*/3
    );

    if (route.length > 1) {
      // multi‐pickup run
      // pass the parcel IDs as arguments
      options.push(['bulk_collect', ...route.map(p => p.id)]);
    }
    else {
      // single‐pickup run
      const p = route[0];
      options.push(['go_pick_up', p.x, p.y, p.id]);
    }
  }
  else {
    // 3) Nothing to do: patrol
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

class IntentionRevision {
    #intention_queue = [];
    get intention_queue() {
        return this.#intention_queue;
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
            }
            await new Promise(res => setImmediate(res));
        }
    }

    log(...args) {
        console.log(...args);
    }
}

class IntentionRevisionReplace extends IntentionRevision {
    async push(predicate) {
        const last = this.intention_queue.at(-1);
        if (last && last.predicate.join(' ') == predicate.join(' ')) return;
        const intention = new Intention(this, predicate);
        this.intention_queue.push(intention);
        if (last) last.stop();
    }
}

const myAgent = new IntentionRevisionReplace();
myAgent.loop();

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

    // If we're already standing on the parcel, pick it up right away.
    if (me.x === x && me.y === y) {
      this.log('GoPickUp: already on parcel, picking up');
      await client.emitPickup();
      if (this.stopped) throw ['stopped'];
      return true;
    }

    try {
      await this.subIntention(['go_to', x, y]);
    } catch (err) {
      this.log(`GoPickUp: parcel ${id} unreachable — discounting & skipping`);
      const p = parcels.get(id);
      if (p) {
        p.expectedUtility = p.expectedUtility * CONTEST_PENALTY;
        parcels.set(id, p);
      }
      throw ['stopped'];
    }

    await client.emitPickup();
    if (this.stopped) throw ['stopped'];

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
          candidates.push({ x, y });
        }
      }
      if (candidates.length === 0) continue;  // weird empty sector

      // try up to MAX_TILES_PER_SECTOR random picks
      for (let tTry = 1; tTry <= MAX_TILES_PER_SECTOR; tTry++) {
        if (this.stopped) throw ['stopped'];

        const { x, y } = candidates[Math.floor(Math.random() * candidates.length)];
        this.log(`Patrolling → sector ${sx},${sy} → attempt ${tTry} @ (${x},${y})`);
        try {
          await this.subIntention(['go_to', x, y]);
          return true;  // success—keep patrolling until you’re stopped externally
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
    async execute(goal, x, y) {
      const h = n => {
        const base = Math.abs(n.x - x) + Math.abs(n.y - y);
        const crowd = Math.min(
          ...[...agents.values()]
            .filter(a => a.id !== me.id)
            .map(a => Math.abs(n.x - a.x) + Math.abs(n.y - a.y))
        );
        return base + 0.2 * (1 / (crowd + 1));  // 0.2? needs to be tweaked/fine-tuned
      };
    
      const plan = aStarDaemon.aStar(
        { x: me.x, y: me.y },
        { x, y },
        h
      );
      // console.log('A* plan =', plan);

      if (plan === 'failure' || !Array.isArray(plan) || plan.length === 0) {
        this.log('AstarMove: no path found → aborting to replan/fallback');
        throw ['stopped']; 
      }
  
      for (const step of plan) {
        if (this.stopped) throw ['stopped'];
  
        // DEBUG
        const key = `${step.x},${step.y}`;
        console.log(
          '→ next step', step,
          'mapTiles.has=', mapTiles.has(key),
          'tile=', mapTiles.get(key)
        );
  
        // locked‐tile check
        const tile = mapTiles.get(key);
        if (tile?.locked) {
          console.log('  aborting because locked → replanning');
          throw ['stopped'];
        }
  
        const status = await client.emitMove(step.action);
        console.log('  emitMove returned', status);
        if (!status) {
          console.log('  blocked by wall or collision → replanning');
          throw ['stopped'];
        }
  
        me.x = status.x;
        me.y = status.y;
      }
  
      return true;
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

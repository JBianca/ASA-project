import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import config from "../config.js";
import AStarDaemon from "./astar_daemon.js";
import { distance } from './utils.js';
import selectOptimalBatch from "./select_batch.js";

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
    // Otherwise upsert with stamps
    const spawnTime     = old ? old.spawnTime     : now;
    const initialReward = old ? old.initialReward : p.reward;

    parcels.set(p.id, {
      ...p,
      lastSeen:      now,
      spawnTime,
      initialReward
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

const mapTiles = new Map();

client.onMap((width, height, tiles) => {
  mapTiles.clear();
  for (const t of tiles) {
    mapTiles.set(`${t.x},${t.y}`, t.type);
  }
});
client.onTile(tile => {
  mapTiles.set(`${tile.x},${tile.y}`, tile.type);
});

// TODO: improve onAgentsSensing
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
});

const aStarDaemon = new AStarDaemon(mapTiles);

function optionsGeneration() {
  // if the *current* intention is BulkCollect, do nothing (don't replan!)
  const current = myAgent.intention_queue[0];
  if (current?.predicate[0] === 'bulk_collect') {
    return;
  }

  const options   = [];
  const carried   = [...parcels.values()].find(p => p.carriedBy === me.id);
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

    await this.subIntention(['go_to', x, y]);
    if (this.stopped) throw ['stopped'];

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
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        if (this.stopped) throw ['stopped'];
        await client.emitPutdown();
        if (this.stopped) throw ['stopped'];
        return true;
    }
}

class Patrolling extends Plan {
    static isApplicableTo(goal) {
      return goal === 'patrolling';
    }
  
    async execute(goal) {
      if (this.stopped) throw ['stopped'];
  
      // Pick a random tile key from mapTiles
      const keys = Array.from(mapTiles.keys());
      if (keys.length === 0) throw ['no map'];
  
      // Random index
      const rndKey = keys[Math.floor(Math.random() * keys.length)];
      const [x, y] = rndKey.split(',').map(Number);
  
      this.log('Patrolling → wandering to', { x, y });
      // Delegate to go_to/A* mechanism
      await this.subIntention(['go_to', x, y]);
  
      if (this.stopped) throw ['stopped'];
      return true;
    }
}  

class AstarMove extends Plan {
    static isApplicableTo(goal, x, y) {
      return goal === 'go_to';
    }
    async execute(goal, x, y) {
      this.log('AstarMove from', me.x, me.y, 'to', { x, y });

      // SHORT‑CIRCUIT IF YOU'RE ALREADY ON TARGET
      if (me.x === x && me.y === y) {
        this.log('AstarMove: start===goal, nothing to do');
        return true;
      }
  
      const start = { x: me.x, y: me.y };
      const goalNode = { x, y };
      const h = n => Math.abs(n.x - x) + Math.abs(n.y - y);  // Manhattan distance
  
      const plan = aStarDaemon.aStar(start, goalNode, h);
      if (plan === "failure" || plan.length === 0) {
        throw 'target not reachable';
      }
  
      for (const step of plan) {
        if (this.stopped) throw ['stopped'];
        const status = await client.emitMove(step.action);
        if (!status) {
          this.log('AstarMove replanning from', me.x, me.y);
          break;
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
        this.log('BulkCollect: pickup failed for', p.id, ', aborting rest');
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

class BlindMove extends Plan {
    static isApplicableTo(goal, x, y) {
      return goal === 'go_to';
    }
  
    async execute(goal, x, y) {
      this.log('BlindMove from', me.x, me.y, 'to', { x, y });
      // track where we came from, so we don't immediately step back
      let prevPos = null;
  
      // keep going until we reach the exact target
      outer: while (me.x !== x || me.y !== y) {
        if (this.stopped) throw ['stopped'];
  
        // capture current pos so after a successful move we can set prevPos
        const curr = { x: me.x, y: me.y };
  
        // 1) preferred directions toward target
        const dirAttempts = [];
        if (x > me.x) dirAttempts.push('right');
        if (x < me.x) dirAttempts.push('left');
        if (y > me.y) dirAttempts.push('up');
        if (y < me.y) dirAttempts.push('down');
  
        // 2) fallback: all four directions, in a fixed but secondary order
        for (const d of ['up','down','left','right']) {
          if (!dirAttempts.includes(d)) dirAttempts.push(d);
        }
  
        // 3) prune out the move that would take us back to prevPos
        if (prevPos) {
          for (let i = dirAttempts.length-1; i >= 0; i--) {
            const move = dirAttempts[i];
            let nx = me.x + (move === 'right' ? 1 : move === 'left' ? -1 : 0);
            let ny = me.y + (move === 'up' ? 1 : move === 'down' ? -1 : 0);
            if (nx === prevPos.x && ny === prevPos.y) {
              dirAttempts.splice(i, 1);
            }
          }
        }
  
        // 4) try each remaining direction
        for (const move of dirAttempts) {
          const status = await client.emitMove(move);
          if (status) {
            // success! record where we came from, update me, and re‑loop
            prevPos = curr;
            me.x = status.x;
            me.y = status.y;
            continue outer;
          }
        }
  
        // 5) none worked → truly stuck
        this.log('stuck at', me, 'cannot move toward', { x, y });
        throw 'stuck';
      }
  
      return true;
    }
  }  
  

planLibrary.push(GoPickUp);
planLibrary.push(Patrolling)
planLibrary.push(GoDeliver);
planLibrary.push(AstarMove);
planLibrary.push(BulkCollect)
//planLibrary.push(BlindMove);
import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import { planner, goalParser, mapParser, readDomain } from "./pddl_planner.js"; // Add PDDL imports
import { distance } from './utils.js';

// Initialize PDDL Domain
readDomain().then(() => console.log("Domain loaded")).catch(console.error);

const client = new DeliverooApi(
  "http://localhost:8080/",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImNjMmUxOSIsIm5hbWUiOiJhIiwidGVhbUlkIjoiMjgwMmYzIiwidGVhbU5hbWUiOiJkaXNpIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NDI5ODA3NTh9.q9cmPHitmC5oiVHbk5VUJPuA2B89sLC6DYIWDheB7cM"
);

let PENALTY;
let DECAY_INTERVAL_MS;

const MAX_TRIES = 3;
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

const mapTiles = new Map();

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

client.onMap((width, height, tiles) => {
  deliveryZones.length = 0;
  mapTiles.clear();
  const matrix = Array(height).fill().map(() => Array(width).fill(0));
  tiles.forEach(tile => {
    matrix[tile.y][tile.x] = tile.type;
    if (tile.type === 2) deliveryZones.push({ x: tile.x, y: tile.y });
    mapTiles.set(`${tile.x},${tile.y}`, { type: tile.type, locked: false });
  });
  mapParser(matrix);
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
});

function optionsGeneration() {
  const options = [];

  // Find the parcel currently carried by the agent (if any)
  const carriedParcel = [...parcels.values()].find(p => p.carriedBy === me.id);

  // Get the list of parcels that are available (not being carried)
  const availableParcels = [...parcels.values()].filter(p => !p.carriedBy);

  // CASE 1: No available parcels to pick up
  if (availableParcels.length === 0) {

    // If the agent is carrying a parcel and there are delivery zones, plan to deliver
    if (carriedParcel && deliveryZones.length > 0) {
      const closestDeliveryZone = deliveryZones.reduce((a, b) =>
        distance(me, a) < distance(me, b) ? a : b
      );
      options.push(['go_deliver', closestDeliveryZone.x, closestDeliveryZone.y]);

    // Otherwise, move randomly to explore the map
    } else {
      const directions = ['up', 'down', 'left', 'right'];
      const dir = directions[Math.floor(Math.random() * directions.length)];
      const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
      const dy = dir === 'up' ? 1 : dir === 'down' ? -1 : 0;
      options.push(['go_to', me.x + dx, me.y + dy]);
    }

  // CASE 2: There are parcels available
  } else {
    // Find the closest available parcel
    const closestParcel = availableParcels.reduce((a, b) =>
      distance(me, a) < distance(me, b) ? a : b
    );

    // Find the closest delivery zone
    const closestDeliveryZone = deliveryZones.reduce((a, b) =>
      distance(me, a) < distance(me, b) ? a : b
    );

    // If the agent is carrying a parcel, decide whether to deliver or pick up another
    if (carriedParcel && deliveryZones.length > 0) {
      if (distance(me, closestDeliveryZone) < distance(me, closestParcel)) {
        options.push(['go_deliver', closestDeliveryZone.x, closestDeliveryZone.y]);
      } else {
        options.push(['go_pick_up', closestParcel.x, closestParcel.y, closestParcel.id]);
      }
    // If the agent is not carrying anything, go pick up the closest parcel
    } else {
      options.push(['go_pick_up', closestParcel.x, closestParcel.y, closestParcel.id]);
    }
  }

  // Choose the best option (with the minimum distance to execute)
  let best_option;
  let nearest = Number.MAX_VALUE;
  for (const option of options) {
    let [, x, y] = option;
    let d = distance({ x, y }, me);
    if (d < nearest) {
      best_option = option;
      nearest = d;
    }
  }

  // Add the chosen option to the agent's intention queue
  if (best_option) myAgent.push(best_option);
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

// Plan that executes high-level goals using a PDDL planner
class PddlPlan extends Plan {

  // Determines whether this plan can handle the given goal
  static isApplicableTo(goal) {
    return ['go_pick_up', 'go_deliver', 'go_to'].includes(goal);
  }

  // Executes the plan for the given goal
  async execute(goal, ...args) {
    console.log("Executing PDDL plan:", goal);
    let pddlGoal;

    // Get parcels currently carried by the agent
    const carried = [...parcels.values()].filter(p => p.carriedBy === me.id);

    // Construct the PDDL goal depending on the type
    switch(goal) {
      case 'go_pick_up': {
        const [,,id] = args;
        const parcel = parcels.get(id);
        if (!parcel || parcel.carriedBy) throw "Parcel unavailable";
        pddlGoal = goalParser('go_pick_up', { id }, me.id);
        break;
      }
      case 'go_deliver': {
        pddlGoal = goalParser('go_deliver', carried, me.id);
        break;
      }
      case 'go_to': {
        const [x,y] = args;
        pddlGoal = `(at me_${me.id} c_${x}_${y})`;
        break;
      }
    }

    // Generate the plan using the planner
    const plan = await planner(parcels, agents, me, pddlGoal);
    if (!plan || plan.length === 0) throw "Empty plan";

    // Execute each action in the plan step-by-step
    for (const action of plan) {
      if (this.stopped) throw "Aborted";  // Stop if the plan is aborted

      const actionLower = action.toLowerCase();
      console.log("action: ", actionLower);

      try {
        if (['up','down','left','right'].includes(actionLower)) {
          // Handle movement
          const currentPos = {x: me.x, y: me.y};
          const newPos = this.calculateNewPosition(actionLower, currentPos);
          const tile = mapTiles.get(`${newPos.x},${newPos.y}`);
          if (!tile || tile.type === 0) throw `Blocked move: ${actionLower}`;
          const success = await client.emitMove(actionLower);
          me.x = newPos.x;
          me.y = newPos.y;

        } else if (actionLower === 'pickup') {
          // Handle pickup
          const parcelHere = [...parcels.values()].find(p => p.x === me.x && p.y === me.y && !p.carriedBy);
          if (!parcelHere) throw "No parcel to pickup";
          await client.emitPickup();

        } else if (actionLower === 'putdown') {
          // Handle putdown
          if (!deliveryZones.some(dz => dz.x === me.x && dz.y === me.y)) throw "Not in delivery zone";
          await client.emitPutdown();
        }

        // Add delay between actions
        await new Promise(resolve => setTimeout(resolve, 50));

      } catch (error) {
        throw "Plan execution failed";
      }
    }

    return true; // Plan executed successfully
  }

  // Computes new position based on direction
  calculateNewPosition(action, currentPos) {
    return {
      up: {x: currentPos.x, y: currentPos.y + 1},
      down: {x: currentPos.x, y: currentPos.y - 1},
      left: {x: currentPos.x - 1, y: currentPos.y},
      right: {x: currentPos.x + 1, y: currentPos.y}
    }[action];
  }
}

// Simpler plan to go directly to a parcel and pick it up, without PDDL
class DirectPickup extends Plan {

  // Determines applicability of this plan (only for pickup)
  static isApplicableTo(goal) {
    return goal === 'go_pick_up';
  }

  // Executes a direct move and pickup sequence
  async execute(goal, x, y, id) {
    // If agent is already on the parcel, just pick it up
    if (me.x === x && me.y === y) {
      await client.emitPickup();
      return true;
    }

    // Otherwise, go to the parcel location then pick it up
    await this.subIntention(['go_to', x, y]);
    await client.emitPickup();
    return true;
  }
}

planLibrary.push(PddlPlan, DirectPickup, GoPickUp, GoDeliver, BlindMove);

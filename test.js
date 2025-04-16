import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

const client = new DeliverooApi(
    'https://deliveroojs2.rtibdi.disi.unitn.it/',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjM5YmNjNyIsIm5hbWUiOiJ0ZXN0Iiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NDQ1NjEyOTV9.Mi2d3S9iKSGjXg7kmhetPWFylPadF6FsIVGWFjQWD9o'
);

function distance({x:x1, y:y1}, {x:x2, y:y2}) {
    const dx = Math.abs(Math.round(x1) - Math.round(x2));
    const dy = Math.abs(Math.round(y1) - Math.round(y2));
    return dx + dy;
}

const me = {id: null, name: null, x: null, y: null, score: null};

client.onYou(({id, name, x, y, score}) => {
    me.id = id;
    me.name = name;
    me.x = x;
    me.y = y;
    me.score = score;
});

const parcels = new Map();

client.onParcelsSensing((pp) => {
    for (const p of pp) {
        parcels.set(p.id, p);
    }
    for (const p of parcels.values()) {
        if (pp.map(p => p.id).find(id => id == p.id) == undefined) {
            parcels.delete(p.id);
        }
    }
});

const deliveryZones = [];

client.onTile((tile) => {
    if (tile.type === 2) deliveryZones.push({ x: tile.x, y: tile.y });
});

// function optionsGeneration() {
//     const options = [];
//     let hasNewParcels = false;
//     let carriedParcel = [...parcels.values()].find(p => p.carriedBy === me.id);

//     if (carriedParcel && deliveryZones.length > 0) {
//         // Check for the closest delivery zone
//         const closestDeliveryZone = deliveryZones.reduce((a, b) =>
//             distance(me, a) < distance(me, b) ? a : b
//         );
        
//         // Find the closest parcel to pick up (only if there are parcels available)
//         const closestParcel = [...parcels.values()]
//             .filter(p => !p.carriedBy);
        
//         // Only proceed if there are parcels to pick up
//         let nearestParcel;
//         if (closestParcel.length > 0) {
//             nearestParcel = closestParcel.reduce((a, b) =>
//                 distance(me, a) < distance(me, b) ? a : b
//             );
//         }

//         // If the closest delivery zone is closer, prioritize delivery
//         if (nearestParcel && distance(me, closestDeliveryZone) < distance(me, nearestParcel)) {
//             options.push(['go_deliver', closestDeliveryZone.x, closestDeliveryZone.y]);
//         } else {
//             // Otherwise, go pick up a parcel
//             for (const parcel of parcels.values()) {
//                 if (!parcel.carriedBy) {
//                     hasNewParcels = true;
//                     options.push(['go_pick_up', parcel.x, parcel.y, parcel.id]);
//                 }
//             }
//         }
//     } else {
//         // If not carrying any parcel, pick up new parcels
//         for (const parcel of parcels.values()) {
//             if (!parcel.carriedBy) {
//                 hasNewParcels = true;
//                 options.push(['go_pick_up', parcel.x, parcel.y, parcel.id]);
//             }
//         }
//     }

//     let best_option;
//     let nearest = Number.MAX_VALUE;
//     for (const option of options) {
//         let [, x, y] = option;
//         let d = distance({x, y}, me);
//         if (d < nearest) {
//             best_option = option;
//             nearest = d;
//         }
//     }

//     if (best_option)
//         myAgent.push(best_option);
// }

function optionsGeneration() {
    const options = [];

    const carriedParcel = [...parcels.values()].find(p => p.carriedBy === me.id);
    const availableParcels = [...parcels.values()].filter(p => !p.carriedBy);

    // Se non ci sono pacchi visibili
    if (availableParcels.length === 0) {
        if (carriedParcel && deliveryZones.length > 0) {
            // Vai a consegnare
            const closestDeliveryZone = deliveryZones.reduce((a, b) =>
                distance(me, a) < distance(me, b) ? a : b
            );
            options.push(['go_deliver', closestDeliveryZone.x, closestDeliveryZone.y]);
        } else {
            // Esplora a caso
            const directions = ['up', 'down', 'left', 'right'];
            const dir = directions[Math.floor(Math.random() * directions.length)];
            const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
            const dy = dir === 'up' ? 1 : dir === 'down' ? -1 : 0;
            options.push(['go_to', me.x + dx, me.y + dy]);
        }
    } else {
        const closestParcel = availableParcels.reduce((a, b) =>
            distance(me, a) < distance(me, b) ? a : b
        );
        const closestDeliveryZone = deliveryZones.reduce((a, b) =>
            distance(me, a) < distance(me, b) ? a : b
        );

        if (carriedParcel && deliveryZones.length > 0) {
            if (distance(me, closestDeliveryZone) < distance(me, closestParcel)) {
                options.push(['go_deliver', closestDeliveryZone.x, closestDeliveryZone.y]);
            } else {
                options.push(['go_pick_up', closestParcel.x, closestParcel.y, closestParcel.id]);
            }
        } else {
            options.push(['go_pick_up', closestParcel.x, closestParcel.y, closestParcel.id]);
        }
    }

    // Seleziona l'opzione più vicina
    let best_option;
    let nearest = Number.MAX_VALUE;
    for (const option of options) {
        let [, x, y] = option;
        let d = distance({x, y}, me);
        if (d < nearest) {
            best_option = option;
            nearest = d;
        }
    }

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

    async execute(goal, x, y) {
        if (this.stopped) throw ['stopped'];
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

class BlindMove extends Plan {
    static isApplicableTo(goal, x, y) {
        return goal === 'go_to';
    }

    async execute(goal, x, y) {
        while (me.x !== x || me.y !== y) {
            if (this.stopped) throw ['stopped'];

            let moved;
            if (x > me.x) moved = await client.emitMove('right');
            else if (x < me.x) moved = await client.emitMove('left');
            if (moved) {
                me.x = moved.x;
                me.y = moved.y;
                continue;
            }

            if (y > me.y) moved = await client.emitMove('up');
            else if (y < me.y) moved = await client.emitMove('down');
            if (moved) {
                me.x = moved.x;
                me.y = moved.y;
                continue;
            }

            this.log('stuck');
            throw 'stuck';
        }
        return true;
    }
}

planLibrary.push(GoPickUp);
planLibrary.push(GoDeliver);
planLibrary.push(BlindMove);
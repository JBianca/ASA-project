import fs from 'fs';
import { onlineSolver, PddlProblem, Beliefset } from "@unitn-asa/pddl-client";
import chalk from 'chalk';


// Note: 
// open the file
// /node_modules/@unitn-asa/pddl-client/src/PddlProblem.js
// go the the function
// pddlProblem.toPddlString()
// change it to 
            // toPddlString() {
            //     return `\
            // ;; problem file: ${this.name}.pddl
            // (define (problem default)
            // (:domain default)
            // (:objects ${this.objects})
            // (:init ${this.inits})
            // (:goal ${this.goals})
            // )
            // `
// eliminate the extra parenthesis in the goal


// Agent action
const GO_DELIVER = "go_deliver";
const GO_PICK_UP = "go_pickup";
const GO_TO = "go_to";

// Variable to store the map
const beliefMap = new Beliefset();
var domain;
var mapObjects = "";

// Read and store domain.pddl file
async function readDomain() {
    domain = await new Promise((res, rej) => {
        fs.readFile('planner/domain.pddl', 'utf8', (err, data) => {
            if (err) rej(err)
            else res(data)
        })
    })
}

// Parse the beliefMap objects and store them in mapObjects with type -c (cell)
function mapObjectParser(){
    for (const o of beliefMap.objects){
        mapObjects += o + " ";
    }
    mapObjects += "c_default_default -c";
}

// Check neighbour cells of the one called
function checkNeighbour(x, y, map) {
    const neighbours = [
        { id: "Left", dx: -1, dy: 0 },  
        { id: "Right", dx: 1, dy: 0 },
        { id: "Up", dx: 0, dy: 1 },
        { id: "Down", dx: 0, dy: -1 },
    ]

    for (const neighbour of neighbours){
        const neighbourX = x + neighbour.dx;
        const neighbourY = y + neighbour.dy;
        if (neighbourX >= 0 && neighbourX < map.length && neighbourY >= 0 && neighbourY < map.length) {
            if ((map[neighbourX][neighbourY] != 0) && map[x][y] != 0) {
                beliefMap.declare("neighbour" + neighbour.id + " c_" + x + "_" + y + " c_" + neighbourX + "_" + neighbourY);
            }
        }
    }
}

// Parse the matrix and add the beliefs to the map beliefs
function mapParser(map){
    for(let i=0; i<map.length; i++){
        for(let j=0; j<map.length; j++){
            switch(map[i][j]){
                case 0:
                    beliefMap.declare("is-blocked c_" + i + "_" + j);
                    break;
                case 1:
                    checkNeighbour(i, j, map);
                    break;    
                case 2:
                    beliefMap.declare("is-delivery c_" + i + "_" + j);
                    checkNeighbour(i, j, map);
                    break;
                case 3: // Walkable but not for pickup or delivery
                    checkNeighbour(i, j, map);
                    break;
                default:
                    break;
            }
        }
    }
    mapObjectParser();
}

// Parse the parcels and add them to the beliefSet
function parcelsParser(parcels, me, beliefs){
    if(parcels.size == 0){
        beliefs.declare("in p_default c_default_default");
    }else{
        parcels.forEach(parcel => {
            if(parcel.carriedBy == me.id){
                beliefs.declare("holding me_" + me.id + " p_" + parcel.id);
            }else if(!parcel.carriedBy){
                beliefs.declare("in p_" + parcel.id + " c_" + parcel.x + "_" + parcel.y);
            }
        });
    }
}

// Parse the agents and add them to the beliefSet
function agentsParser(agents, beliefs){
    if(agents.size == 0){
        beliefs.declare("occ a_default c_default_default");
    }else{
        agents.forEach(agent => {
            beliefs.declare("occ a_" + agent.id + " c_" + agent.x + "_" + agent.y)
        });
    }
}

// Parse the goal string into pddl format
function goalParser(desire, args, me, logicType = "and") {
    let goal = "";

    if (desire === GO_PICK_UP && args) {
        goal = `(holding me_${me.id} p_${args.id})`;

    } else if (desire === GO_DELIVER && args) {
        if (args.length === 1) {
            goal = `(delivered p_${args[0].id})`;
        } else if (args.length > 1) {
            if (logicType !== "and" && logicType !== "or") {
                throw new Error("Invalid logicType: must be 'and' or 'or'");
            }
            goal = `(${logicType}`;
            for (const a of args) {
                goal += ` (delivered p_${a.id})`;
            }
            goal += ")";
        }

    } else if (desire === GO_TO && args) {
        goal = `(at me_${me.id} c_${args.x}_${args.y})`;
    }

    return goal || null;
}

// Parse the objects in the beliefSet used to add typing to the objects
function objectsParser(beliefs){
    var objects = "    ";
    var previous = [...beliefs.objects][0].split("_")[0];

    for(const o of beliefs.objects){
        var type = o.split("_")[0];
        if(type != "c"){
            if(type != previous){
                objects += "- " + previous + "\n";
                objects += "    " + o + " ";
                previous = type;
            }else{
                objects += o + " ";
            }
        }
    }
    objects += "- " + previous + " ";
    return objects;
}

// Extract only the action names from the planner output
function planParser(plan) {
    return plan.map(p => p.action);
}

// Planner function: builds a PDDL problem, solves it, and returns a plan
async function planner(parcels, agents, me, goal) {
    
    if (!goal || goal.trim() === "") {
        console.log(chalk.yellow("No goal specified, planning aborted."));
        return null;
    }

    let beliefs = new Beliefset();

    parcelsParser(parcels, me, beliefs);
    agentsParser(agents, beliefs);
    beliefs.declare("at me_" + me.id + " c_" + me.x + "_" + me.y);
   
    let pddlProblem = new PddlProblem(
        'Dev-livery',
        mapObjects + "\n" + objectsParser(beliefs),
        beliefMap.toPddlString() + " " + beliefs.toPddlString(),
        goal
    );

    let problem = pddlProblem.toPddlString();

    fs.writeFileSync('problem.txt', problem, 'utf8');
    console.log(chalk.green('PDDL problem saved in problem.txt'));

    let plan;
    try {
        plan = await onlineSolver(domain, problem);
    } catch (e) {
        console.log(chalk.red("Error calling the planner:", e));
        return null;
    }

    if (plan == null) {
        console.log(chalk.bold.red("No plan found: goal unreachable."));
        return null;
    }

    return planParser(plan);
}

export { planner, goalParser, mapParser, readDomain };
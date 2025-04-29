import { onlineSolver, PddlExecutor } from "@unitn-asa/pddl-client";
import fs from 'fs';

// used for testing the domain.pddl and problem.pddl

function readFile ( path ) {
    
    return new Promise( (res, rej) => {

        fs.readFile( path, 'utf8', (err, data) => {
            if (err) rej(err)
            else res(data)
        })

    })

}

async function main () {

    let problem = await readFile('./problem.pddl' );
    console.log( problem );
    let domain = await readFile('./domain.pddl' );

    var plan = await onlineSolver(domain, problem);
    console.log( plan );

}

main();
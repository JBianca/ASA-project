// import child_process in ES module
import { spawn } from 'child_process';

// Configuration parameters
const config = {
  contestRadius: 3,         // Manhattan distance threshold
  contestPenalty: 0.5,      // 50% discount on contested parcels
  maxSectorsToTry: 5,
  maxTilesPerSector: 10,
  scoutSteps: 5,            // scouting steps around parcel-spawning tiles
};

const nance = { id: '166aab', name: 'nance',
token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjE2NmFhYiIsIm5hbWUiOiJuYW5jZSIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzQzOTQ4NzkzfQ.ITgFywL_aIusiXJCbtnzpao4Mt1qz_-h4o1Z_aqxxS4'
};

const bianca = { id: '830c2c', name: 'bianca',
token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjgzMGMyYyIsIm5hbWUiOiJ0ZXN0MiIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzQ1MzMyNTQ1fQ.v5PXhRCocKCRWmZav3IO72qcouAsuTe4qjrXlsbGAbw'
};

// Start the processes
spawnProcesses( nance, bianca );
spawnProcesses( bianca, nance ); 

// Function to spawn child processes
function spawnProcesses( me, teamMate ) {

    const args = [
    `token=${me.token}`,
    `teamId=${teamMate.id}`,
    `contestRadius=${config.contestRadius}`,
    `contestPenalty=${config.contestPenalty}`,
    `maxSectorsToTry=${config.maxSectorsToTry}`,
    `maxTilesPerSector=${config.maxTilesPerSector}`,
    `scoutSteps=${config.scoutSteps}`,
  ];
    
    const childProcess = spawn(
        `node multi_agent \
        host="http://localhost:8080" \
        token="${me.token}" \
        teamId="${teamMate.id}" `,
        { shell: true }
    );

    childProcess.stdout.on('data', data => {
        console.log(me.name, '>', data.toString());
    });

    childProcess.stderr.on('data', data => {
        console.error(me.name, '>', data.toString());
    });

    childProcess.on('close', code => {
        console.log(`${me.name}: exited with code ${code}`);
    });

};

// DEBUG=socket.io-client* for debugging messages
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

const nance = { id: 'd2942d', name: 'nance',
token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImQyOTQyZCIsIm5hbWUiOiJuYW5jZSIsInRlYW1JZCI6IjFlYTk4NiIsInRlYW1OYW1lIjoiZGV2Iiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NTE2NTQ1MTJ9.EPfL9dFhPkwaHoTYoW206FxxdGKaThySaECglaqABFw'
};

const bianca = { id: 'f65488', name: 'bianca',
token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImY2NTQ4OCIsIm5hbWUiOiJiaWFuY2EiLCJ0ZWFtSWQiOiJlMWNkNTkiLCJ0ZWFtTmFtZSI6ImRldiIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzUxNjU0NTE4fQ.fh0-un726MBi3BMk1DjX8R8hr2HXRBcuf68wVLbBLfM'
};

// Start the processes
spawnProcesses( nance, bianca );
spawnProcesses( bianca, nance ); 

// Function to spawn child processes
function spawnProcesses( me, teamMate ) {

    const args = [
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
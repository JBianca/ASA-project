// import child_process in ES module
import { spawn } from 'child_process';

const nance = { id: 'e083aa6f59e', name: 'nance',
token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjE2NmFhYiIsIm5hbWUiOiJuYW5jZSIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzQzOTQ4NzkzfQ.ITgFywL_aIusiXJCbtnzpao4Mt1qz_-h4o1Z_aqxxS4'
};

const bianca = { id: '1d74b61b883', name: 'bianca',
token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjgzMGMyYyIsIm5hbWUiOiJ0ZXN0MiIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzQ1MzMyNTQ1fQ.v5PXhRCocKCRWmZav3IO72qcouAsuTe4qjrXlsbGAbw'
};

// Start the processes
spawnProcesses( nance, bianca );
spawnProcesses( bianca, nance ); 

// Function to spawn child processes
function spawnProcesses( me, teamMate ) {
    
    const childProcess = spawn(
        `node 7pickup \
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
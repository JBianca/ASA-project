# BDI Agent System for the Deliveroo Game

Course: Autonomous Software Agents 2024/25 – Artificial Intelligence Systems (Master’s Degree)

This repository contains the implementation of a Belief-Desire-Intention (BDI) agent system designed for the [Deliveroo](https://github.com/unitn-ASA/Deliveroo.js) Game.

# Dependencies installation
```
npm install @unitn-asa/deliveroo-js-client
npm install @unitn-asa/pddl-client
npm install chalk
```

# Setup the environment
Set up the environment for a single agent in the state.js file.
Set up the environment for the multi agent in the spawn_processes.js file

```
host: "https://deliveroojs2.rtibdi.disi.unitn.it/",
token: "-"
```

# Run
In the src folder run the following command for single and muliple agents:
```
node agent.js
node agent_pddl.js
node spawn_processes.js
```

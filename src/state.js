import AStarDaemon from "./astar_daemon.js";
import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

export const CONTEST_RADIUS = 3;         // Manhattan distance threshold
export const CONTEST_PENALTY = 0.5;      // 50% discount on contested parcels
export const MAX_SECTORS_TO_TRY = 5;
export const MAX_TILES_PER_SECTOR = 10;
export const SCOUT_STEPS = 5;            // scouting steps around parcel-spawning tiles

export const state = {
  me: { id: null, name: null, x: null, y: null, score: null },
  parcels: new Map(),
  deliveryZones: [],
  mapTiles: new Map(),
  agents: new Map(),
  suspendedDeliveries: new Set(),
};

export const config = {

    host: "http://localhost:8080",
    token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImY1MWEwNCIsIm5hbWUiOiJwbGF5Iiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NTI0MTcxNTZ9.1kenQhUdJSQTeUhIZ4X-ZDYa2o9WKlyEUQTRSqgOI0I"

}
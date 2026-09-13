/**
 * Simulation timing, shared because both sides need it: the simulation to advance, and
 * the renderer to convert its clock into ticks.
 */
export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;

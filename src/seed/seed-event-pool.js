/*
 * Seed producer for the trigger-event measurement pool — the SAME create→approve pipeline as
 * seed-update-pool (a LIVE tradeId is a LIVE tradeId; only the harvest destination differs:
 * seed-harvest.sh maps this entry name to data/trade/event-ids.json). A separate pool file
 * exists because the exactly-once cursor allows ONE consuming scenario per pool — in trade-mix,
 * update-mix owns update-ids and event-mix owns event-ids.
 *
 *   ./prep.sh seed-event-pool <env> ITERATIONS=<pool size x 1.3>
 *
 * Note: unlike seed-update-pool, this entry does NOT refresh the reusable trade-ids read pool
 * (run.sh keys that side effect on the seed-update-pool name alone — one designated producer).
 */
export { options, setup, default, handleSummary } from './seed-update-pool.js';

/*
 * Seed producer for trade-mix-full's PERMANENT amend-cycle pool — the SAME create→approve
 * pipeline as seed-update-pool (a LIVE tradeId is a LIVE tradeId; only the harvest
 * destination differs: seed-harvest.sh maps this entry name to
 * data/trade/amend-cycle-ids.json).
 *
 *   ./prep.sh seed-amend-cycle-pool <env> ITERATIONS=<pool floor x 1.6>
 *
 * Unlike the consumable pools this one is seeded ONCE: the amend chain's reject leg restores
 * every id to LIVE unchanged, so the pool survives measurement rounds indefinitely. Re-seed
 * only after poisoning (failed reject legs leaving ids stuck pending — http-409 on revisit).
 *
 * Note: does NOT refresh the reusable trade-ids read pool (that side effect is keyed on the
 * seed-update-pool name alone — one designated producer).
 */
export { options, setup, default, handleSummary } from './seed-update-pool.js';

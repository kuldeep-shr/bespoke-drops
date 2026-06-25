/**
 * Load test: fire CONCURRENCY claims at a single live drop with STOCK units,
 * all at once, then assert the system never oversold.
 *
 * Run against a running server + seeded DB:
 *   npm run dev        (terminal 1)
 *   npm run loadtest   (terminal 2)   — or: STOCK=10 CONCURRENCY=500 npm run loadtest
 *
 * It creates its own fresh drop via the API so results are deterministic.
 */
const BASE = process.env.BASE ?? 'http://localhost:3000/api';
const STOCK = Number(process.env.STOCK ?? 10);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 500);

async function main() {
  // 1) create a drop that is already live
  const createRes = await fetch(`${BASE}/drops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      itemName: `LoadTest ${Date.now()}`,
      totalStock: STOCK,
      available: STOCK,
      pricePerUnit: 1,
      goLiveAt: new Date(Date.now() - 1000).toISOString(),
      maxPerUser: 1,
    }),
  });
  const drop = await createRes.json();
  console.log(`Created drop ${drop._id} — stock ${STOCK}, firing ${CONCURRENCY} concurrent claims...`);

  // 2) fire all claims at once, one unit each, distinct users
  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      fetch(`${BASE}/drops/${drop._id}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': `load_${i}` },
        body: JSON.stringify({ units: 1 }),
      }).then((r) => r.status)
    )
  );
  const ms = Date.now() - t0;

  // 3) tally
  const codes: Record<number, number> = {};
  for (const r of results) {
    if (r.status === 'fulfilled') codes[r.value] = (codes[r.value] ?? 0) + 1;
    else codes[0] = (codes[0] ?? 0) + 1;
  }
  const created = codes[201] ?? 0;
  const soldOut = codes[409] ?? 0;

  // 4) verify final stock
  const fresh = await (await fetch(`${BASE}/drops/${drop._id}`)).json();

  console.log('\n--- RESULTS ---');
  console.log(`status codes:`, codes);
  console.log(`holds created : ${created}  (expected ${STOCK})`);
  console.log(`sold-out (409): ${soldOut}`);
  console.log(`final available: ${fresh.available}  (expected 0)`);
  console.log(`throughput     : ${CONCURRENCY} reqs in ${ms}ms`);

  const pass = created === STOCK && fresh.available === 0;
  console.log(`\n${pass ? '✅ PASS — no oversell' : '❌ FAIL — oversold!'}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

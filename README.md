# BeSpoke Drops — Senior Backend Take-Home

A backend that powers a limited-edition **Drop** from go-live to completed purchase,
and stays **correct and fair** when thousands arrive on the same scarce stock in the
same second, when clients retry, and when the process restarts mid-flight.

Stack: **Node.js · Express · TypeScript · MongoDB (Mongoose)**.

---

## Run it (clean checkout, minutes)

```bash
cp .env.example .env
docker compose up -d        # standalone MongoDB on :27017
npm install
npm run seed                # wallets + one live drop + one future drop
npm run dev                 # http://localhost:3000
```

Then exercise it (seed prints the live drop id):

```bash
DROP=<live-drop-id>

# claim 2 units as alice, retry-safe via Idempotency-Key
curl -XPOST localhost:3000/api/drops/$DROP/claim \
  -H 'x-user-id: alice' -H 'idempotency-key: k1' \
  -H 'content-type: application/json' -d '{"units":2}'

# pay (debits alice's wallet)
curl -XPOST localhost:3000/api/holds/<hold-id>/pay -H 'x-user-id: alice'

curl localhost:3000/api/me/wallet -H 'x-user-id: alice'

# cancel a hold — returns stock, refunds coins if it was paid
curl -XPOST localhost:3000/api/holds/<hold-id>/cancel -H 'x-user-id: alice'

# top up a wallet
curl -XPOST localhost:3000/api/me/wallet/topup \
  -H 'x-user-id: alice' -H 'content-type: application/json' -d '{"amount":500}'
```

Tests:

```bash
npm test     # uses mongodb-memory-server; no running DB needed
```

**Prove the no-oversell guarantee under load:**

```bash
npm run dev                                   # terminal 1
STOCK=10 CONCURRENCY=500 npm run loadtest     # terminal 2
```

The script creates a fresh live drop, fires 500 concurrent claims at 10 units, and
asserts exactly 10 holds were created and `available` landed at 0 — the rest get a
clean `409 SOLD_OUT`. It exits non-zero if a single unit was oversold.

API reference: `openapi.yaml` (import into Swagger/Postman).

---

## The data model

| Collection | Purpose | Key invariant |
|---|---|---|
| **Drop** | item, `totalStock`, `available`, price, go-live, `maxPerUser` | `available + held + sold == totalStock`, always |
| **Hold** | a reservation: `active → confirmed \| expired \| cancelled` | the single source of truth for "reserved but unpaid" |
| **Purchase** | one row per confirmed hold (`unique holdId`) | a hold is paid **at most once** |
| **Wallet** | `userId`, `balance` | never negative, never lost or duplicated |
| **Waitlist** | FIFO entries: `waiting → promoted → fulfilled` | one `waiting` entry per user per drop |

I split **Hold** and **Purchase** deliberately: a hold is a *temporary lease* on
stock, a purchase is *settled money*. Keeping them separate makes both the per-hold
unique constraint (pay-once) and the lifecycle states clean to reason about.

---

## How correctness is achieved

Everything hard in this brief reduces to **"two people, one unit, same instant"**
and **"the same request arriving twice."** I solved both with single-document atomic
operators rather than multi-document transactions — so the system needs **only a
standalone MongoDB**, no replica set.

### 1. Never oversell — one atomic conditional decrement

The entire claim hot-path rests on one operation:

```js
Drop.findOneAndUpdate(
  { _id, available: { $gte: units } },   // guard
  { $inc: { available: -units } }        // decrement
)
```

MongoDB serializes updates to a single document, so this either wins atomically or
returns `null` (sold out). Fifty concurrent claimers on five units yield **exactly
five** holds. There is no read-then-write window to lose, no lock to manage.
*(Proven in `concurrency.test.ts`: 50 racers → 5 successes, `available === 0`.)*

### 2. Idempotent claims — retries collapse

A claim carries an `Idempotency-Key`. A unique partial index on
`(dropId, userId, idempotencyKey)` means a retried claim returns the **existing**
hold instead of reserving again. If two retries race, the loser's stock decrement is
immediately returned to the pool and the winning hold is handed back.

### 3. Money moves exactly once — ordered atomic steps

`pay` is three guarded atomic steps ordered so **any crash is safe**:

1. **Win the confirm:** `Hold {active → confirmed}` guarded on `status:'active'`.
   Only one concurrent/retried pay can win; the rest are idempotent replays.
2. **Conditional debit:** `Wallet {balance ≥ cost}` `$inc -cost`. Cannot go negative.
   If it fails (insufficient funds) the hold rolls **back** to active — coins never moved.
3. **Record Purchase** with `unique holdId`. A duplicate means a retry already paid:
   we refund our own debit and return the original purchase.

*(Proven: concurrent double-pay debits once; a poor wallet is rejected and left
untouched with the hold reusable.)*

### 4. Holds expire and stock returns — lazy + swept, restart-safe

Two mechanisms, belt and suspenders:

- **Lazy:** every read/claim on a drop first reclaims its expired holds, so callers
  always see truthful availability.
- **Sweeper:** a background interval reclaims expired holds across all drops even
  when no one is looking, and triggers waitlist promotion.

Reclaim flips `active → expired` with a guarded atomic update, so **only the winner**
returns the units — a process that dies mid-sweep simply leaves the rest for the next
tick. Nothing is double-returned. No external scheduler, no at-least-once queue needed.

### 6. Cancel + refund — same guarded-transition discipline

Cancelling an **active** hold flips `active → cancelled` (guarded) and returns the
units. Cancelling a **paid** hold flips `confirmed → cancelled`, deletes the Purchase,
refunds the wallet, and restocks — all gated on a single atomic transition so a
double-cancel refunds and restocks **exactly once**. Freed stock promotes the waitlist,
identical to expiry. *(Proven: concurrent double-cancel → one refund, one restock.)*

### 5. Fair waitlist — strict FIFO promotion

When sold out, users join a waitlist (one entry each). As stock frees, promotion walks
entries **oldest-first** and reserves via the *same* atomic decrement. If the head of
the line needs more units than are free, promotion **stops** rather than skipping ahead
— fairness over throughput. Each promoted user gets a fresh hold and a fresh window.

---

## Failure modes I deliberately defended against

| Reality gets messy | Defense |
|---|---|
| Thousands claim one unit at once | atomic conditional `$inc`; impossible to oversell |
| Client times out and retries claim | `Idempotency-Key` + unique index → one hold |
| Client retries pay after it already succeeded | `unique holdId` on Purchase → debit once |
| Server restarts mid-pay | guarded state transitions; partial work is re-derivable, never double-applied |
| Server restarts mid-expiry-sweep | per-hold atomic flip; next sweep resumes safely |
| User pays with too few coins | conditional debit fails, hold rolls back, retryable |
| Hold expires the instant before pay | pay guards on `expiresAt > now`; expired → 409 |

---

## Trade-offs I consciously chose against

- **Multi-document transactions.** Cleaner-looking money movement, but require a
  replica set and add latency under contention. The atomic-operator approach is
  simpler to run, faster on the hot path, and provably correct here. I'd revisit
  transactions only if a single action had to mutate several documents indivisibly.
- **Redis for counters/locks.** Lower latency at extreme scale, but a second
  datastore to keep consistent with Mongo and a new failure surface. Not justified
  at this scope; the atomic Mongo path already prevents oversell.
- **A real job queue for expiry/promotion.** Stronger delivery guarantees, more
  infra. The idempotent lazy+sweeper design gives the same correctness for one box.

---

## Known limitations / with more time

- **Sweeper is single-node.** Two app instances would both sweep; it's idempotent so
  it's safe but wasteful. I'd add a short Mongo-based leader lease.
- **`maxPerUser` check is read-then-reserve**, so a determined user racing themselves
  could momentarily exceed the cap before the atomic decrement; I'd fold the cap into
  a per-user atomic counter to make it airtight.
- **Drop cancellation** (cancelling an entire drop, mass-refund) is out of scope but
  slots cleanly into the same atomic-operator pattern.
- **Auth is a stub** (`x-user-id` header) by the brief's instruction.

## Assumptions
- Coins pre-exist in wallets (brief). Seed funds alice/bob/carol.
- A user holds at most `maxPerUser` units counting active holds **and** purchases.
- Waitlist fairness = arrival order (FIFO), stop-the-line when the head can't be served.

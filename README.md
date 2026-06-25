# BeSpoke Drops — Senior Backend Take-Home

A backend that powers a limited-edition **Drop** from go-live to completed purchase,
and stays **correct and fair** when thousands hit the same scarce stock in the same
second, when clients retry, and when the process restarts mid-flight.

**Stack:** Node.js · Express · TypeScript · MongoDB (Mongoose)

---

## Table of contents

1. [What this solves](#what-this-solves)
2. [Quick start](#quick-start)
   - [Option A — MongoDB Atlas](#option-a--mongodb-atlas-recommended)
   - [Option B — local Docker](#option-b--local-docker)
3. [Environment variables](#environment-variables)
4. [API docs (live Swagger UI)](#api-docs-live-swagger-ui)
5. [Endpoints at a glance](#endpoints-at-a-glance)
6. [Try it with curl](#try-it-with-curl)
7. [Testing](#testing)
8. [Proving no-oversell under load](#proving-no-oversell-under-load)
9. [Data model](#data-model)
10. [How correctness is achieved](#how-correctness-is-achieved)
11. [Failure modes defended against](#failure-modes-defended-against)
12. [Trade-offs](#trade-offs)
13. [Limitations / with more time](#limitations--with-more-time)
14. [Project structure](#project-structure)

---

## What this solves

BeSpoke sells limited-edition items in timed "drops". The instant a drop goes live,
a stampede of users competes for a tiny pool of stock. The hard part is not the CRUD —
it's staying **correct under chaos**:

| #   | Problem                                           | Defense                            |
| --- | ------------------------------------------------- | ---------------------------------- |
| 1   | Never oversell when thousands claim the same unit | atomic conditional stock decrement |
| 2   | Retries must not double-reserve or double-charge  | idempotency keys + unique indexes  |
| 3   | A crash mid-flow must not corrupt state           | guarded atomic state transitions   |
| 4   | Money never lost or duplicated                    | conditional wallet debit + refund  |

Plus the full lifecycle: **claim → pay → expire → waitlist**, with fair FIFO ordering.

---

## Quick start

The app connects to whatever `MONGO_URI` points at — **Atlas** (cloud) or **local
Docker**. Pick one. Prereqs: Node 18+ (and Docker only for Option B).

### Option A — MongoDB Atlas (recommended)

**Step 1 — get your connection string.** In Atlas: **Database → Connect → Drivers**,
copy the string. It looks like:

```
mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
```

**Step 2 — set it in `.env`.** Copy the template, then replace the `MONGO_URI` line:

```bash
cp .env.example .env
```

In `.env`, turn the copied string into this (3 edits):

```
# BEFORE (what Atlas gives you)
mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority

# AFTER (what goes in .env)
MONGO_URI=mongodb+srv://myuser:myP%40ss@cluster0.xxxxx.mongodb.net/bespoke?retryWrites=true&w=majority
```

The 3 edits:

1. Swap `<username>` / `<password>` for your Atlas **database-user** creds (not your Atlas login).
2. Insert the database name **`bespoke`** right before the `?`.
3. URL-encode special characters in the password (`@` → `%40`, `#` → `%23`, `/` → `%2F`).

**Step 3 — allowlist your IP.** In Atlas: **Network Access → Add IP Address →** your IP,
or `0.0.0.0/0` (fine for a take-home). Skipping this is the #1 cause of a silent hang.

**Step 4 — run.**

```bash
npm install
npm run seed        # wallets + one live drop + one future drop (prints a drop id)
npm run dev         # http://localhost:8000
```

You're up when you see `mongo connected` then `listening on :8000`. If instead you see a
connection checklist, it's almost always Step 3 (IP) or an un-encoded password char.

### Option B — local Docker

```bash
cp .env.example .env
# in .env: comment out the Atlas line, uncomment the localhost line:
#   MONGO_URI=mongodb://localhost:27017/bespoke
docker compose up -d    # standalone MongoDB on :27017
npm install
npm run seed
npm run dev
```

> Standalone Mongo is intentional — the design uses single-document atomic operators,
> not multi-document transactions, so **no replica set is required**.

---

## Environment variables

| Var                 | Default                             | Meaning                                                    |
| ------------------- | ----------------------------------- | ---------------------------------------------------------- |
| `PORT`              | `8000`                              | HTTP port                                                  |
| `MONGO_URI`         | `mongodb://localhost:27017/bespoke` | Atlas or local connection string                           |
| `HOLD_TTL_SECONDS`  | `120`                               | how long a claim is held before it expires                 |
| `SWEEP_INTERVAL_MS` | `2000`                              | how often the background sweeper reclaims expired holds    |
| `TEST_MONGO_URI`    | _(unset)_                           | optional: run tests against a real DB instead of in-memory |

`.env` is loaded automatically (via `dotenv`, imported in `src/lib/env.ts`), so every
entry point — server, seed, tests — picks it up.

---

## API docs (live Swagger UI)

The server serves interactive API docs — no extra setup, they ship with the app.

**How to open them:**

```bash
npm run dev                      # start the server
# then open in a browser:
http://localhost:8000/docs
```

You get a full Swagger UI: every endpoint listed, request/response schemas, and a
**"Try it out"** button to fire real calls from the browser (remember to add the
`x-user-id` header in the auth field).

The docs are generated live from `openapi.yaml`, so they never drift from the spec.
Prefer other tools? Paste `openapi.yaml` into editor.swagger.io, or import it into Postman.

---

## Endpoints at a glance

Base path: `/api`. Auth is a stub — send header `x-user-id: <name>`.

| Method | Path                   | Purpose                                     |
| ------ | ---------------------- | ------------------------------------------- |
| POST   | `/drops`               | create a drop (admin)                       |
| GET    | `/drops/{id}`          | view a drop (reflects live availability)    |
| POST   | `/drops/{id}/claim`    | reserve units → places a hold (idempotent)  |
| POST   | `/holds/{id}/pay`      | confirm a hold, debit wallet (idempotent)   |
| POST   | `/holds/{id}/cancel`   | cancel a hold; refund coins if already paid |
| POST   | `/drops/{id}/waitlist` | join the waitlist (only when sold out)      |
| POST   | `/me/wallet/topup`     | add coins to your wallet                    |
| GET    | `/me/holds`            | list my holds                               |
| GET    | `/me/purchases`        | list my purchases                           |
| GET    | `/me/wallet`           | my wallet balance                           |

Idempotent claims: send an `Idempotency-Key` header; a retry returns the same hold.

---

## Try it with curl

After `npm run seed` (it prints a **live drop id** — paste it below):

```bash
DROP=<live-drop-id>      # tip: run `echo $DROP` to confirm it's set

# claim 2 units as alice (retry-safe via idempotency-key)
curl -XPOST localhost:8000/api/drops/$DROP/claim \
  -H 'x-user-id: alice' -H 'idempotency-key: k1' \
  -H 'content-type: application/json' -d '{"units":2}'

# pay (use the hold _id returned above)
curl -XPOST localhost:8000/api/holds/<hold-id>/pay -H 'x-user-id: alice'

# check the wallet got debited
curl localhost:8000/api/me/wallet -H 'x-user-id: alice'

# cancel a hold — returns stock, refunds coins if it was paid
curl -XPOST localhost:8000/api/holds/<hold-id>/cancel -H 'x-user-id: alice'

# top up a wallet
curl -XPOST localhost:8000/api/me/wallet/topup \
  -H 'x-user-id: alice' -H 'content-type: application/json' -d '{"amount":500}'
```

Seeded users: `alice` (10000), `bob` (500), `carol` (0).

> Shell tip: a `CastError: Cast to ObjectId failed for value "$DROP"` means the shell
> didn't substitute the variable — set `DROP` in the **same** terminal, or paste the
> raw id straight into the URL.

---

## Testing

```bash
# Default: ephemeral in-memory MongoDB (downloads a small engine once; needs internet).
npm test

# Alternative: run against a real DB (e.g. an Atlas TEST db). No engine download.
TEST_MONGO_URI="mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/bespoke_test" npm test
```

> ⚠️ The suite wipes collections between cases, so only ever point `TEST_MONGO_URI`
> at a throwaway test database — never your seeded `bespoke` DB.

What the tests prove (in `src/__tests__`):

- **No oversell** — 50 concurrent claimers on 5 units → exactly 5 succeed, `available === 0`
- **Idempotent claim** — same `Idempotency-Key` reserves once
- **maxPerUser** enforced across holds
- **Debit exactly once** — concurrent double-pay → one purchase, one debit
- **Insufficient funds** rejected, wallet untouched, hold reusable
- **Expiry** returns stock to the pool
- **Waitlist** promotes FIFO (oldest first)
- **Cancel + refund** — paid cancel refunds and restocks; double-cancel does so once

---

## Proving no-oversell under load

```bash
npm run dev                                   # terminal 1
STOCK=10 CONCURRENCY=500 npm run loadtest     # terminal 2
```

The script creates a fresh live drop, fires 500 concurrent claims at 10 units, and
asserts exactly 10 holds were created and `available` landed at 0 — the rest get a
clean `409 SOLD_OUT`. It exits non-zero if a single unit was oversold.

---

## Data model

| Collection    | Purpose                                                       | Key invariant                                    |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| **drops**     | item, `totalStock`, `available`, price, go-live, `maxPerUser` | `available + held + sold == totalStock`, always  |
| **holds**     | a reservation: `active → confirmed \| expired \| cancelled`   | single source of truth for "reserved but unpaid" |
| **purchases** | one row per confirmed hold (`unique holdId`)                  | a hold is paid **at most once**                  |
| **wallets**   | `userId`, `balance`                                           | never negative, never lost or duplicated         |
| **waitlists** | FIFO entries: `waiting → promoted → fulfilled`                | one `waiting` entry per user per drop            |

A **Hold** is a temporary lease on stock; a **Purchase** is settled money. Keeping them
separate makes both the pay-once constraint and the lifecycle states clean to reason about.

---

## How correctness is achieved

Everything hard here reduces to **"two people, one unit, same instant"** and **"the same
request arriving twice."** Both are solved with single-document atomic operators rather
than multi-document transactions — so the system needs only a **standalone MongoDB**.

### 1. Never oversell — one atomic conditional decrement

```js
Drop.findOneAndUpdate(
  { _id, available: { $gte: units } }, // guard
  { $inc: { available: -units } }, // decrement
);
```

MongoDB serializes updates to a single document, so this either wins atomically or
returns `null` (sold out). 50 concurrent claimers on 5 units yield exactly 5 holds.
No read-then-write window to lose, no lock to manage.

### 2. Idempotent claims — retries collapse

A unique partial index on `(dropId, userId, idempotencyKey)` means a retried claim
returns the **existing** hold instead of reserving again. If two retries race, the
loser's decrement is returned to the pool and the winning hold is handed back.

### 3. Money moves exactly once — ordered atomic steps

`pay` is three guarded steps ordered so any crash is safe:

1. **Win the confirm:** `Hold {active → confirmed}` guarded on `status:'active'`.
   Only one concurrent/retried pay wins; the rest become idempotent replays. (A loser
   briefly polls for the winner's purchase before giving up, so a same-instant double
   pay resolves to one purchase rather than a spurious conflict.)
2. **Conditional debit:** `Wallet {balance ≥ cost}` `$inc -cost`. Can't go negative.
   On failure the hold rolls **back** to active — coins never moved.
3. **Record Purchase** with `unique holdId`. A duplicate means a retry already paid:
   refund our own debit and return the original purchase.

### 4. Holds expire and stock returns — lazy + swept, restart-safe

Two mechanisms: **lazy** (every read/claim first reclaims a drop's expired holds, so
availability is always truthful) and a **background sweeper** (reclaims across all drops
even when nobody's looking, and triggers waitlist promotion). Reclaim flips
`active → expired` with a guarded atomic update, so only the winner returns the units —
a process that dies mid-sweep just leaves work for the next tick. Nothing double-returns.

### 5. Cancel + refund — same guarded-transition discipline

Cancelling an **active** hold flips `active → cancelled` and returns the units.
Cancelling a **paid** hold flips `confirmed → cancelled`, deletes the Purchase, refunds
the wallet, and restocks — all gated on a single atomic transition so a double-cancel
refunds and restocks exactly once. Freed stock promotes the waitlist, like expiry.

### 6. Fair waitlist — strict FIFO promotion

When sold out, users join a waitlist (one entry each). As stock frees, promotion walks
entries oldest-first and reserves via the same atomic decrement. If the head of the line
needs more units than are free, promotion **stops** rather than skipping ahead —
fairness over throughput. Each promoted user gets a fresh hold and a fresh window.

---

## Failure modes defended against

| Reality gets messy                  | Defense                                             |
| ----------------------------------- | --------------------------------------------------- |
| Thousands claim one unit at once    | atomic conditional `$inc`; impossible to oversell   |
| Client times out and retries claim  | `Idempotency-Key` + unique index → one hold         |
| Two pays for one hold land together | guarded confirm + loser waits → one purchase        |
| Client retries pay after success    | `unique holdId` on Purchase → debit once            |
| Server restarts mid-pay             | guarded transitions; partial work is re-derivable   |
| Server restarts mid-expiry-sweep    | per-hold atomic flip; next sweep resumes safely     |
| User pays with too few coins        | conditional debit fails, hold rolls back, retryable |
| Hold expires the instant before pay | pay guards on `expiresAt > now`; expired → 409      |

---

## Trade-offs

- **Multi-document transactions** — cleaner-looking money movement, but require a replica
  set and add latency under contention. The atomic-operator approach is simpler to run,
  faster on the hot path, and provably correct here. I'd revisit transactions only if a
  single action had to mutate several documents indivisibly.
- **Redis for counters/locks** — lower latency at extreme scale, but a second datastore
  to keep consistent and a new failure surface. Not justified at this scope.
- **A real job queue for expiry/promotion** — stronger delivery guarantees, more infra.
  The idempotent lazy+sweeper design gives the same correctness for one box.

---

## Limitations / with more time

- **Sweeper is single-node.** Two app instances would both sweep; it's idempotent so
  safe but wasteful. I'd add a short Mongo-based leader lease.
- **`maxPerUser` is read-then-reserve**, so a user racing themselves could momentarily
  exceed the cap before the atomic decrement; I'd fold the cap into a per-user atomic
  counter to make it airtight.
- **Drop cancellation** (mass refund of an entire drop) slots into the same pattern.
- **Auth is a stub** (`x-user-id` header) per the brief.

### Assumptions

- Coins pre-exist in wallets (brief); seed funds alice/bob/carol.
- A user holds at most `maxPerUser` units counting active holds **and** purchases.
- Waitlist fairness = arrival order (FIFO), stop-the-line when the head can't be served.

---

## Project structure

```
src/
  app.ts                 express app + /docs (Swagger UI)
  index.ts               server bootstrap + Mongo connect
  sweeper.ts             background expiry/promotion loop
  lib/
    env.ts               env loading (dotenv) + config
    errors.ts            typed AppError + helpers
  middleware/
    auth.ts              x-user-id stub auth
    errorHandler.ts      maps AppError -> HTTP
  models/                Drop, Hold, Purchase, Wallet, Waitlist
  routes/index.ts        REST routes
  services/
    dropService.ts       create/validate drops
    claimService.ts      atomic claim + idempotency
    payService.ts        confirm + debit + record (exactly-once)
    expiryService.ts     restart-safe reclaim
    waitlistService.ts   FIFO promotion
    cancelService.ts     cancel + refund
    walletService.ts     top-up
  scripts/
    seed.ts              demo data
    loadtest.ts          500-concurrent no-oversell proof
  __tests__/             concurrency + cancel suites
openapi.yaml             API spec (also served at /docs)
docker-compose.yml       local standalone Mongo (Option B)
```

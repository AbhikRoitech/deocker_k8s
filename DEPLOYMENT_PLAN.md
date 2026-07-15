# PERN Todo App → Production 4-Tier VPC — Phase-Wise Deployment Plan

A learning-focused runbook to deploy your monolithic PERN todo app (React + Express + RDS
Postgres) into a secure AWS 4-tier network. Follow the phases in order. Each phase ends with a
**Focus / verify** block — do not move on until those pass.

---

## 0. Target architecture (what we are building)

### Simplified view (the mental model — start here)

Three tiers, each more locked-down than the one above it: public web → private app → isolated data.

```
                        INTERNET
                           │
                    ┌──────────────┐
                    │ Internet GW  │
                    └──────────────┘
                           │
                     PUBLIC SUBNET
      ┌────────────────────────────────────────┐
      │  React frontend (served via web EC2/S3) │
      │  Load Balancer (ALB)                     │
      └────────────────────────────────────────┘
                           │
                           ▼
                    PRIVATE SUBNET
      ┌────────────────────────────────────────┐
      │  Express + Node.js API                   │
      └────────────────────────────────────────┘
                           │
                           ▼
                PRIVATE ISOLATED SUBNET
      ┌────────────────────────────────────────┐
      │  PostgreSQL / RDS                        │
      │  Redis cache                             │
      │  Secrets Manager endpoint                │
      └────────────────────────────────────────┘
```

- **Public subnet** = the only tier reachable from the internet (users + the load balancer).
- **Private subnet** = the app logic; reachable *only* from the public tier, never directly from users.
- **Private isolated subnet** = the crown jewels (data + secrets); reachable *only* from the app tier,
  with **no internet access at all**.

The detailed diagram below is the same idea, just split into the exact subnets/instances we build
(the app tier becomes app1+app2, the data tier splits into cache and db, etc.).

### Detailed view (exact subnets & instances)

```
                          Internet
                             │
                        ┌────▼────┐
                        │   IGW   │
                        └────┬────┘
       ┌─────────────────────┴──────────────────────┐
       │   VPC  10.0.0.0/16   (region: your region)  │
       │                                              │
       │  PUBLIC subnet  "web"  10.0.1.0/24           │
       │   ┌──────────────┐        ┌──────────────┐   │
       │   │ EC2: web     │        │ NAT Gateway  │   │
       │   │ nginx +      │        │ (+ EIP)      │   │
       │   │ React build  │        └──────┬───────┘   │
       │   │ reverse-proxy│               │           │
       │   └──────┬───────┘               │ egress    │
       │          │ /api → app tier       │ for       │
       │          │                       │ app1+cache│
       │  PRIVATE │                       │           │
       │  ┌───────▼──────┐  ┌──────────────┐          │
       │  │ EC2: app1    │  │ EC2: app2    │  app tier │
       │  │ Express :8000│  │ Express :8000│           │
       │  │ 10.0.2.0/24  │  │ 10.0.3.0/24  │           │
       │  └───┬──────┬───┘  └───┬──────────┘           │
       │      │      │          │                      │
       │      │      ▼          ▼                      │
       │      │   ┌──────────────┐   cache tier        │
       │      │   │ EC2: dbcache │   Redis :6379        │
       │      │   │ 10.0.4.0/24  │                      │
       │      │   └──────┬───────┘                      │
       │      ▼          ▼                              │
       │   ┌──────────────────────┐   db tier          │
       │   │ RDS Postgres :5432    │  (subnet group)    │
       │   │ db subnet 10.0.5.0/24 │                    │
       │   └──────────────────────┘                    │
       └──────────────────────────────────────────────┘
```

### Component → subnet mapping

| Tier   | Subnet    | Public? | Instance / service           | App role                                        |
|--------|-----------|---------|------------------------------|-------------------------------------------------|
| web    | 10.0.1.0/24 | **Yes** | EC2 `web` (nginx)          | Serves React `dist/`, reverse-proxies `/api`    |
| app    | 10.0.2.0/24 | No    | EC2 `app1` (Express :8000)   | Todo API instance 1 (gets NAT egress)           |
| app    | 10.0.3.0/24 | No    | EC2 `app2` (Express :8000)   | Todo API instance 2 (NO internet — locked down) |
| cache  | 10.0.4.0/24 | No    | EC2 `dbcache` (Redis :6379)  | Cache layer (gets NAT egress)                   |
| db     | 10.0.5.0/24 | No    | RDS Postgres :5432 (+ EC2 `db` for the lab checkbox) | Database |

> **Lab requirement #4** ("only dbcache instance and app1 subnet send internet requests") is
> satisfied by routing: **only** the `app1` and `dbcache` subnets get a `0.0.0.0/0 → NAT` route.
> `app2` and `db` subnets have **no** default route → no internet at all. That contrast is the
> whole point of the exercise.

---

## Phase 1 — VPC skeleton (network foundation)  ✅ DONE (2026-07-12)

1. Create VPC `prod-vpc` `10.0.0.0/16`.
2. Create 5 subnets across (ideally) 2 AZs:
   - `web`     `10.0.1.0/24`  (public)
   - `app1`    `10.0.2.0/24`  (private)
   - `app2`    `10.0.3.0/24`  (private)
   - `dbcache` `10.0.4.0/24`  (private)
   - `db`      `10.0.5.0/24`  (private) — for RDS put a **second** db subnet in another AZ
     (e.g. `10.0.6.0/24`) so RDS has a valid multi-AZ subnet group.
3. Create and attach **IGW** `prod-igw` to the VPC.
4. Allocate an **Elastic IP** and create a **NAT Gateway** in the **web (public)** subnet.
5. Route tables:
   - `rt-public`  → `0.0.0.0/0 = IGW`; associate with **web** subnet.
   - `rt-app1`    → `0.0.0.0/0 = NAT`; associate with **app1** subnet.
   - `rt-cache`   → `0.0.0.0/0 = NAT`; associate with **dbcache** subnet.
   - `rt-private` → **local only, no default route**; associate with **app2** and **db** subnets.
6. Enable **auto-assign public IPv4** on the `web` subnet only.

**Focus / verify after Phase 1:**
- Understand IGW vs NAT: IGW = 2-way public reachability (public subnet); NAT = **outbound-only**
  egress for private subnets. A subnet is "public" *only* because its route table points to an IGW.
- Sanity check each subnet's associated route table. `app2`/`db` must have **no** `0.0.0.0/0` entry.
- Nothing is launched yet — this phase is 100% about the routing story.

---

## Phase 2 — Security Groups (the core of this exercise)  ✅ DONE (2026-07-12)

Create these **before** launching instances. The golden rule: **source = another security group,
not a CIDR.** SG references mean "whatever instance carries that SG," so IPs never matter.

> The port-**22 (SSH)** rules below depend on your admin-access choice in **Phase 3**: keep them for
> the SSH-bastion path (Option A), or omit every `22` rule if you use SSM (Option B).

### `sg-web`  → attached to EC2 `web` (public/front door)
| Dir | Port     | Source / Dest        | Why                                                   |
|-----|----------|----------------------|-------------------------------------------------------|
| In  | 80, 443  | `0.0.0.0/0`          | Public users hit the site. Only these are world-open. |
| In  | 22       | `YOUR.IP/32`         | Admin SSH (Option A). Omit entirely if using SSM.     |
| Out | 8000     | `sg-app`             | Reverse-proxy `/api` to the backend tier.             |
| Out | 443      | `0.0.0.0/0`          | OS/package updates via IGW.                            |

**Why:** it's the only tier exposed to the internet, so it carries the smallest possible public
surface — 80/443 to the world, SSH pinned to your IP only.

### `sg-app`  → attached to EC2 `app1` and `app2` (backend)
| Dir | Port | Source / Dest   | Why                                                        |
|-----|------|-----------------|------------------------------------------------------------|
| In  | 8000 | `sg-web`        | **Only** the web tier may reach the API. Not the internet. |
| In  | 22   | `sg-web`        | SSH via bastion only (Option A). Omit for SSM.             |
| Out | 5432 | `sg-db`         | Query RDS Postgres.                                        |
| Out | 6379 | `sg-cache`      | Read/write Redis.                                          |
| Out | 443  | `0.0.0.0/0`     | npm install / RDS TLS / SSM — reaches internet via NAT (app1). |

**Why:** the backend is never internet-reachable. Inbound is locked to `sg-web`, so even though
app1/app2 sit in a routable VPC, nothing but the web box can open :8000. Same SG on both app
instances = identical policy, easy to scale to app3/app4.

### `sg-cache`  → attached to EC2 `dbcache` (Redis)
| Dir | Port | Source / Dest | Why                                                       |
|-----|------|---------------|-----------------------------------------------------------|
| In  | 6379 | `sg-app`      | Only the app tier talks to the cache.                     |
| In  | 22   | `sg-web`      | Bastion SSH (Option A) / omit for SSM.                    |
| Out | 5432 | `sg-db`       | (Optional) warm the cache from the DB.                    |
| Out | 443  | `0.0.0.0/0`   | Package updates — internet egress via NAT (requirement #4). |

**Why:** cache holds app data, so its inbound is as tight as the DB — app tier only. It's granted
NAT egress specifically to satisfy lab requirement #4.

### `sg-db`  → attached to RDS Postgres (and EC2 `db` if you launch one)
| Dir | Port | Source / Dest        | Why                                                    |
|-----|------|----------------------|--------------------------------------------------------|
| In  | 5432 | `sg-app`, `sg-cache` | Only app + cache tiers may connect. Nothing else.      |
| In  | 22   | `sg-web`             | Only if you run an EC2 `db`; RDS has no SSH.            |
| Out | —    | (leave default)      | RDS needs no outbound; DB tier has no internet route.  |

**Why:** the tightest group in the system — the data store accepts connections from exactly two
security groups and has zero internet exposure (no NAT route + no permissive egress). This is your
crown-jewel tier.

### SG mapping summary (the "which SG on which EC2 and why" table)
| Instance  | Security group | Reachable from                | Can reach                         |
|-----------|----------------|-------------------------------|-----------------------------------|
| `web`     | `sg-web`       | Internet (80/443), you (22)   | app:8000, internet:443            |
| `app1`    | `sg-app`       | `web` only (8000/22)          | db:5432, cache:6379, internet:443 |
| `app2`    | `sg-app`       | `web` only (8000/22)          | db:5432, cache:6379 (**no** internet — subnet has no NAT route) |
| `dbcache` | `sg-cache`     | `app` only (6379)             | db:5432, internet:443             |
| `db`/RDS  | `sg-db`        | `app` + `cache` only (5432)   | nothing                           |

**Focus / verify after Phase 2:**
- Trace one request end-to-end on paper: browser → `sg-web` :443 → nginx → `sg-app` :8000 →
  Express → `sg-db` :5432. Every hop is allowed by exactly one SG rule and nothing wider.
- Note app2 vs app1: **identical SG, different subnet route table** → app2 has no internet. SGs
  control *who can talk to the instance*; route tables control *where the instance can go*.

---

## Phase 3 — Bastion / admin access (how you'll reach private instances)  ✅ DONE (2026-07-12) — Option A (SSH bastion)

You have two options. Do **Option B** if you want the modern secure path; do A if the lab expects SSH.

- **Option A — SSH bastion:** the `web` EC2 doubles as a jump host. SSH into `web` from your IP,
  then SSH from `web` into private instances using the same key.
- **Option B — SSM Session Manager (recommended, no SSH, no bastion):** attach an IAM role with
  `AmazonSSMManagedInstanceCore` to every instance; connect via Session Manager. No port 22 open
  anywhere, no keys on disk. Private instances reach SSM through the NAT (app1/cache) or via VPC
  endpoints (app2/db).

**Focus / verify after Phase 3:**
- The security win: **your database and backend never have port 22 open to the internet.** Admin
  access is either one narrow hole (bastion from your IP/32) or zero holes (SSM).
- This choice sets the port-22 rules in the **Phase 2 security groups above**: keep the `22` rules
  for Option A, or remove them all for Option B (SSM).

---

## Phase 4 — NACLs (subnet-level, stateless — belt-and-suspenders)

SGs are stateful and per-instance; NACLs are **stateless** and per-subnet. Because they're
stateless you must **explicitly allow return traffic on ephemeral ports 1024–65535** in the
opposite direction. Keep NACLs coarse (per-subnet CIDR), let SGs do the fine-grained work.

| Subnet    | Inbound allow                                   | Outbound allow                                  |
|-----------|-------------------------------------------------|-------------------------------------------------|
| web       | 80,443 from `0.0.0.0/0`; 22 from YOUR.IP/32; 1024-65535 from `0.0.0.0/0` (returns) | 80,443 to `0.0.0.0/0`; 8000 to app CIDRs; 1024-65535 to `0.0.0.0/0` |
| app1/app2 | 8000 from web CIDR; 1024-65535 from VPC/NAT (returns); 22 from web CIDR | 5432 to db CIDRs; 6379 to cache CIDR; 443 to `0.0.0.0/0`; 1024-65535 returns |
| dbcache   | 6379 from app CIDRs; 1024-65535 returns         | 5432 to db CIDRs; 443 to `0.0.0.0/0`; 1024-65535 returns |
| db        | 5432 from app+cache CIDRs; 1024-65535 returns   | 1024-65535 to app+cache CIDRs (returns only)    |

**Focus / verify after Phase 4:**
- The #1 gotcha: forgetting ephemeral return ports → connections hang/time out. If something breaks
  after adding NACLs, this is almost always why.
- Understand the layering: a packet must pass **NACL (subnet) → SG (instance)** inbound, and the
  reverse outbound. Two independent filters.

---

## Phase 5 — RDS (database tier)

1. Create a **DB subnet group** spanning the two `db` subnets (`10.0.5.0/24` + `10.0.6.0/24`).
2. Launch **RDS PostgreSQL**: not publicly accessible, subnet group above, security group `sg-db`.
3. Set master user/password; note the endpoint.
4. Because `db.js` uses `PGSSL=true` with `rejectUnauthorized:false`, TLS works out of the box.

**Focus / verify after Phase 5:**
- Confirm "Publicly accessible = No" and that `sg-db` inbound is SG-referenced (not `0.0.0.0/0`).
- You **cannot** reach RDS from your laptop directly — that's correct. You'll test it from `app1`.

---

## Phase 6 — App tier (Express on app1 + app2)

On each app instance (via bastion/SSM):
1. Install Node 18+, `git clone` the repo, `cd server`, `npm ci`.
2. Create `server/.env`:
   ```
   PORT=8000
   PGHOST=<your-rds-endpoint>
   PGPORT=5432
   PGDATABASE=appdb
   PGUSER=app_admin
   PGPASSWORD=<secret>
   PGSSL=true
   ```
3. **Run the migration once** (from `app1` only): `npm run migrate` → creates the `todos` table.
4. Start the API with a process manager so it survives reboots: `pm2 start src/index.js --name todo-api`
   (or a `systemd` unit). Repeat start on `app2`.

**Focus / verify after Phase 6:**
- On `app1`: `curl localhost:8000/health` → `{"status":"ok","db":"connected"}`. That single call
  proves app→RDS connectivity through `sg-app`→`sg-db`.
- Keep secrets out of git — `.env` is git-ignored. For real prod, graduate to **SSM Parameter
  Store / Secrets Manager** instead of a `.env` file (note it as a follow-up).

---

## Phase 7 — Cache tier (Redis on dbcache)  *(optional but on-theme)*

1. Install Redis on `dbcache`, bind to its private IP, set a password, `protected-mode yes`.
2. The current app doesn't use Redis yet — this tier exists to exercise the cache subnet + NAT
   egress requirement. (Bonus: add a Redis read-through cache for `GET /api/todos` later.)

**Focus / verify after Phase 7:**
- From `app1`: `redis-cli -h <dbcache-ip> -a <pass> ping` → `PONG` proves `sg-app`→`sg-cache`.
- From `dbcache`: `curl https://example.com` succeeds (NAT egress works — requirement #4). The same
  curl from `app2` should **fail** (no NAT route) — verify that contrast.

---

## Phase 8 — Web tier (nginx + React) — the public front door

On `web` EC2:
1. Build the client: locally or on the box run `cd client && npm ci && npm run build` → produces
   `client/dist/`. (Set the API to a same-origin `/api` path — it already is.)
2. Install nginx, copy `dist/` to `/usr/share/nginx/html`.
3. nginx config:
   ```nginx
   server {
     listen 80;
     server_name _;
     root /usr/share/nginx/html;
     location / { try_files $uri /index.html; }        # React SPA
     location /api/ {
       proxy_pass http://<app1-private-ip>:8000;        # or an internal ALB DNS
       proxy_set_header Host $host;
     }
   }
   ```
4. (Later) put a public ALB in front of `web` and terminate HTTPS/443 with ACM.

**Focus / verify after Phase 8:**
- Hit `http://<web-public-ip>/` in a browser → todo app loads, add/complete/delete works.
- The request path now flows web(public) → app(private) → RDS(private). **Nothing but the web box
  has a public IP.** Compare mentally to your old setup where Vite dev server was exposed directly.

---

## Phase 9 — Harden & verify the whole thing

- **Load-balance app1/app2:** put an **internal ALB** in the private app subnets; point nginx
  `proxy_pass` at the ALB DNS. Now you have real 2-instance HA in the app tier.
- **HTTPS:** public ALB + ACM cert in front of `web`; redirect 80→443.
- **Least privilege recheck:** every SG inbound should reference an SG or your `/32`, never
  `0.0.0.0/0` except web 80/443. Every private subnet's egress justified.
- **Secrets:** move `.env` values to Secrets Manager; give app instances an IAM role to read them.
- **Logging:** enable VPC Flow Logs to confirm denied traffic where you expect denials.

**Focus / verify after Phase 9:**
- Negative tests (these should FAIL — that proves the design):
  - `curl http://<app1-ip>:8000/health` from your laptop → **times out** (not public). ✅
  - `psql -h <rds-endpoint>` from your laptop → **times out** (db is private, sg-db locked). ✅
  - `curl https://example.com` from `app2` → **fails** (no NAT). ✅
- Positive test: the site works end-to-end through the web tier only.

---

## Quick reference — why each subnet gets (or is denied) internet

| Subnet  | Default route      | Internet? | Reason                                            |
|---------|--------------------|-----------|---------------------------------------------------|
| web     | `0.0.0.0/0 → IGW`  | 2-way     | Public entry point; users must reach it.          |
| app1    | `0.0.0.0/0 → NAT`  | egress    | Needs npm/updates + SSM (lab requirement #4).     |
| dbcache | `0.0.0.0/0 → NAT`  | egress    | Package updates (lab requirement #4).             |
| app2    | local only         | none      | Deliberately locked down — teaches the contrast.  |
| db      | local only         | none      | Crown-jewel data tier; zero internet exposure.    |

---

## Cost / cleanup reminder
NAT Gateway, RDS, and Elastic IPs bill hourly. When you finish a learning session, **delete the NAT
Gateway** (biggest cost) and stop RDS/EC2, or tear the stack down. Consider building this with
CloudFormation/Terraform so you can `destroy` and `apply` cheaply on each study session.

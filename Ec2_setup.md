# EC2 Setup — PERN Todo App on a Single Box (default VPC + local PostgreSQL)

Step-by-step record of how the app was deployed onto **one EC2 instance in the default VPC**,
running the React frontend + Express API + a **local PostgreSQL** on the same machine, exposed to
the public internet through **nginx**.

- **Region:** `ap-south-1` (Mumbai)
- **Account:** `786174827428` (`AbhikIAM`)
- **Date:** 2026-07-13
- **Live URL:** http://13.206.89.253/

---

## 0. Architecture (what runs on the box)

```
        Internet (users)
              │  :80
        ┌─────▼─────────────────────────────────────┐
        │  EC2  i-0f70750ae1e61f20e (13.206.89.253)  │
        │  Amazon Linux 2023 · t3.micro              │
        │                                            │
        │   nginx :80                                │
        │     ├─ /       → React build (dist/)       │
        │     └─ /api/   → proxy → 127.0.0.1:8000    │
        │                          │                 │
        │   Express API :8000 (pm2: todo-api)        │
        │                          │ localhost:5432  │
        │   PostgreSQL 15  (DB: appdb)               │
        └────────────────────────────────────────────┘
```

Everything is on one instance. The app talks to the database over `localhost` (no RDS, `PGSSL=false`).

---

## 1. Prerequisites (local machine)
- AWS CLI configured (`aws sts get-caller-identity` → account `786174827428`).
- Region `ap-south-1`.

**Building blocks discovered:**

| Item | Value |
|---|---|
| Default VPC | `vpc-0a4090c0eff06abe4` |
| Subnet (auto public IP) | `subnet-090a94618d7b88666` (ap-south-1a) |
| AMI (Amazon Linux 2023) | `ami-0b910d1016287a5e7` |
| My public IP (for SSH) | `49.37.113.250/32` |

```bash
# find latest Amazon Linux 2023 AMI
aws ec2 describe-images --owners amazon \
  --filters "Name=name,Values=al2023-ami-2023.*-x86_64" "Name=state,Values=available" \
  --query 'reverse(sort_by(Images,&CreationDate))[0].[ImageId,Name]' --output text --region ap-south-1
```

---

## 2. Create the SSH key pair

```bash
aws ec2 create-key-pair --key-name deocker-local-db \
  --query 'KeyMaterial' --output text --region ap-south-1 > infra/deocker-local-db.pem
```
- Private key saved to `infra/deocker-local-db.pem` (added `*.pem` to `.gitignore` — never committed).
- On Windows, tightened the key's ACL so OpenSSH accepts it:
  ```powershell
  icacls infra\deocker-local-db.pem /reset
  icacls infra\deocker-local-db.pem /inheritance:r
  icacls infra\deocker-local-db.pem /grant:r "abhik\abhik:(R)"
  ```

---

## 3. Create the security group (firewall)

```bash
SG=$(aws ec2 create-security-group --group-name deocker-local-db-sg \
  --description "Single-box PERN todo + local postgres" \
  --vpc-id vpc-0a4090c0eff06abe4 --query 'GroupId' --output text --region ap-south-1)

aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 22   --cidr 49.37.113.250/32 --region ap-south-1  # SSH  (my IP only)
aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 80   --cidr 0.0.0.0/0        --region ap-south-1  # HTTP (public → nginx)
aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 8000 --cidr 49.37.113.250/32 --region ap-south-1  # API  (my IP, for testing)
```
Result: **`sg-077ecd934eaf1239e`**

| Port | Source | Why |
|---|---|---|
| 22 | my IP `/32` | SSH admin |
| 80 | `0.0.0.0/0` | Public users reach the site via nginx |
| 8000 | my IP `/32` | Direct API testing (not needed by end users) |

> Note: the DB port **5432 is NOT opened** — Postgres is only reached over `localhost` inside the box.

---

## 4. Bootstrap script (user-data — runs automatically on first boot)

Saved as [`infra/local-db-ec2/user-data.sh`](infra/local-db-ec2/user-data.sh). It performs, in order:

1. **Install packages:** `git`, `nodejs`/`npm` (Node 18), `nginx`, `postgresql15` + `postgresql15-server`, and `pm2` (global).
2. **Init local PostgreSQL:** `postgresql-setup --initdb`, then `systemctl enable --now postgresql`.
3. **Create the database + role:**
   ```sql
   CREATE ROLE app_admin WITH LOGIN PASSWORD 'AppPass123!';
   CREATE DATABASE appdb OWNER app_admin;
   GRANT ALL PRIVILEGES ON DATABASE appdb TO app_admin;
   ```
   and switch loopback auth in `pg_hba.conf` (`127.0.0.1/32`, `::1/128`) to `scram-sha-256` so the app can log in with a password.
4. **Clone the code:** `git clone https://github.com/AbhikRoitech/deocker_k8s.git ~/app`.
5. **Backend:** `npm install`, write `server/.env` (below), `npm run migrate` (creates `todos` table), then `pm2 start src/index.js --name todo-api` + `pm2 save` + `pm2 startup` (survives reboot).
6. **Frontend:** `npm install && npm run build`; copy `dist/` to `/usr/share/nginx/html`.
7. **nginx:** remove Amazon Linux's stock default `server{}` block (it shadows ours), install our config, `nginx -t`, enable + start.

**`server/.env` written on the box (points at the LOCAL db):**
```
# Server
PORT=8000

# PostgreSQL connection
PGHOST=localhost
PGPORT=5432
PGDATABASE=appdb
PGUSER=postgres
PGPASSWORD=postgres

# Set to "true" when connecting to AWS RDS (TLS is enforced by the DB).
PGSSL=false
```

**nginx config (`/etc/nginx/conf.d/todo.conf`):**
```nginx
server {
    listen 80 default_server;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri /index.html;      # React SPA fallback
    }
    location /api/ {
        proxy_pass http://127.0.0.1:8000; # → Express API
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## 5. Launch the instance

```bash
aws ec2 run-instances \
  --image-id ami-0b910d1016287a5e7 \
  --instance-type t3.micro \
  --key-name deocker-local-db \
  --security-group-ids sg-077ecd934eaf1239e \
  --subnet-id subnet-090a94618d7b88666 \
  --associate-public-ip-address \
  --user-data file://infra/local-db-ec2/user-data.sh \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":16,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=deocker-local-db}]' \
  --region ap-south-1
```
Result: instance **`i-0f70750ae1e61f20e`**, public IP **`13.206.89.253`**.

Wait for it to be ready:
```bash
aws ec2 wait instance-status-ok --instance-ids i-0f70750ae1e61f20e --region ap-south-1
```

---

## 6. The one manual fix (now baked into the script)

Amazon Linux's stock `nginx.conf` ships its own `server{}` on port 80. It **shadowed** our config, so
`/api/` returned 404. Removed that default block, then reloaded nginx:

```bash
sudo python3 -c "..."   # strip the default server{} block from /etc/nginx/nginx.conf
sudo nginx -t && sudo systemctl reload nginx
```
This step is now part of `user-data.sh`, so a fresh launch works without manual intervention.

---

## 7. Verification (all passed ✅)

Run on the box (via SSH) and from the internet:

```bash
# --- on the EC2 ---
git --version           # git 2.50.1
node --version          # v18.20.8
psql --version          # psql (PostgreSQL) 15.18
systemctl is-active postgresql        # active

# database + table exist
PGPASSWORD='AppPass123!' psql -h localhost -U app_admin -d appdb -c '\dt'
#  public | todos | table | app_admin

pm2 list                # todo-api  |  online
curl localhost:8000/health            # {"status":"ok","db":"connected"}

# --- from the public internet ---
curl -o /dev/null -w "%{http_code}\n" http://13.206.89.253/        # 200  (React app)
curl http://13.206.89.253/api/todos                                # [] / list of todos
curl -X POST http://13.206.89.253/api/todos \
     -H "Content-Type: application/json" \
     -d '{"title":"created from the internet via nginx"}'          # persisted to local DB ✅
```

Confirmed request path end-to-end: **browser → nginx :80 → Express :8000 → PostgreSQL localhost:5432**,
and data created from the public internet persists to the local database.

---

## 8. How to connect / operate

```bash
# SSH into the box (from the IP allowed in the SG)
ssh -i infra/deocker-local-db.pem ec2-user@13.206.89.253

# app process
pm2 list
pm2 restart todo-api
pm2 logs todo-api

# nginx
sudo nginx -t && sudo systemctl reload nginx
sudo tail -f /var/log/nginx/error.log

# bootstrap log (what user-data did on first boot)
sudo cat /var/log/user-data.log

# database
PGPASSWORD='AppPass123!' psql -h localhost -U app_admin -d appdb
```

---

## 9. Resource summary

| Resource | ID / Value |
|---|---|
| Instance | `i-0f70750ae1e61f20e` (`t3.micro`, Amazon Linux 2023) |
| Public IP | `13.206.89.253` |
| Default VPC | `vpc-0a4090c0eff06abe4` |
| Subnet | `subnet-090a94618d7b88666` (ap-south-1a) |
| Security group | `sg-077ecd934eaf1239e` (22←my IP, 80←world, 8000←my IP) |
| Key pair | `deocker-local-db` (`infra/deocker-local-db.pem`) |
| Local DB | `appdb` / `app_admin` / `AppPass123!` / `localhost:5432`, SSL off |

---

## 10. Teardown (stop billing)

The instance (t3.micro + 16GB gp3 EBS) bills while running. To remove everything:

```bash
aws ec2 terminate-instances --instance-ids i-0f70750ae1e61f20e --region ap-south-1
# after it's terminated:
aws ec2 delete-security-group --group-id sg-077ecd934eaf1239e --region ap-south-1
aws ec2 delete-key-pair --key-name deocker-local-db --region ap-south-1
```

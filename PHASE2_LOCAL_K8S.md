# Phase 2 — Deploy to Local Kubernetes (Docker Desktop)

**Goal:** take the same containers from Phase 1 and run them on a real Kubernetes cluster —
the one built into Docker Desktop — using the four core objects: **Namespace, Deployment,
Service, Pod** (plus one **Job** for the DB migration).

By the end you'll open `http://localhost:8080` and the todo app is served entirely by pods.

```text
Namespace: todo
┌──────────────────────────────────────────────────────────┐
│  Deployment/client ─► Service/client  (:80)                │
│        │  nginx proxies /api/ ─► http://api:8000           │
│        ▼                                                   │
│  Deployment/api ────► Service/api      (:8000)             │
│        │                                                   │
│        ▼                                                   │
│  Deployment/postgres ► Service/postgres (:5432)            │
│                                                            │
│  Job/migrate  (runs once → creates the todos table)        │
└──────────────────────────────────────────────────────────┘
   Browser ──(kubectl port-forward svc/client 8080:80)──► client
```

> **Scope note:** we deliberately keep it simple here — plain env vars (no Secrets),
> `emptyDir` for Postgres (no persistent storage), no probes or resource limits.
> Those are introduced later (ConfigMaps/Secrets, PV/PVC, probes → **Project 11**).

---

## 0. Prerequisites (one-time setup)

1. **Enable Kubernetes in Docker Desktop:** Settings → Kubernetes → *Enable Kubernetes* →
   Apply & Restart. Wait until the bottom-left Kubernetes icon is green.
2. **Verify `kubectl` points at Docker Desktop:**
   ```bash
   kubectl config use-context docker-desktop
   kubectl get nodes          # should show one node "docker-desktop" Ready
   ```
3. **Stop the Phase 1 Compose stack** so ports 8080/8000 are free:
   ```bash
   docker compose down
   ```

---

## 1. Build & tag the images for Kubernetes

Docker Desktop's Kubernetes shares Docker's local image store, so images built here are
usable by pods **without a registry** — as long as the manifests use
`imagePullPolicy: IfNotPresent`.

```bash
docker build -t todo-api:local ./server
docker build -t todo-client:local ./client
docker images | grep todo    # confirm both exist
```

> The API and migration share one image (`todo-api:local`) — they only differ in the command
> they run, exactly like the `api`/`migrate` split in `docker-compose.yml`.

---

## 2. Create the manifests

Create a `k8s/` folder and add the files below. Everything lives in a `todo` **Namespace**
so it's easy to inspect and delete as a unit.

### `k8s/00-namespace.yaml`
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: todo
```

### `k8s/10-postgres.yaml`
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: todo
spec:
  replicas: 1
  selector:
    matchLabels: { app: postgres }
  template:
    metadata:
      labels: { app: postgres }
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          env:
            - { name: POSTGRES_USER,     value: "postgres" }
            - { name: POSTGRES_PASSWORD, value: "postgres" }
            - { name: POSTGRES_DB,       value: "appdb" }
          ports:
            - containerPort: 5432
          volumeMounts:
            - { name: data, mountPath: /var/lib/postgresql/data }
      volumes:
        - name: data
          emptyDir: {}          # ephemeral — data is lost if the pod is deleted (PVC in Project 11)
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: todo
spec:
  selector: { app: postgres }
  ports:
    - port: 5432
      targetPort: 5432
  # No type => ClusterIP (internal only). Other pods reach it at "postgres:5432".
```

### `k8s/20-migrate-job.yaml`
```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate
  namespace: todo
spec:
  backoffLimit: 5              # retry until Postgres is accepting connections
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: migrate
          image: todo-api:local
          imagePullPolicy: IfNotPresent
          command: ["npm", "run", "migrate"]
          env:
            - { name: PGHOST,     value: "postgres" }
            - { name: PGPORT,     value: "5432" }
            - { name: PGDATABASE, value: "appdb" }
            - { name: PGUSER,     value: "postgres" }
            - { name: PGPASSWORD, value: "postgres" }
            - { name: PGSSL,      value: "false" }
```

### `k8s/30-api.yaml`
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: todo
spec:
  replicas: 1
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels: { app: api }
    spec:
      containers:
        - name: api
          image: todo-api:local
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8000
          env:
            - { name: PORT,       value: "8000" }
            - { name: PGHOST,     value: "postgres" }
            - { name: PGPORT,     value: "5432" }
            - { name: PGDATABASE, value: "appdb" }
            - { name: PGUSER,     value: "postgres" }
            - { name: PGPASSWORD, value: "postgres" }
            - { name: PGSSL,      value: "false" }
---
apiVersion: v1
kind: Service
metadata:
  name: api                    # MUST be "api" — the client nginx proxies to http://api:8000
  namespace: todo
spec:
  selector: { app: api }
  ports:
    - port: 8000
      targetPort: 8000
```

### `k8s/40-client.yaml`
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: client
  namespace: todo
spec:
  replicas: 1
  selector:
    matchLabels: { app: client }
  template:
    metadata:
      labels: { app: client }
    spec:
      containers:
        - name: client
          image: todo-client:local
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: client
  namespace: todo
spec:
  selector: { app: client }
  ports:
    - port: 80
      targetPort: 80
```

---

## 3. Apply everything

`kubectl apply -f k8s/` applies every file in the folder (name prefixes `00→40` keep the
order sensible, though Kubernetes reconciles regardless).

```bash
kubectl apply -f k8s/
```

Watch it come up:

```bash
kubectl get all -n todo
kubectl get pods -n todo -w      # Ctrl-C when all pods are Running / the job is Completed
```

Expected end state:

```
pod/postgres-...     1/1   Running
pod/api-...          1/1   Running
pod/client-...       1/1   Running
job/migrate          Complete   (1/1)
```

---

## 4. Open the app in the browser

Phase 2 keeps Services internal (ClusterIP), so forward a local port to the client Service
(NodePort/LoadBalancer/Ingress come in **Project 4**):

```bash
kubectl port-forward -n todo svc/client 8080:80
```

Leave that running and open **http://localhost:8080** — add, complete, and delete todos.

---

## 5. Verify

```bash
# API health, straight from a shell — reach the ClusterIP by service name from another pod:
kubectl run curltest -n todo --image=curlimages/curl --rm -it --restart=Never -- \
  curl -s http://api:8000/health
# → {"status":"ok","db":"connected"}

# Migration actually created the table:
kubectl logs -n todo job/migrate
# → Migration complete: 'todos' table is ready.

# API logs show the DB connection:
kubectl logs -n todo deploy/api
# → DB connection: OK (postgres:5432/appdb)
```

---

## 6. Core commands to practice (the whole point of Phase 2)

```bash
kubectl get pods -n todo -o wide          # list pods, which node, pod IPs
kubectl describe pod -n todo <pod>        # events, image, env, why it's pending/crashing
kubectl logs -n todo <pod>                # stdout/stderr of a pod
kubectl logs -n todo -f deploy/api        # follow logs by deployment
kubectl exec -n todo -it deploy/api -- sh # shell inside a running container
kubectl get svc,deploy,rs,pod -n todo     # see how Deployment → ReplicaSet → Pod relate
```

Try deleting a pod and watch the Deployment recreate it (a preview of Phase 3 self-healing):

```bash
kubectl delete pod -n todo -l app=api
kubectl get pods -n todo -w
```

---

## 7. Cleanup

```bash
kubectl delete namespace todo     # removes every object in one shot
```

To rebuild after code changes: `docker build -t todo-api:local ./server` (and/or the client),
then `kubectl rollout restart deploy/api -n todo`.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Pod stuck `ImagePullBackOff` / `ErrImagePull` | Image name/tag mismatch, or missing `imagePullPolicy: IfNotPresent`. Rebuild with the exact tag; confirm with `docker images \| grep todo`. |
| Pod stuck `Pending` | Kubernetes not fully started in Docker Desktop, or no node Ready (`kubectl get nodes`). |
| `api` pod `CrashLoopBackOff` | DB not reachable — check `kubectl logs`; ensure the Service is named `postgres` and env `PGHOST=postgres`. |
| `job/migrate` never completes | Postgres wasn't ready yet; the `backoffLimit`/`OnFailure` retries it. Inspect `kubectl describe job/migrate -n todo`. |
| Browser can't load `:8080` | `kubectl port-forward` not running, or the Phase 1 Compose stack still holds the port (`docker compose down`). |
| `/api` returns 502 in the browser | The `api` Service isn't named exactly `api`, so nginx can't resolve `http://api:8000`. |

---

## What you learned → what's next

**Learned:** Namespaces, Deployments (declarative desired state), ReplicaSets (created for you),
Services + in-cluster DNS (`postgres`, `api`), Jobs, and the `get/describe/logs/exec` workflow.

**Next — Project 3 (Scaling & self-healing):** `kubectl scale deploy/api --replicas=5`,
rolling updates with `kubectl rollout`, `kubectl rollout undo`, and watching pods
auto-recreate when deleted.

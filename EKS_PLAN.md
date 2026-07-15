# PERN Todo App → EKS — Phase-Wise Learning Plan

A learning-focused runbook to take the same todo app (React + Express + Postgres) and run it the
**real production Kubernetes way** on AWS: containers in **ECR**, orchestrated by **EKS**, exposed
through an **AWS Load Balancer**. Follow the phases in order. Each phase ends with a **Focus /
verify** block — don't move on until those pass, and make sure you can *explain why* each step
exists, not just run it.

- **Region:** `ap-south-1` (Mumbai)
- **Account:** `786174827428`
- **Cluster name (used throughout):** `todo-eks`
- **Prereq mindset:** you already deployed this app on a single EC2 (see `Ec2_setup.md`). EKS is the
  same app, but instead of *you* installing/starting/reverse-proxying, **Kubernetes** does the
  scheduling, restarting, scaling, and load-balancing for you.

---

## 0. Concepts first — the mental model (read before touching anything)

Four things you're learning and how they relate:

```
   Docker image   →   ECR (registry)   →   EKS (cluster runs Pods)   →   Load Balancer (public entry)
   "app in a box"     "where images         "the fleet + brain that       "one stable public URL that
                       are stored"            keeps Pods running"           spreads traffic over Pods"
```

| Term | One-line meaning | The old-world equivalent |
|---|---|---|
| **Docker image** | Your app + its runtime frozen into one artifact | A zipped, ready-to-run server |
| **ECR** | AWS's private Docker image registry | Docker Hub, but yours/private |
| **Kubernetes (K8s)** | A system that runs containers for you and keeps them healthy | You SSHing in + `pm2 start` |
| **EKS** | AWS-managed Kubernetes control plane (the "brain") | You managing the control plane yourself |
| **Node** | An EC2 that actually runs your containers | The EC2 from `Ec2_setup.md` |
| **Pod** | The smallest deployable unit — one (or few) containers | A single running process |
| **Deployment** | "Keep N copies of this Pod running, self-heal, roll updates" | pm2 with restart + replicas |
| **Service** | A stable internal address + load-balancing across Pods | nginx upstream / a fixed DNS name |
| **Ingress + ALB** | HTTP router that gives you ONE public URL and path-routes | nginx `location /` vs `/api/` |

**The single most important idea:** in Kubernetes you never say "start this process." You *declare
the desired state* ("I want 3 replicas of todo-server") in YAML, and K8s continuously makes reality
match it. That's the whole game.

**Request path you're building (the prod flow):**
```
Browser → AWS ALB (public) ──/────→ Service: todo-client → Pods (nginx + React build)
                            └─/api─→ Service: todo-server → Pods (Express) → Postgres (in-cluster or RDS)
```

**Focus / verify after Phase 0:**
- In your own words: what's the difference between a **Deployment**, a **Pod**, and a **Service**?
- Why does declaring "3 replicas" mean you never manually restart a crashed process again?

---

## 1. Tools & prerequisites (local machine)

Install these once:

| Tool | What it's for | Check |
|---|---|---|
| **AWS CLI** | Talk to AWS | `aws sts get-caller-identity` |
| **Docker Desktop** | Build/run images locally | `docker version` |
| **kubectl** | The K8s command-line client | `kubectl version --client` |
| **eksctl** | Easiest way to create/manage EKS clusters | `eksctl version` |
| **Helm** | K8s package manager (installs the LB controller) | `helm version` |

Install on Windows (PowerShell, with winget/choco):
```powershell
winget install -e --id Kubernetes.kubectl
winget install -e --id Weaveworks.eksctl        # or: choco install eksctl
winget install -e --id Helm.Helm
```

**Focus / verify after Phase 1:**
- All five commands above print a version.
- `aws configure get region` → `ap-south-1`.

---

## 2. Containerize the app (Docker) — before any cloud

You can't run on K8s until each part is an image. Build **two** images: `todo-server` and `todo-client`.

### 2a. Backend image — `server/Dockerfile`
```dockerfile
# server/Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8000
CMD ["node", "src/index.js"]
```

### 2b. Frontend image — `client/Dockerfile` (multi-stage: build, then serve with nginx)
```dockerfile
# client/Dockerfile
# --- build stage ---
FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build            # produces /app/dist

# --- serve stage ---
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# SPA fallback so React Router deep links work
RUN printf 'server {\n listen 80;\n root /usr/share/nginx/html;\n location / { try_files $uri /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
```
> Note: in EKS the **ALB** will route `/api` to the backend, so the client image only serves static
> files — it does **not** proxy `/api` itself (that was the single-box nginx's job).

### 2c. Test locally before pushing anywhere
```bash
docker build -t todo-server ./server
docker build -t todo-client ./client
docker network create todo-net
docker run -d --name pg --network todo-net -e POSTGRES_DB=appdb -e POSTGRES_USER=app_admin -e POSTGRES_PASSWORD=AppPass123! postgres:15
docker run -d --name api --network todo-net -p 8000:8000 \
  -e PGHOST=pg -e PGUSER=app_admin -e PGPASSWORD=AppPass123! -e PGDATABASE=appdb -e PGSSL=false todo-server
docker exec api npm run migrate
curl localhost:8000/health          # {"status":"ok","db":"connected"}
docker run -d --name web --network todo-net -p 8080:80 todo-client
# open http://localhost:8080 in the browser — the app should load and talk to the API on :8000
```

**Focus / verify after Phase 2:**
- Both images build with no errors (`docker images` shows them).
- The API container talks to the Postgres container and `/health` is OK. **If it works in Docker,
  the image is correct — any later failure is a K8s/networking problem, not an app problem.**
- Understand *why* the frontend is multi-stage: you build with Node but ship only static files on nginx (tiny, no Node in the final image).

---

## 3. ECR — push your images to AWS's registry

K8s nodes pull images from a registry; they can't see your laptop. Push both images to ECR.

```bash
ACCOUNT=786174827428
REGION=ap-south-1
ECR=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com

# 1. Create one repo per image
aws ecr create-repository --repository-name todo-server --region $REGION
aws ecr create-repository --repository-name todo-client --region $REGION

# 2. Log Docker in to ECR (token valid ~12h)
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ECR

# 3. Tag local images with the ECR URL, then push
docker tag todo-server:latest $ECR/todo-server:v1
docker tag todo-client:latest $ECR/todo-client:v1
docker push $ECR/todo-server:v1
docker push $ECR/todo-client:v1
```

**Focus / verify after Phase 3:**
- `aws ecr list-images --repository-name todo-server --region ap-south-1` shows tag `v1`.
- Understand the image URL format: `<account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>`. K8s will reference exactly this string.
- **Use real version tags (`v1`, `v2`), not `latest`.** `latest` makes it impossible to know what's actually running or to roll back — a core prod discipline.

---

## 4. Create the EKS cluster (eksctl)

`eksctl` builds the whole stack for you: a dedicated VPC, subnets, the managed control plane, and a
managed node group (the EC2s that run your Pods).

```bash
eksctl create cluster \
  --name todo-eks \
  --region ap-south-1 \
  --version 1.31 \
  --nodegroup-name ng-1 \
  --node-type t3.medium \
  --nodes 2 --nodes-min 2 --nodes-max 4 \
  --managed
```
This takes **~15–20 min** (it's creating a CloudFormation stack). When done, eksctl writes your
kubeconfig automatically so `kubectl` points at the new cluster.

**What just got created (map it to what you already know):**
| EKS piece | You built this by hand before |
|---|---|
| Dedicated VPC + public/private subnets | Your `prod-vpc` phases |
| Control plane (API server, scheduler, etcd) | *AWS manages this — you can't SSH to it* |
| Managed node group (2× t3.medium EC2) | The single EC2 in `Ec2_setup.md`, ×2 |

**Focus / verify after Phase 4:**
```bash
kubectl get nodes                 # 2 nodes, STATUS Ready
kubectl get pods -A               # system pods (coredns, kube-proxy, aws-node) Running
eksctl get cluster --region ap-south-1
```
- You should see 2 `Ready` nodes. These are just EC2s — find them in the EC2 console.
- Understand: the **control plane is managed by AWS** (you pay ~$0.10/hr for it); you only manage the nodes and your workloads.

---

## 5. kubectl fundamentals (spend real time here)

Before deploying, get fluent with the verbs you'll use constantly:
```bash
kubectl get <pods|deploy|svc|ingress|nodes>     # list
kubectl get pods -o wide                         # + node & IP
kubectl describe pod <name>                       # events, why it's not starting
kubectl logs <pod> [-f]                            # app logs (like pm2 logs)
kubectl exec -it <pod> -- sh                       # shell into a container
kubectl apply -f file.yaml                          # declare desired state
kubectl delete -f file.yaml
kubectl get events --sort-by=.lastTimestamp        # cluster-wide "what just happened"
```

**Focus / verify after Phase 5:**
- Create the app namespace and set it as default context so you stop typing `-n`:
  ```bash
  kubectl create namespace todo
  kubectl config set-context --current --namespace=todo
  ```
- You can list pods, describe one, and read its logs without looking anything up.

---

## 6. The database — pick your path

Two valid approaches. **Do Path A first to learn K8s storage, then graduate to Path B (real prod).**

### Path A — Postgres *inside* the cluster (learn StatefulSets + PVCs)
Teaches you persistent storage in K8s. Needs the **EBS CSI driver** so a Pod can get a real EBS volume.
```bash
# enable IAM OIDC (needed for addons that use IAM) and the EBS CSI driver
eksctl utils associate-iam-oidc-provider --cluster todo-eks --region ap-south-1 --approve
eksctl create addon --name aws-ebs-csi-driver --cluster todo-eks --region ap-south-1 --force
```
Then a `StatefulSet` + `volumeClaimTemplates` (PVC) for Postgres, fronted by a **headless Service**
`todo-db:5432`. (Manifest in Phase 7.)

### Path B — Amazon RDS (the real prod choice)
Managed backups, failover, patching. Put RDS in the EKS VPC's private subnets, security group allows
`5432` from the node group SG. The app just points `PGHOST` at the RDS endpoint. (You already planned
RDS in `DEPLOYMENT_PLAN.md` Phase 5 — reuse that thinking.)

**Focus / verify after Phase 6:**
- Explain why a stateless web Pod is easy to kill/recreate but a **database** Pod needs a
  **PersistentVolume** — the data must outlive the Pod.
- Decide your path and note it here. (Recommended: A now, B later.)

---

## 7. Kubernetes manifests — declare the app

Create a `k8s/` folder. These are the core objects. Replace `<ECR>` with your registry URL.

### 7a. Config + secret (never bake DB creds into images)
```yaml
# k8s/config.yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: todo-config, namespace: todo }
data:
  PGHOST: "todo-db"        # Path A service name (or RDS endpoint for Path B)
  PGPORT: "5432"
  PGDATABASE: "appdb"
  PGSSL: "false"           # "true" for RDS
  PORT: "8000"
---
apiVersion: v1
kind: Secret
metadata: { name: todo-secret, namespace: todo }
type: Opaque
stringData:
  PGUSER: "app_admin"
  PGPASSWORD: "AppPass123!"
```

### 7b. Backend Deployment + Service
```yaml
# k8s/server.yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: todo-server, namespace: todo }
spec:
  replicas: 2
  selector: { matchLabels: { app: todo-server } }
  template:
    metadata: { labels: { app: todo-server } }
    spec:
      containers:
        - name: server
          image: <ECR>/todo-server:v1
          ports: [{ containerPort: 8000 }]
          envFrom:
            - configMapRef: { name: todo-config }
            - secretRef:   { name: todo-secret }
          readinessProbe:                     # don't send traffic until DB is reachable
            httpGet: { path: /health, port: 8000 }
            initialDelaySeconds: 5
          livenessProbe:                      # restart the Pod if it hangs
            httpGet: { path: /health, port: 8000 }
            initialDelaySeconds: 15
          resources:
            requests: { cpu: "100m", memory: "128Mi" }
            limits:   { cpu: "500m", memory: "256Mi" }
---
apiVersion: v1
kind: Service
metadata: { name: todo-server, namespace: todo }
spec:
  selector: { app: todo-server }
  ports: [{ port: 8000, targetPort: 8000 }]
  type: ClusterIP                              # internal only — the ALB reaches it
```

### 7c. Frontend Deployment + Service
```yaml
# k8s/client.yaml — same shape: Deployment (image todo-client:v1, containerPort 80) + ClusterIP Service on port 80
```

### 7d. Run the migration once (a K8s Job)
```bash
kubectl run migrate --image=<ECR>/todo-server:v1 --restart=Never \
  --env-from=configmap/todo-config --env-from=secret/todo-secret \
  --command -- node src/migrate.js
# (or write a proper Job manifest; delete the pod after it Completes)
```

Apply everything:
```bash
kubectl apply -f k8s/
kubectl get pods            # todo-server + todo-client Pods Running
```

**Focus / verify after Phase 7:**
- All Pods `Running` and `READY 1/1`. If not: `kubectl describe pod` + `kubectl logs`.
- Test internally (no public URL yet):
  ```bash
  kubectl port-forward svc/todo-server 8000:8000
  curl localhost:8000/health          # from your laptop through the tunnel
  ```
- Understand `readinessProbe` vs `livenessProbe`: readiness = "ready for traffic?", liveness = "still alive or restart me?". This is how K8s self-heals.

---

## 8. Load balancing — start simple: `type: LoadBalancer`

Change the **client** Service to `type: LoadBalancer` and K8s asks AWS to create a real load
balancer (an NLB/CLB) with a public DNS name pointing at your Pods.

```yaml
# temporarily, on the client Service:
spec:
  type: LoadBalancer
```
```bash
kubectl apply -f k8s/client.yaml
kubectl get svc todo-client -w        # wait for EXTERNAL-IP → an AWS DNS name
curl http://<external-dns>/           # the React app, publicly!
```

**Focus / verify after Phase 8:**
- You get a public AWS DNS name and the site loads. **This is your first "K8s made a load balancer for me" moment.**
- Understand the limitation: a `LoadBalancer` Service = **one LB per Service** and it's L4 (TCP), no
  path routing. To route `/` → client and `/api` → server on **one** URL, you need an **Ingress** (next phase).
- Revert client back to `ClusterIP` before Phase 9 (the ALB Ingress will be the single entry point).

---

## 9. The real prod flow — ALB Ingress (path routing, one URL)

This is the phase that teaches "how a load balancer really works" in prod. You install the **AWS Load
Balancer Controller**, then write **one Ingress** that provisions an **ALB** routing by path.

### 9a. Install the AWS Load Balancer Controller (uses IRSA — IAM for a K8s service account)
```bash
REGION=ap-south-1; CLUSTER=todo-eks; ACCOUNT=786174827428

# 1. OIDC provider (done in Phase 6 Path A; safe to re-run)
eksctl utils associate-iam-oidc-provider --cluster $CLUSTER --region $REGION --approve

# 2. IAM policy the controller needs
curl -O https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.9.0/docs/install/iam_policy.json
aws iam create-policy --policy-name AWSLoadBalancerControllerIAMPolicy --policy-document file://iam_policy.json

# 3. A K8s service account bound to that IAM policy (IRSA)
eksctl create iamserviceaccount \
  --cluster $CLUSTER --region $REGION --namespace kube-system \
  --name aws-load-balancer-controller \
  --attach-policy-arn arn:aws:iam::$ACCOUNT:policy/AWSLoadBalancerControllerIAMPolicy \
  --approve

# 4. Install the controller via Helm
helm repo add eks https://aws.github.io/eks-charts && helm repo update
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system --set clusterName=$CLUSTER \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller
kubectl get deploy -n kube-system aws-load-balancer-controller     # Available
```

### 9b. The Ingress (this creates the ALB)
```yaml
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: todo-ingress
  namespace: todo
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
spec:
  rules:
    - http:
        paths:
          - path: /api                       # /api/* → backend
            pathType: Prefix
            backend: { service: { name: todo-server, port: { number: 8000 } } }
          - path: /                           # everything else → frontend
            pathType: Prefix
            backend: { service: { name: todo-client, port: { number: 80 } } }
```
```bash
kubectl apply -f k8s/ingress.yaml
kubectl get ingress todo-ingress -w          # ADDRESS → the ALB DNS name
```

**Focus / verify after Phase 9:**
```bash
ALB=$(kubectl get ingress todo-ingress -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
curl http://$ALB/                            # React app
curl http://$ALB/api/todos                   # API — same URL, different path!
```
- **This is the real prod entry point:** one ALB, one URL, path-routed to two services, traffic
  spread across all Pods. Find the ALB in the EC2 console → Load Balancers and read its listener rules.
- Explain the layers: **Ingress** (your declared intent) → **LB Controller** (watches Ingress, calls AWS APIs) → **ALB** (the actual AWS resource). This "controller watches desired state and reconciles" pattern *is* Kubernetes.

---

## 10. Scaling & self-healing (see K8s do its job)

```bash
# Manual scale
kubectl scale deployment todo-server --replicas=4
kubectl get pods -w                          # watch new Pods appear + register with the ALB

# Self-healing — delete a Pod, watch K8s recreate it
kubectl delete pod <one-todo-server-pod>
kubectl get pods                             # a replacement is already coming up

# Rolling update — push v2 and update the image with zero downtime
kubectl set image deployment/todo-server server=<ECR>/todo-server:v2
kubectl rollout status deployment/todo-server
kubectl rollout undo deployment/todo-server  # instant rollback

# Autoscale on CPU (needs metrics-server)
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl autoscale deployment todo-server --cpu-percent=50 --min=2 --max=6
kubectl get hpa
```

**Focus / verify after Phase 10:**
- Kill a Pod and confirm the app never goes down (the ALB routes around it, K8s replaces it). **This is the entire value proposition of Kubernetes — see it with your own eyes.**
- Do a `v1 → v2` rolling update and watch Pods replace gradually with no failed requests.

---

## 11. Observability (how you debug prod)

```bash
kubectl get events --sort-by=.lastTimestamp
kubectl logs -f deploy/todo-server
kubectl top pods                             # live CPU/mem (needs metrics-server)
kubectl describe ingress todo-ingress        # ALB wiring + any errors
```
- (Optional) Enable **CloudWatch Container Insights** for dashboards/log aggregation.

**Focus / verify after Phase 11:**
- Given a Pod stuck in `CrashLoopBackOff`, you know the drill: `describe` (events) → `logs` (app error) → fix → `apply`.

---

## 12. Production hardening (the checklist real teams use)

| Area | Do this |
|---|---|
| **Secrets** | Move `todo-secret` out of YAML → AWS Secrets Manager + External Secrets Operator, or SSM. |
| **DB** | Graduate Path A → **RDS** (Path B): backups, multi-AZ, no data loss on Pod churn. |
| **Images** | Scan in ECR (`scanOnPush`), pin digests, never `latest`. |
| **Networking** | NetworkPolicies so only `todo-server` can reach the DB; private node subnets. |
| **HTTPS** | ACM cert on the ALB via `alb.ingress.kubernetes.io/certificate-arn`; redirect 80→443. |
| **Resources** | Every container has requests/limits (already in Phase 7) — prevents noisy-neighbor. |
| **Access** | Least-privilege IAM via **IRSA** per workload (like the LB controller). |

**Focus / verify after Phase 12:**
- No plaintext secret sits in a committed YAML.
- Hitting the site over **HTTPS** works and HTTP redirects to it.

---

## 13. CI/CD — the automated prod deploy loop

The manual flow you did (`docker build → push → kubectl set image`) becomes a pipeline:
```
git push → CI builds image → pushes to ECR (tagged with git SHA) → updates the Deployment image → kubectl rollout
```
- Start with a **GitHub Actions** workflow doing exactly the Phase 3 + Phase 10 commands.
- Later, learn **GitOps** (Argo CD / Flux): the cluster pulls desired state from a git repo of your
  `k8s/` manifests — the fully declarative end state.

**Focus / verify after Phase 13:**
- A `git push` results in new Pods running the new image, with zero manual `kubectl`.

---

## 14. Cost & teardown ⚠️ (EKS is NOT free)

**EKS bills even when idle:** ~$0.10/hr control plane **plus** the node EC2s **plus** the ALB **plus**
any EBS/RDS. Always tear down after a learning session.

```bash
kubectl delete -f k8s/                                        # removes Ingress → deletes the ALB
helm uninstall aws-load-balancer-controller -n kube-system
eksctl delete cluster --name todo-eks --region ap-south-1     # nukes nodes, VPC, control plane
# optionally:
aws ecr delete-repository --repository-name todo-server --force --region ap-south-1
aws ecr delete-repository --repository-name todo-client --force --region ap-south-1
```
> Delete the **Ingress first** so the LB Controller removes the ALB. If you delete the cluster while
> an ALB it created still exists, you can orphan the ALB and keep paying for it.

**Focus / verify after Phase 14:**
- `eksctl get cluster` → none. EC2 console → no lingering nodes/ALB. **Confirm $0 like you did in `TRACKER.md`.**

---

## Suggested learning order (TL;DR)

1. **Phase 0–1** — concepts + tools (don't skip the mental model).
2. **Phase 2–3** — containerize + push to ECR (prove the image works in plain Docker first).
3. **Phase 4–5** — create cluster + get fluent with `kubectl`.
4. **Phase 6–7** — DB + deploy the app (internal only).
5. **Phase 8** — `type: LoadBalancer` for the "aha, a public LB!" moment.
6. **Phase 9** — ALB Ingress = the real prod entry point (the main event).
7. **Phase 10–11** — scale, self-heal, roll updates, debug.
8. **Phase 12–13** — harden + automate.
9. **Phase 14** — tear down, confirm $0.

# Todo CRUD App (3-tier)

A simple full-stack todo list.

- **client/** — React (Vite) frontend
- **server/** — Express + Node backend, PostgreSQL via the `pg` library
- **terraform/** — AWS RDS PostgreSQL for the database tier

## Prerequisites

- Node.js 18+
- A PostgreSQL database (local, or the RDS instance from `terraform/`)

## 1. Server

```bash
cd server
cp .env.example .env      # edit DB values (PGHOST, PGPASSWORD, ...)
npm install
npm run migrate           # creates the `todos` table
npm run dev               # http://localhost:4000
```

For AWS RDS, set `PGHOST` to the endpoint from `terraform output db_instance_address`,
use the password from Secrets Manager, and set `PGSSL=true`.

## 2. Client

```bash
cd client
npm install
npm run dev               # http://localhost:5173
```

The Vite dev server proxies `/api/*` to the Express server on port 4000.

## API

| Method | Route              | Description        |
| ------ | ------------------ | ------------------ |
| GET    | `/api/todos`       | List todos         |
| POST   | `/api/todos`       | Create a todo      |
| PUT    | `/api/todos/:id`   | Update a todo      |
| DELETE | `/api/todos/:id`   | Delete a todo      |
| GET    | `/health`          | DB health check    |

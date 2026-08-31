# PostgreSQL Continuous WAL Archiving & Point-In-Time Recovery (PITR) Operational Guide

This document defines the exact production infrastructure specification and step-by-step commands to execute a real PostgreSQL Continuous WAL Archiving and Point-In-Time Recovery (PITR) backup & restore drill.

---

## 1. Minimal Production Architecture (`docker-compose.yml`)

Save the following manifest to `docker-compose.yml`:

```yaml
version: '3.8'

services:
  postgres-primary:
    image: postgres:16-alpine
    container_name: buzzz_postgres_primary
    environment:
      POSTGRES_DB: buzzz_db
      POSTGRES_USER: buzzz_app
      POSTGRES_PASSWORD: production_secret_pass
    ports:
      - "5432:5432"
    volumes:
      - pgdata_primary:/var/lib/postgresql/data
      - wal_archive:/var/lib/postgresql/wal_archive
    command: >
      postgres
      -c wal_level=replica
      -c archive_mode=on
      -c archive_command='test ! -f /var/lib/postgresql/wal_archive/%f && cp %p /var/lib/postgresql/wal_archive/%f'
      -c archive_timeout=60

volumes:
  pgdata_primary:
  wal_archive:
```

---

## 2. Execution Command Sequence for Real PITR Restore Drill

### Step A: Initialize Database & Run Migrations
```bash
# 1. Start primary database container
docker-compose up -d postgres-primary

# 2. Run all 13 BUZZZ migrations
DATABASE_URL="postgres://buzzz_app:production_secret_pass@localhost:5432/buzzz_db" npm run migrate
```

### Step B: Seed Baseline Data & Trigger Nightly Base Backup
```bash
# 1. Take a physical base backup snapshot
docker exec -t buzzz_postgres_primary pg_basebackup \
  -U buzzz_app \
  -D /var/lib/postgresql/wal_archive/basebackup_snapshot \
  -Ftar -z -P

# 2. Record current timestamp for point-in-time target
export PITR_RESTORE_TIME=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

# 3. Perform a data write after the base backup (to verify WAL replay)
docker exec -i buzzz_postgres_primary psql -U buzzz_app -d buzzz_db \
  -c "INSERT INTO contacts (id, workspace_id, name, email) VALUES ('00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Post-Backup Lead', 'wal_test@buzzz.io');"
```

### Step C: Execute Point-In-Time Recovery (PITR) into Isolated Target
```bash
# 1. Stop primary and prepare clean restore target volume
docker-compose stop postgres-primary

# 2. Extract base backup into clean restore directory
tar -xzf /var/lib/postgresql/wal_archive/basebackup_snapshot/base.tar.gz -C /tmp/pgdata_restored

# 3. Create signal file recovery.signal and configure recovery target in postgresql.conf
touch /tmp/pgdata_restored/recovery.signal
echo "restore_command = 'cp /var/lib/postgresql/wal_archive/%f %p'" >> /tmp/pgdata_restored/postgresql.conf
echo "recovery_target_time = '${PITR_RESTORE_TIME}'" >> /tmp/pgdata_restored/postgresql.conf

# 4. Start restored Postgres instance
docker run -d --name buzzz_postgres_restored \
  -v /tmp/pgdata_restored:/var/lib/postgresql/data \
  -v wal_archive:/var/lib/postgresql/wal_archive \
  postgres:16-alpine

# 5. Verify restored rows via psql query
docker exec -t buzzz_postgres_restored psql -U buzzz_app -d buzzz_db \
  -c "SELECT count(*) FROM contacts;"
```

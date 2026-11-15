#!/bin/bash
# Start or stop the throwaway local server of one engine, with its data on RAM (tmpfs), so a run leaves nothing on disk.
#   servers.sh up <label>    start it and wait until it answers
#   servers.sh down <label>  remove it
# Ports and URLs are the ones in servers.txt. Images are the official ones; nothing here needs an account.
set -u
action="$1"; label="$2"
name="supply-$label"
T() { echo "--tmpfs $1:rw,size=${2:-2g},mode=1777"; }

up() {
  case "$label" in
    postgres)  docker run -d --name "$name" -p 15432:5432 -e POSTGRES_PASSWORD=supply $(T /var/lib/postgresql/data) postgres:17-alpine -c max_connections=300 -c fsync=on >/dev/null
               until docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done; sleep 2 ;;
    cockroach) docker run -d --name "$name" -p 15433:26257 $(T /cockroach/cockroach-data 1g) cockroachdb/cockroach:latest start-single-node --insecure --store=type=mem,size=3GiB --cache=512MiB >/dev/null
               until docker exec "$name" cockroach sql --insecure -e "select 1" >/dev/null 2>&1; do sleep 2; done ;;
    mysql)     docker run -d --name "$name" -p 13306:3306 -e MYSQL_ROOT_PASSWORD=supply $(T /var/lib/mysql) mysql:8.4 --max-connections=300 --skip-log-bin >/dev/null
               until docker exec "$name" mysqladmin -uroot -psupply ping >/dev/null 2>&1; do sleep 2; done; sleep 3 ;;
    mariadb)   docker run -d --name "$name" -p 13307:3306 -e MARIADB_ROOT_PASSWORD=supply $(T /var/lib/mysql) mariadb:11 --max-connections=300 --skip-log-bin >/dev/null
               until docker exec "$name" mariadb-admin -uroot -psupply ping >/dev/null 2>&1; do sleep 2; done; sleep 3 ;;
    redis)     docker run -d --name "$name" -p 16379:6379 $(T /data 1g) redis:7-alpine redis-server --appendonly yes --appendfsync always >/dev/null
               until docker exec "$name" redis-cli ping >/dev/null 2>&1; do sleep 1; done ;;
    valkey)    docker run -d --name "$name" -p 16380:6379 $(T /data 1g) valkey/valkey:8 valkey-server --appendonly yes --appendfsync always >/dev/null
               until docker exec "$name" valkey-cli ping >/dev/null 2>&1; do sleep 1; done ;;
    dynamodb)  docker run -d --name "$name" -p 18000:8000 amazon/dynamodb-local:latest -jar DynamoDBLocal.jar -sharedDb -inMemory >/dev/null
               until curl -s -m 2 -o /dev/null localhost:18000; do sleep 1; done; sleep 2 ;;
    minio)     docker run -d --name "$name" -p 19000:9000 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=miniosecret $(T /data) cgr.dev/chainguard/minio:latest server /data --address :9000 >/dev/null
               until curl -s -m 2 -o /dev/null localhost:19000/minio/health/live; do sleep 1; done ;;
    mongo)     docker run -d --name "$name" -p 27117:27017 $(T /data/db) mongo:7 --replSet rs0 --bind_ip_all >/dev/null
               until docker exec "$name" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1; do sleep 1; done
               docker exec "$name" mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})' >/dev/null
               until docker exec "$name" mongosh --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -q true; do sleep 1; done ;;
    ferretdb)  docker run -d --name "$name" -p 27118:27017 -e FERRETDB_HANDLER=sqlite -e FERRETDB_STATE_DIR=- $(T /state 1g) ghcr.io/ferretdb/ferretdb:1 >/dev/null
               until [ "$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null)" = healthy ]; do sleep 2; done ;;
    couchdb)   docker run -d --name "$name" -p 15984:5984 -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=supply $(T /opt/couchdb/data) couchdb:3 >/dev/null
               until curl -s -m 2 -u admin:supply localhost:15984/_up | grep -q ok; do sleep 2; done ;;
    surreal)   docker run -d --name "$name" --user root -p 18001:8000 $(T /data) surrealdb/surrealdb:latest start --user root --pass root --log warn rocksdb:/data/db >/dev/null
               until curl -s -m 2 localhost:18001/version >/dev/null; do sleep 1; done; sleep 2 ;;
    libsql)    docker run -d --name "$name" -p 18002:8080 -p 19090:9090 $(T /var/lib/sqld) ghcr.io/tursodatabase/libsql-server:latest sqld --http-listen-addr 0.0.0.0:8080 --admin-listen-addr 0.0.0.0:9090 --enable-store names >/dev/null
               until curl -s -m 2 -o /dev/null localhost:19090/v1/namespaces; do sleep 1; done; sleep 2 ;;
    *) echo "no server named $label" >&2; exit 2 ;;
  esac
}

case "$action" in
  up) docker container remove -f "$name" >/dev/null 2>&1; up ;;
  down) docker container remove -f -v "$name" >/dev/null 2>&1 ;;
  *) echo "usage: servers.sh up|down <label>" >&2; exit 2 ;;
esac

#!/bin/sh
# Creates the seven databases and their seven roles, once.
#
# The official Postgres image runs everything in
# /docker-entrypoint-initdb.d ONCE — on the very first start, when the data
# directory is empty. It is not a migration system and it is not re-run when
# you edit it: if you change this file, you must also delete the volume
# (`docker compose down -v`) or nothing happens, which is the single most
# common confusion with this image.
#
# WHY A SHELL SCRIPT AND NOT PLAIN .sql. The passwords come from the
# environment — the same `.env` the application reads — and an SQL file
# cannot interpolate them. Writing them as literals here would put seven
# credentials into git.
#
# ONE ROLE PER SERVICE, each owning exactly one database. This is what makes
# "no service reads another service's tables" a fact about the deployment
# rather than a promise about the code: the Cart Service's credentials simply
# cannot open the orders database. It is the same arrangement as the local
# setup, which is the point — a container environment that is configured more
# loosely than the laptop teaches the wrong habits.
set -e

create_service_database() {
  role="$1"
  database="$2"
  password="$3"

  if [ -z "$password" ]; then
    echo "postgres-init: no password for $role — check your .env" >&2
    exit 1
  fi

  # `psql -v ON_ERROR_STOP=1` so a failure here fails the container start,
  # rather than leaving a half-built cluster that looks fine until the first
  # service cannot log in.
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE ROLE $role WITH LOGIN PASSWORD '$password';
    CREATE DATABASE $database OWNER $role;
    -- Revoke the PUBLIC connect grant, so ONLY the owner (and superusers)
    -- can open this database. Without this, every role in the cluster can
    -- connect to every database by default — including the other six
    -- services.
    REVOKE CONNECT ON DATABASE $database FROM PUBLIC;
    GRANT CONNECT ON DATABASE $database TO $role;
EOSQL

  echo "postgres-init: created $database owned by $role"
}

create_service_database ecommerce_auth_service         ecommerce_auth_db         "$AUTH_DB_PASSWORD"
create_service_database ecommerce_product_service      ecommerce_product_db      "$PRODUCT_DB_PASSWORD"
create_service_database ecommerce_inventory_service    ecommerce_inventory_db    "$INVENTORY_DB_PASSWORD"
create_service_database ecommerce_cart_service         ecommerce_cart_db         "$CART_DB_PASSWORD"
create_service_database ecommerce_order_service        ecommerce_order_db        "$ORDER_DB_PASSWORD"
create_service_database ecommerce_payment_service      ecommerce_payment_db      "$PAYMENT_DB_PASSWORD"
create_service_database ecommerce_notification_service ecommerce_notification_db "$NOTIFICATION_DB_PASSWORD"

echo "postgres-init: seven databases ready"

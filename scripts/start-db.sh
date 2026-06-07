#!/usr/bin/env bash
# Start a local SpacetimeDB instance for VoltPass.
#
# This generates a local JWT signing keypair on first run (so `spacetime start`
# works deterministically across versions) and launches the server on :3000.
set -euo pipefail

DATA_DIR="${VOLTPASS_DATA_DIR:-$HOME/.voltpass/data}"
KEY_DIR="${VOLTPASS_KEY_DIR:-$HOME/.voltpass/keys}"
LISTEN="${VOLTPASS_LISTEN:-127.0.0.1:3000}"

mkdir -p "$DATA_DIR" "$KEY_DIR"

if [ ! -f "$KEY_DIR/id_ecdsa.pem" ]; then
  echo "Generating local JWT keypair in $KEY_DIR ..."
  openssl ecparam -name prime256v1 -genkey -noout -out "$KEY_DIR/id_ecdsa.sec1.pem"
  openssl pkcs8 -topk8 -nocrypt -in "$KEY_DIR/id_ecdsa.sec1.pem" -out "$KEY_DIR/id_ecdsa.pem"
  openssl ec -in "$KEY_DIR/id_ecdsa.sec1.pem" -pubout -out "$KEY_DIR/id_ecdsa.pub.pem"
fi

cat > "$DATA_DIR/config.toml" <<EOF
[certificate-authority]
jwt-priv-key-path = "$KEY_DIR/id_ecdsa.pem"
jwt-pub-key-path = "$KEY_DIR/id_ecdsa.pub.pem"

[logs]
level = "ERROR"
EOF

echo "Starting SpacetimeDB on $LISTEN (data: $DATA_DIR)"
exec spacetime start --data-dir "$DATA_DIR" --listen-addr "$LISTEN"

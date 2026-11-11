#!/bin/sh
set -eu
/usr/bin/docker run --rm --network host -v /opt/ferrydrop/acme/config:/etc/letsencrypt -v /opt/ferrydrop/acme/work:/var/lib/letsencrypt -v /opt/ferrydrop/acme/logs:/var/log/letsencrypt certbot/certbot:latest renew --quiet --cert-name ferrydrop-ip
source=/opt/ferrydrop/acme/config/live/ferrydrop-ip
if ! cmp -s "$source/fullchain.pem" /opt/ferrydrop/certs/server.pem || ! cmp -s "$source/privkey.pem" /opt/ferrydrop/certs/server-key.pem; then
  install -o root -g 1000 -m 640 "$source/fullchain.pem" /opt/ferrydrop/certs/server.pem.new
  install -o root -g 1000 -m 640 "$source/privkey.pem" /opt/ferrydrop/certs/server-key.pem.new
  mv /opt/ferrydrop/certs/server.pem.new /opt/ferrydrop/certs/server.pem
  mv /opt/ferrydrop/certs/server-key.pem.new /opt/ferrydrop/certs/server-key.pem
  /usr/bin/docker restart ferrydrop
fi

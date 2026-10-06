# Deploying postgres2mcp

postgres2mcp is one container and one volume. This page covers getting it onto a server with a domain and a certificate, and keeping it there.

- [The installer](#the-installer)
- [DNS and the certificate](#dns-and-the-certificate)
- [The first account](#the-first-account)
- [The database](#the-database)
- [Without the installer](#without-the-installer)
- [Behind your own reverse proxy](#behind-your-own-reverse-proxy)
- [Day to day](#day-to-day): logs, updates, backups, moving, removing
- [When something is wrong](#when-something-is-wrong)
- [Before you call it done](#before-you-call-it-done)

## The installer

```sh
curl -fsSL https://raw.githubusercontent.com/Railcode-HQ/postgres2mcp/main/install.sh | bash
```

**What you need**

- A machine that stays on: any Linux server (a small VPS is plenty), or a Mac for trying it out.
- Docker with Compose v2. On Linux the installer offers to install it with Docker's own script if it is missing.
- The connection string of the database to expose, reachable from that machine.
- For HTTPS: a domain or subdomain you can create a DNS record for, and ports 80 and 443 open to the internet and not used by something else.

**Before it asks anything**, it checks that Docker with Compose v2 is installed and answering. If not, it stops there and says how to install or start it (on Linux it offers to install Docker for you), so no question is answered for nothing.

**What it asks**

1. *Which database should it expose?* A connection string: `postgres://user:password@host:5432/dbname`.
2. *Domain for HTTPS?* Something like `mcp.example.com`, or nothing.

**What it does**, in order:

1. Checks that the ports it needs are free.
2. With a domain: looks up the name. If it does not point at the machine yet, it shows the record to create, so you can do that while the next steps run.
3. Fetches postgres2mcp into `~/postgres2mcp` (`/opt/postgres2mcp` when run as root) and writes its settings to `.env` there, readable only by you.
4. Builds the image and starts the server.
5. Checks that the database answers. If it does not, it shows what Postgres said and lets you enter a different connection string on the spot.
6. With a domain: waits for the DNS record, starts Caddy, and waits until `https://your.domain` answers with a valid certificate.
7. Prints the link that creates your admin account.

Nothing in that list is destructive, and every step is safe to repeat: **run the installer again** to update to the latest version, to change the database or the domain, or to pick up where a run stopped (for instance after a DNS record that took too long). It reads what it was told before from `.env` and only asks for what is missing.

**Options**

| Option | Environment | |
|---|---|---|
| `--database-url URL` | `DATABASE_URL` | The database to expose. |
| `--domain NAME` | `P2M_DOMAIN` | Serve over HTTPS at this domain. |
| `--port N` | `PORT` | The port when there is no domain. Default `3333`. |
| `--dir PATH` | `P2M_DIR` | Where to install. |
| `--skip-dns-check` | | Do not wait for the domain to point at this machine. |
| `-y`, `--yes` | | Ask nothing; fail if something required is missing. |
| `--uninstall` | | Stop postgres2mcp and say how to remove what is left. |

Pass options through `bash` when piping:

```sh
curl -fsSL https://raw.githubusercontent.com/Railcode-HQ/postgres2mcp/main/install.sh | bash -s -- \
  --yes --database-url 'postgres://user:password@host:5432/dbname' --domain mcp.example.com
```

Unattended, the installer waits up to 30 minutes for DNS (`P2M_DNS_TIMEOUT`, in seconds) and exits with status 1 if the name still does not point at the machine, or 2 if everything is running but the certificate has not arrived yet. Run it again once the cause is fixed.

If you would rather read a script before running it, [it is here](../install.sh); or clone the repository and run `./install.sh` from the checkout, which sets up that checkout in place.

**What it leaves on the machine**

```text
~/postgres2mcp/           the source, at the version it fetched
  .env                    your settings (mode 600): DATABASE_URL, P2M_DOMAIN, P2M_SETUP_TOKEN, …
  docker-compose.yml      the server, and Caddy under the "tls" profile
  Caddyfile               Caddy's configuration
Docker volumes
  postgres2mcp_postgres2mcp-data   accounts, key hashes, custom tools, settings, logs
  postgres2mcp_caddy-data          the certificate and its account key
```

## DNS and the certificate

HTTPS needs a public name that leads to the machine. The installer shows the record to create:

```text
Type   Name              Value
A      mcp.example.com   203.0.113.7
```

Create it at whoever runs DNS for the domain. The installer then checks about every ten seconds, asking public resolvers directly so that a stale local cache does not hide a record you have just created, and continues by itself the moment the name resolves to the machine. A new record on a new name usually takes under a minute; changing an existing record takes as long as its old TTL. Press `s` to stop waiting and carry on.

Then Caddy asks Let's Encrypt for a certificate, which takes a few seconds, and renews it from then on without anything for you to do. The certificate lives in the `caddy-data` volume, so restarts and updates do not ask for a new one.

Things that get in the way:

- **Cloudflare's proxy** (the orange cloud). With it on, the name resolves to Cloudflare, not to your machine, so the wait never finishes. Set the record to "DNS only" at least until the certificate is issued; or keep the proxy, pass `--skip-dns-check`, and set Cloudflare's SSL mode to "Full (strict)".
- **An AAAA (IPv6) record that points somewhere else.** Let's Encrypt may validate over IPv6 and miss your machine. The installer warns about this; remove the record or point it at the machine.
- **A firewall.** Ports 80 and 443 must be reachable from the internet: 80 for the certificate challenge and the redirect to HTTPS, 443 for everything else. On cloud providers this is usually a "security group" or "firewall" setting outside the machine.
- **Repeated failures.** Let's Encrypt limits failed validations to five an hour per name. This is why the installer waits for DNS before starting Caddy rather than letting it try and fail.

### Without a domain

Leave the domain empty and the server listens on port 3333 over plain HTTP. That is fine on your own machine or inside a private network, and not for anything reachable from the internet: sign-ins, sessions and API keys would travel unencrypted.

For a server you can only reach over SSH, keep the port off the public interface and tunnel to it. In `.env`:

```sh
P2M_BIND='127.0.0.1'
```

then `docker compose up -d`, and from your own machine:

```sh
ssh -L 3333:localhost:3333 you@server     # the dashboard is now at http://localhost:3333
```

## The first account

A new server has no account, and the first one is created in the dashboard. So that this is you and not whoever finds the address first, the installer starts the server with a setup code and prints a link carrying it:

```text
https://mcp.example.com/?setup=3f9c…
```

Open it, choose a username and a password, and you are in. Without the code the form asks for it and refuses to create the account. Once an account exists the code opens nothing.

If you lose the link, it is in the server's startup log (`docker compose logs postgres2mcp`) until the account is created. The installer saves its code as `P2M_SETUP_TOKEN` in `.env`. When started manually without that setting, the server generates a random code on each startup; use the newest link. Setup never accepts a missing code.

Two other ways to get the first account, for deploys with nobody at the keyboard:

- Set `P2M_ADMIN_USERNAME` and `P2M_ADMIN_PASSWORD` in `.env`. The account is created at startup if none exists. They never overwrite an existing account, so they can stay.
- Run `docker compose exec postgres2mcp bun src/bin.ts reset-password <username>` on the server. It creates the account if it does not exist, and is also the way back in when a password is lost.

After signing in, the dashboard opens on a short guide: create a key, add the server to your MCP client with the command it gives you, and watch the first call arrive.

## The database

### The database role

postgres2mcp can only do what the role in the connection string can do, so that role is the real limit on every client. Tools that should not write run in read-only transactions, and that is tested against the known ways around it; a role that cannot write is a guarantee.

For a server that only reads:

```sql
CREATE ROLE mcp LOGIN PASSWORD 'choose-a-long-one';
GRANT CONNECT ON DATABASE app TO mcp;
GRANT pg_read_all_data TO mcp;   -- Postgres 14+: SELECT on every table and view
GRANT pg_monitor TO mcp;         -- optional: lets the monitoring tools see all activity and sizes
```

To expose only some of it, grant per schema or per table instead of `pg_read_all_data`:

```sql
GRANT USAGE ON SCHEMA public TO mcp;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp;   -- tables created later
```

Give it write privileges only if you intend to hand some client `execute_sql` or a custom tool with writes allowed.

### Connection strings

- `sslmode=require` encrypts the connection without demanding a CA bundle, as it does for `psql`, so strings copied from hosted providers work as given. `sslmode=verify-full` also verifies the certificate, and `sslrootcert=system` means the same.
- Where a provider offers both a direct connection and a transaction pooler, use the direct one. postgres2mcp keeps a small pool of its own (five connections).
- A password with characters such as `@`, `/` or `#` has to be percent-encoded in the string (`@` is `%40`).

### A database on the same machine

Inside a container, `localhost` is the container. If the connection string names `localhost` or `127.0.0.1`, the installer rewrites the host to `host.docker.internal`, which Docker points at the machine itself.

On Linux, Postgres must also accept that connection, because it now arrives from Docker's network rather than from localhost:

```conf
# postgresql.conf
listen_addresses = 'localhost,172.17.0.1'      # the Docker bridge; '*' also works

# pg_hba.conf
host  all  mcp  172.16.0.0/12  scram-sha-256   # Docker's private ranges
```

Reload Postgres (`sudo systemctl reload postgresql`; a changed `listen_addresses` needs a restart), then run the installer again. On macOS with Docker Desktop no change is needed.

If the database is another container, put both on one Docker network and use the container's name as the host.

## Without the installer

Docker Compose publishes port 3333 on `127.0.0.1` by default. Set `P2M_BIND` explicitly if another interface is needed; use TLS for public access.

The installer is a convenience over Docker Compose; everything it does can be done by hand.

```sh
git clone https://github.com/Railcode-HQ/postgres2mcp
cd postgres2mcp
```

Write a `.env` next to `docker-compose.yml`. Single quotes keep Compose from interpreting `$` in a password:

```sh
DATABASE_URL='postgres://user:password@host:5432/dbname'
P2M_SETUP_TOKEN='a-long-random-string'        # openssl rand -hex 16
```

and, for a domain with HTTPS, add:

```sh
P2M_DOMAIN='mcp.example.com'
P2M_PUBLIC_URL='https://mcp.example.com'
COMPOSE_PROFILES='tls'                        # starts Caddy as well
P2M_BIND='127.0.0.1'                          # port 3333 stays off the public interface
```

Then:

```sh
docker compose up -d
docker compose logs postgres2mcp              # the startup banner, with the setup link
```

Point the DNS record at the machine before starting with the `tls` profile, so that Caddy's first attempt at a certificate succeeds.

With plain `docker run`, without Compose or Caddy:

```sh
docker build -t postgres2mcp .
docker run -d --name postgres2mcp --restart unless-stopped \
  -p 3333:3333 -v postgres2mcp-data:/data \
  -e DATABASE_URL='postgres://user:password@host:5432/dbname' \
  -e P2M_SETUP_TOKEN='a-long-random-string' \
  postgres2mcp
```

Or with no Docker at all, under [Bun](https://bun.sh) 1.3+: `bun install && bun run build:web`, then `DATABASE_URL=… bun start` under whatever keeps processes running on your machine. State goes to `./data` unless `P2M_DATA_DIR` says otherwise.

## Behind your own reverse proxy

If the machine already runs nginx, Traefik or Caddy, install without a domain and let that proxy terminate TLS. In `.env`:

```sh
P2M_BIND='127.0.0.1'                          # only the proxy can reach the port
P2M_PUBLIC_URL='https://mcp.example.com'      # so the dashboard shows the right endpoint
```

The proxy needs nothing special beyond passing requests through; responses on `/mcp` can be a short event stream, so do not buffer them.

nginx:

```nginx
server {
    server_name mcp.example.com;
    listen 443 ssl;
    # ssl_certificate … (certbot, or however this server gets its certificates)

    location / {
        proxy_pass http://127.0.0.1:3333;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}
```

Caddy:

```caddy
mcp.example.com {
    reverse_proxy 127.0.0.1:3333
}
```

## Day to day

All of these run in the install directory (`cd ~/postgres2mcp`).

| | |
|---|---|
| Follow the logs | `docker compose logs -f` |
| Is it up? | `curl https://mcp.example.com/api/health` answers `{"ok":true,"version":"…","database":true}` |
| Update | run the installer again, or `git pull && docker compose up -d --build` |
| Change a setting | edit `.env`, then `docker compose up -d` |
| Restart | `docker compose restart` |
| Stop | `docker compose down` (data is kept) |
| Reset a password | `docker compose exec postgres2mcp bun src/bin.ts reset-password <username>` |

**Settings** are the variables in `.env`; the [README](../README.md#configuration) lists them. Row caps, the statement timeout and log retention are there.

**Back up** the one volume that matters. Everything postgres2mcp knows (accounts, keys, tools, settings, logs) is a SQLite file in it:

```sh
docker run --rm -v postgres2mcp_postgres2mcp-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/postgres2mcp-data.tar.gz -C /data .
```

and keep a copy of `.env`. Nothing is stored in the database you expose.

**Restore or move** to another machine: run the installer there, stop the server (`docker compose down`), unpack the archive into the volume, and start it again:

```sh
docker run --rm -v postgres2mcp_postgres2mcp-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/postgres2mcp-data.tar.gz -C /data'
docker compose up -d
```

API keys keep working, since their hashes moved with the data; clients only need the new address if it changed.

**Remove it**:

```sh
./install.sh --uninstall                       # stops it; data and settings stay
docker compose --profile tls down --volumes   # also deletes the data and the certificate
```

## When something is wrong

**The installer waits for DNS forever.** It shows what the name currently resolves to. "no record" means the record does not exist yet or has not spread; an address that is not your machine's means the record points elsewhere, or a proxy such as Cloudflare's is in front (see [DNS and the certificate](#dns-and-the-certificate)). Check from anywhere with `dig +short mcp.example.com`.

**HTTPS does not come up.** `docker compose logs caddy` says why. The usual reasons are a firewall on ports 80 or 443, DNS that still points elsewhere, or the Let's Encrypt rate limit after several failed attempts (wait an hour). Caddy keeps retrying; nothing needs restarting once the cause is fixed.

**"Port 80 is already in use".** Another web server holds it. Stop it, or keep it and follow [Behind your own reverse proxy](#behind-your-own-reverse-proxy).

**The database did not answer.** The installer prints what Postgres said. `ECONNREFUSED` or a timeout is the network: the host, the port, a firewall, or an allow-list at a hosted provider that does not include this machine's address. `password authentication failed` and `no pg_hba.conf entry` are the credentials and the server's access rules. For a database on the same machine, see [above](#a-database-on-the-same-machine). The server runs either way and connects as soon as the database is reachable; the dashboard shows the state in its sidebar.

**The setup link says the code is wrong.** Use the newest link in `docker compose logs postgres2mcp`. An explicit `P2M_SETUP_TOKEN` in `.env` stays stable; without it, the server generates a new code each time it starts.

**Locked out of the dashboard.** `docker compose exec postgres2mcp bun src/bin.ts reset-password <username>`.

**"docker compose" is not a command.** The machine has the old `docker-compose` v1. Install the Compose plugin: <https://docs.docker.com/compose/install/linux/>.

## Before you call it done

- [ ] The dashboard is on HTTPS, and port 3333 is not reachable from outside (`P2M_BIND=127.0.0.1`, which the installer sets when there is a domain).
- [ ] The admin password is long and not used elsewhere.
- [ ] The database role can do no more than you want any client to do.
- [ ] Each client has its own key, with the narrowest access that works. `execute_sql`, the `admin` group and `authoring` are deliberate choices, not defaults.
- [ ] The data volume is in your backups.

# Self-hosting SearXNG for easy-websearch

Running your own SearXNG instance gives you an unlimited, key-free engine in
the pool. Requirements are small: any machine that can run Docker (512 MB RAM
is plenty) and is reachable from the machine running the skill.

## 1. Deploy SearXNG

Minimal `docker-compose.yml`:

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    container_name: searxng
    ports:
      - "8080:8080"
    volumes:
      - ./searxng:/etc/searxng:rw
    environment:
      - SEARXNG_BASE_URL=http://localhost:8080/
    restart: unless-stopped
```

Start it: `docker compose up -d`

## 2. Configure the instance (two hard requirements)

Create `./searxng/settings.yml`:

```yaml
use_default_settings: true

server:
  secret_key: "change-me-to-a-random-string"   # required by SearXNG
  limiter: false                               # API use → disable bot protection

search:
  formats:
    - html
    - json                                     # REQUIRED for the skill
```

Then restart: `docker compose restart`

| Setting | Why |
|---|---|
| `search.formats` must include `json` | The skill queries `/search?q=…&format=json`. Without it the instance returns 403 and doctor/search reports: `SearXNG rejected JSON — add 'json' to search.formats in settings.yml` |
| `server.limiter: false` | The limiter treats non-browser clients (our JSON client) as bots and blocks them. For a private instance this is safe; do **not** disable it on a public instance |
| `server.secret_key` | SearXNG refuses to start without one |

## 3. Point the skill at it

```bash
export SEARXNG_BASE_URL=http://localhost:8080
```

The `searxng` engine joins the pool automatically (doctor shows it OK once
reachable). `--lang zh` / `--lang en` map to SearXNG's `language` parameter.

## 3.1 Remote server deployment (VPS / LAN server)

Everything above works unchanged on a Linux server. Differences from
localhost:

- **Bind / firewall**: either publish `8080` and restrict it in the cloud
  firewall to your own IP, or bind to `127.0.0.1:8080` and expose through a
  reverse proxy (Caddy example below). Never leave an unauthenticated
  instance open to the internet — it will be abused and your server IP will
  get rate-limited by upstream engines.
- **Caddy with basic auth** (optional but recommended for public IPs):

  ```caddyfile
  searx.example.com {
      basic_auth {
          you $2a$14$<bcrypt-hash>
      }
      reverse_proxy 127.0.0.1:8080
  }
  ```

  Then the skill URL carries the credentials:
  `SEARXNG_BASE_URL=https://you:pass@searx.example.com` (the Node runtime
  passes basic-auth URLs through; the Python runtime needs the credentials
  in the URL too — both send them via the standard Authorization header).

- **Mainland-China servers**: SearXNG aggregates Google/Bing/DDG upstreams;
  from a CN server those are unreachable and SearXNG returns empty results.
  Options: (a) give SearXNG an outgoing proxy in `settings.yml`:

  ```yaml
  outgoing:
    proxies:
      http: http://127.0.0.1:7890
      https: http://127.0.0.1:7890
  ```

  (b) run the instance on a server outside CN, or (c) skip SearXNG on CN
  servers — the skill's built-in `baidu`/`bing` engines already cover CN
  networks without any proxy.

## 4. Network notes (common gotchas)

- **Local instance + `HTTPS_PROXY`**: the skill's Node runtime only proxies
  HTTPS requests, so an `http://localhost:8080` instance is reached directly.
  The Python runtime honors `http_proxy` — make sure `no_proxy` covers your
  instance host (e.g. `no_proxy=localhost,127.0.0.1`), otherwise urllib sends
  the request through the proxy and fails.
- **Instance on another LAN host**: use `http://<lan-ip>:8080` and add that IP
  to `no_proxy` if a proxy is configured.
- **Public instance?** Don't disable the limiter on an internet-facing
  instance; easy-websearch also works against public instances that have JSON
  enabled, but they are often rate-limited.

## 5. Verify

```bash
curl "http://localhost:8080/search?q=test&format=json" | head -c 300   # should return JSON
node scripts/doctor.mjs                                                # searxng row: OK
node scripts/search.mjs "webgpu" --engine searxng -n 3
```

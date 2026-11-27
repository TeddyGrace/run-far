# Routing service (OSRM)

Snaps Routes-tab runs to real streets and trails. It runs as a **second service in the same
Railway project** as the API and is reached only over Railway's private network. Coverage is
**New York State**.

The map is downloaded and prepared when the service **builds**, so a running instance only
loads its prepared files and starts in seconds.

## One-time setup in Railway

1. In the run-far project: **+ New → GitHub Repo →** this repo. Name the service `osrm`.
2. In the new service's **Settings**:
   - **Config as Code / Railway Config File:** `/infra/osrm/railway.toml`.
     Without this, the service reads the repo-root `railway.toml` and builds the API instead.
   - Leave **Root Directory** empty (repo root). The Dockerfile copies `infra/osrm/start.sh`
     relative to that.
   - Don't generate a public domain. Only the API talks to this service.
3. In the new service's **Variables**: `PORT=5000`.
4. Deploy. The first build downloads New York State (~a few hundred MB) and prepares it,
   which takes several minutes. The deploy goes live once the healthcheck (a real walking
   route in Midtown Manhattan) answers.
5. On the **API** service's **Variables**:

   ```
   ROUTING_URL=http://osrm.railway.internal:5000/route/v1/foot
   ```

   If you named the service something other than `osrm`, use that name. Leave
   `ROUTING_API_KEY` unset; the private network needs no key.

Check it worked: in the app, draw a route in New York. Points should snap to paths and the
API logs should show no routing errors.

## Memory

These are rough figures; watch the service's metrics after the first deploy.

- **Build:** a few GB while preparing New York State. If the build runs out of memory,
  preparation can move to GitHub Actions instead. Say so and it can be set up.
- **Running:** roughly 1–2 GB.

## Keeping the map fresh

OpenStreetMap changes daily, and this service only picks changes up when it **rebuilds**.
Restarting or redeploying the same build reuses the old map. To refresh, trigger a new build
(for example, push any change under `infra/osrm/`). Monthly is plenty.

## Covering more area

Change `OSM_EXTRACT_URL` in the `Dockerfile` to a bigger Geofabrik extract and expect memory
to grow with it. Routes outside the covered area fail with "No runnable path connects those
points".

## Networking note

Railway's private DNS can resolve service names to IPv6 only (older environments), so
`start.sh` listens on `::` when the container has IPv6. If that fails, it falls back to IPv4 and
logs a `WARNING`. If the API can't reach this service, check the deploy logs for that line.

## Testing locally

```sh
docker build -f infra/osrm/Dockerfile -t runfar-osrm .   # from the repo root
docker run -p 5000:5000 -e PORT=5000 runfar-osrm
curl 'http://localhost:5000/route/v1/foot/-73.9855,40.7580;-73.9832,40.7536?overview=false'
```

Then point a local API at it with `ROUTING_URL=http://localhost:5000/route/v1/foot`.
`OSM_EXTRACT_URL` is a build arg, so a smaller extract makes local builds quick.

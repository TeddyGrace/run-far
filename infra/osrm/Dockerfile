# Walking/running route server for the Routes tab — a separate Railway service in the same
# project as the API, reached over the private network. See infra/osrm/README.md.
#
# The map is prepared at build time, so a deploy is self-contained and starts in seconds;
# refreshing the map means rebuilding this service, never touching the API.

# Docker Hub's last OSRM tag. Newer releases are published only to ghcr.io; the route API the
# app uses (/route/v1) is unchanged across them, so moving up is a one-line change here.
ARG OSRM_IMAGE=osrm/osrm-backend:v5.25.0

FROM ${OSRM_IMAGE} AS build
# Geofabrik's daily New York State extract. To cover more area, point this at a bigger
# extract (a merged multi-state file, or the whole US) and give the service more memory.
ARG OSM_EXTRACT_URL=https://download.geofabrik.de/north-america/us/new-york-latest.osm.pbf
ADD ${OSM_EXTRACT_URL} /data/region.osm.pbf
# foot.lua: OSRM's walking profile — sidewalks, footpaths, trails, parks; no motorways; and
# one-way streets don't constrain a runner. MLD (multi-level Dijkstra) preprocesses faster and
# with less memory than CH, at a small per-query cost that doesn't matter at this scale.
RUN osrm-extract -p /opt/foot.lua /data/region.osm.pbf \
 && osrm-partition /data/region.osrm \
 && osrm-customize /data/region.osrm \
 && rm /data/region.osm.pbf

FROM ${OSRM_IMAGE}
COPY --from=build /data /data
COPY infra/osrm/start.sh /usr/local/bin/start-osrm
EXPOSE 5000
# PORT is set on the Railway service (5000) so the API's ROUTING_URL has a fixed port.
CMD ["/usr/local/bin/start-osrm"]

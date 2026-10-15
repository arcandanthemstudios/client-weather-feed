/** Data minimization for public Pages files; not an anonymity or history-erasure mechanism. */
const OMIT = new Set([
  'latitude', 'longitude', 'lat', 'lon', 'coordinates', 'requested_coordinates',
  'sampled_coordinates', 'returned_coordinates', 'requested_target', 'source_url',
  'url', 'final_url', 'request_url', 'raw_response', 'capture', 'attempts'
]);
export function publicView(value) {
  if (Array.isArray(value)) return value.map(publicView);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (OMIT.has(key)) continue;
    if (key === 'target') {
      out.target = { label: 'Configured forecast target', spatial_metadata_published: false,
        postal_polygon_verified: item?.postal_polygon_verified === true };
    } else if (key === 'schema' && typeof item === 'string') {
      // Public schema naming is independent of backward-compatible internal schemas.
      out.schema = item.replace(/^philly-/, 'client-');
    } else {
      out[key] = publicView(item);
    }
  }
  return out;
}

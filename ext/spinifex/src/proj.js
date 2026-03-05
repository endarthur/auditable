// Projection registration helper

export function registerProj(code, def) {
  proj4.defs(code, def);
  ol.proj.proj4.register(proj4);
}

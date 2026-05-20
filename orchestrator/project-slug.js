/**
 * Sugere slug de projeto a partir de nome legível.
 * @param {string} name
 * @returns {string}
 */
export function suggestSlugFromName(name) {
  if (typeof name !== "string") return "";
  let s = name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  s = s.replace(/[\s_]+/g, "-");
  s = s.replace(/[^a-z0-9-]+/g, "");
  s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s;
}

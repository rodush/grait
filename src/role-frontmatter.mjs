import { parse } from "yaml";

const roleProfileMarker = /^# grait:role-profile:(?:start|end)(?=\r?$)/gm;
const roleProfileBlock =
  /^# grait:role-profile:start\r?\n[\s\S]*?^# grait:role-profile:end(?=\r?$)/m;
const frontmatter = /^(---(\r?\n))([\s\S]*?)(\r?\n---)(?=\r?\n|$)/;

export function managedRoleFrontmatter(content) {
  const markers = content.match(roleProfileMarker);
  if (!markers) return undefined;
  const match = content.match(frontmatter)?.[3].match(roleProfileBlock);
  if (markers.length !== 2 || !match)
    throw new Error("Malformed or duplicate GRAIT managed role profile");
  return match[0];
}

export function applyRoleFrontmatter(content, fields) {
  const managed = managedRoleFrontmatter(content);
  if (!managed && !Object.keys(fields).length) return content;
  const header = content.match(frontmatter);
  if (!header) return content;

  const [original, opening, newline, yaml, closing] = header;
  const unmanaged = managed ? yaml.replace(`${newline}${managed}`, "") : yaml;
  const settings = parse(unmanaged) ?? {};
  const overrides = Object.entries(fields).filter(([key]) => !Object.hasOwn(settings, key));
  const lines = overrides.length
    ? [
        "",
        "# grait:role-profile:start",
        ...overrides.map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
        "# grait:role-profile:end",
      ].join(newline)
    : "";
  return opening + unmanaged + lines + closing + content.slice(original.length);
}

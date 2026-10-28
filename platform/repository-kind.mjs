// One explicit capability discriminator. It never guesses a format from filenames.
import fs from "node:fs";
import path from "node:path";
import { checked, readPrivate } from "./vault.mjs";
const profiles = {
  "moonrestore-repository-v1\n": { format: 1, encrypted: false },
  "moonrestore-encrypted-repository-v2\n": { format: 2, encrypted: true },
  "moonrestore-repository-v3\n": { format: 3, encrypted: false },
  "moonrestore-encrypted-repository-v3\n": { format: 3, encrypted: true },
  "moonrestore-paged-repository-v4\n": { format: 4, encrypted: false },
  "moonrestore-paged-encrypted-v4\n": { format: 4, encrypted: true },
  "moonrestore-fidelity-repository-v5\n": { format: 5, encrypted: false },
  "moonrestore-fidelity-encrypted-v5\n": { format: 5, encrypted: true },
};
export function repositoryKind(repository) {
  const root = checked(repository),
    s = fs.lstatSync(root);
  if (!s.isDirectory()) throw new Error("Repository directory required");
  const magic = readPrivate(path.join(root, "moonrestore"), 128).toString();
  if (!Object.hasOwn(profiles, magic))
    throw new Error("Unsupported repository format");
  return {
    ...profiles[magic],
    paged: profiles[magic].format >= 4,
    physical_independence_verified: false,
  };
}

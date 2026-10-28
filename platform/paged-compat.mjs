// Explicit format adapter: no pretend legacy Host and no silent catalog truncation.
import { repositoryKind } from "./repository-kind.mjs";
import { runEngine } from "./engine-client.mjs";
import { options } from "./maintenance.mjs";
export async function pagedCompat(args, opts = {}) {
  const [command, repository, ...rest] = args;
  if (
    ![
      "backup",
      "plan",
      "verify",
      "audit",
      "list",
      "restore",
      "restore-resumable",
      "status",
    ].includes(command) ||
    !repository
  )
    return null;
  if (!repositoryKind(repository).paged) return null;
  if (command === "backup" || command === "plan") {
    const { positionals: p, values: v } = options(rest, ["label", "exclude"]);
    if (p.length !== 1 || (command === "plan" && v.label !== undefined))
      throw new Error("Invalid paged source arguments");
    return runEngine(
      command,
      {
        repository,
        source: p[0],
        ...(command === "backup" ? { label: v.label ?? "" } : {}),
        excludes: v.exclude ?? [],
      },
      opts,
    );
  }
  if (command === "verify" || command === "audit") {
    if (rest.length > 1)
      throw new Error("Invalid paged verification arguments");
    return runEngine(command, { repository, snapshot: rest[0] ?? "all" }, opts);
  }
  if (command === "list" || command === "status") {
    if (rest.length) throw new Error("Invalid paged inventory arguments");
    return runEngine("inventory", { repository }, opts);
  }
  const { positionals: p, values: v } = options(
    rest,
    ["prefix", "permissions", "metadata"],
    ["permissions"],
  );
  if (p.length !== 2) throw new Error("Invalid paged restore arguments");
  const request = {
    repository,
    snapshot: p[0],
    target: p[1],
    prefix: v.prefix ?? "",
    restoreModes:
      v.permissions === true || opts.env?.MOONRESTORE_RESTORE_MODES === "1",
    ...(v.metadata ? { metadataMode: v.metadata } : {}),
  };
  if (command === "restore-resumable") {
    const op = await runEngine(
      "restore-create",
      {
        repository,
        snapshot: p[0],
        target: p[1],
        selections: v.prefix ? [v.prefix] : [],
        permissions: request.restoreModes,
        ...(v.metadata ? { metadataMode: v.metadata } : {}),
        confirmation: p[1],
      },
      opts,
    );
    return runEngine("restore-run", { repository, id: op.operation }, opts);
  }
  const preview = await runEngine("restore-preview", request, opts);
  return runEngine(
    "restore",
    { ...request, confirmation: preview.confirmation },
    opts,
  );
}

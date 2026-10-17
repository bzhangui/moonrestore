// Bounded path-style S3 adapter. No delete API; no credential strings in reports.
import { createHash, createHmac } from "node:crypto";
import { activity, checkpoint } from "./activity.mjs";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const hmac = (key, text) => createHmac("sha256", key).update(text).digest();
const encode = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
export function signS3Request({
  method,
  url,
  region,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  body = Buffer.alloc(0),
  headers = {},
  date = new Date(),
}) {
  const u = new URL(url),
    stamp = date.toISOString().replace(/[:-]|\.\d{3}/g, ""),
    day = stamp.slice(0, 8);
  const signed = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k.toLowerCase(),
      String(v).trim().replace(/\s+/g, " "),
    ]),
  );
  signed.host = u.host;
  signed["x-amz-date"] = stamp;
  signed["x-amz-content-sha256"] = sha(body);
  if (sessionToken) signed["x-amz-security-token"] = sessionToken;
  const keys = Object.keys(signed).sort(),
    names = keys.join(";");
  const query = [...u.searchParams]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort((a, b) =>
      a[0] < b[0]
        ? -1
        : a[0] > b[0]
          ? 1
          : a[1] < b[1]
            ? -1
            : a[1] > b[1]
              ? 1
              : 0,
    )
    .map(([k, v]) => k + "=" + v)
    .join("&");
  const canonical = [
    method,
    u.pathname,
    query,
    keys.map((k) => k + ":" + signed[k] + "\n").join(""),
    names,
    sha(body),
  ].join("\n");
  const scope = day + "/" + region + "/s3/aws4_request";
  const key = hmac(
    hmac(hmac(hmac("AWS4" + secretAccessKey, day), region), "s3"),
    "aws4_request",
  );
  const signature = hmac(
    key,
    ["AWS4-HMAC-SHA256", stamp, scope, sha(canonical)].join("\n"),
  ).toString("hex");
  return {
    ...signed,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${names},Signature=${signature}`,
  };
}
export class S3Backend {
  constructor({
    endpoint,
    bucket,
    region = "us-east-1",
    accessKeyId,
    secretAccessKey,
    sessionToken,
    allowRemote = false,
    timeoutMs = 10000,
    totalMs = 1800000,
    retentionDays = 0,
    allowRetention = false,
  }) {
    const u = new URL(endpoint),
      local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (
      typeof allowRemote !== "boolean" ||
      typeof allowRetention !== "boolean" ||
      !["https:", "http:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/" ||
      (!local && (!allowRemote || u.protocol !== "https:")) ||
      (u.protocol === "https:" &&
        process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    )
      throw new Error(
        "S3 endpoint requires explicit remote permission and verified HTTPS",
      );
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      bucket.includes("..") ||
      !/^[a-z0-9-]{1,63}$/.test(region) ||
      typeof accessKeyId !== "string" ||
      !/^[A-Za-z0-9_-]{3,128}$/.test(accessKeyId) ||
      typeof secretAccessKey !== "string" ||
      !/^[\x21-\x7e]{16,256}$/.test(secretAccessKey) ||
      (sessionToken !== undefined &&
        (typeof sessionToken !== "string" ||
          !/^[\x21-\x7e]{1,8192}$/.test(sessionToken)))
    )
      throw new Error("Invalid S3 configuration or credentials");
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 30000 ||
      !Number.isInteger(totalMs) ||
      totalMs < 100 ||
      totalMs > 86400000 ||
      !Number.isInteger(retentionDays) ||
      retentionDays < 0 ||
      retentionDays > 3650 ||
      (retentionDays > 0 && !allowRetention)
    )
      throw new Error("Invalid S3 budgets or retention authorization");
    this.config = {
      endpoint: u.origin,
      bucket,
      region,
      accessKeyId,
      secretAccessKey,
      sessionToken,
    };
    this.timeoutMs = timeoutMs;
    this.deadline = Date.now() + totalMs;
    this.retainUntil = retentionDays
      ? new Date(Date.now() + retentionDays * 86400000).toISOString()
      : null;
  }
  async request(
    method,
    key,
    body = Buffer.alloc(0),
    { headers = {}, version } = {},
  ) {
    checkpoint("s3_" + method.toLowerCase());
    if (
      !["GET", "PUT"].includes(method) ||
      typeof key !== "string" ||
      key.length > 1024 ||
      !/^[A-Za-z0-9._/-]+$/.test(key) ||
      key.split("/").some((p) => !p || p === "." || p === "..") ||
      body.length > 33554496
    )
      throw new Error("Invalid S3 object key or budget");
    if (
      version !== undefined &&
      (typeof version !== "string" ||
        !/^[A-Za-z0-9._~+\/=:-]{1,1024}$/.test(version))
    )
      throw new Error("Invalid S3 version ID");
    const u = new URL(
      this.config.endpoint +
        "/" +
        this.config.bucket +
        "/" +
        key.split("/").map(encode).join("/"),
    );
    if (version) u.searchParams.set("versionId", version);
    const remaining = Math.min(this.timeoutMs, this.deadline - Date.now());
    if (remaining <= 0) throw new Error("S3 total deadline");
    const signals = [AbortSignal.timeout(remaining)];
    if (activity()?.signal) signals.push(activity().signal);
    try {
      const response = await fetch(u, {
        method,
        headers: signS3Request({
          ...this.config,
          method,
          url: u.href,
          body,
          headers,
        }),
        ...(method === "PUT" ? { body } : {}),
        redirect: "error",
        signal: AbortSignal.any(signals),
      });
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body || []) {
        size += chunk.length;
        if (size > 33554496) throw new Error();
        chunks.push(chunk);
      }
      return {
        status: response.status,
        headers: response.headers,
        bytes: Buffer.concat(chunks),
      };
    } catch {
      throw new Error(
        "S3 request failed, timed out or exceeded its budget (details hidden)",
      );
    }
  }
  async get(key, { version, checksum } = {}) {
    const response = await this.request("GET", key, Buffer.alloc(0), {
      version,
    });
    if (
      response.status !== 200 ||
      (checksum && sha(response.bytes) !== checksum)
    )
      throw new Error("S3 readback rejected or checksum mismatch");
    return response;
  }
  async putImmutable(key, bytes) {
    const checksum = sha(bytes),
      headers = {
        "if-none-match": "*",
        "x-amz-checksum-sha256": Buffer.from(checksum, "hex").toString(
          "base64",
        ),
      };
    if (this.retainUntil) {
      headers["x-amz-object-lock-mode"] = "COMPLIANCE";
      headers["x-amz-object-lock-retain-until-date"] = this.retainUntil;
    }
    const result = await this.request("PUT", key, bytes, { headers });
    if (![200, 201, 412].includes(result.status))
      throw new Error("S3 conditional upload rejected; no overwrite fallback");
    const read = await this.get(key, { checksum }),
      version = read.headers.get("x-amz-version-id");
    if (
      this.retainUntil &&
      (!version ||
        version === "null" ||
        read.headers.get("x-amz-object-lock-mode") !== "COMPLIANCE" ||
        !(
          Date.parse(read.headers.get("x-amz-object-lock-retain-until-date")) >=
          Date.parse(this.retainUntil)
        ))
    )
      throw new Error(
        "S3 required retention/version was not reported; cannot claim protection",
      );
    return {
      checksum,
      size: String(bytes.length),
      ...(version && version !== "null" ? { version } : {}),
      server_retention_reported: !!this.retainUntil,
    };
  }
}

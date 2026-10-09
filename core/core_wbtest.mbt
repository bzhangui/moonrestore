///|
test "SHA256 standard vectors and incremental blocks" {
  assert_eq(digest(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  assert_eq(digest(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  let hash = Hasher::new()
  hash.update(b"a")
  hash.update(b"bc")
  assert_eq(hash.finish(), digest(b"abc"))
}

///|
test "stream boundaries do not change CDC boundaries" {
  let cfg : ChunkConfig = { min_size: 64, average_size: 128, max_size: 512 }
  let bytes = Bytes::from_array(Array::makei(10000, fn(i) { (i * 73 + i / 29).to_byte() }))
  let whole = chunk(bytes, config=cfg)
  for block in [1, 7, 64, 211, 1024] {
    let stream = Chunker::new(config=cfg)
    let actual : Array[Bytes] = []
    let mut start = 0
    while start < bytes.length() {
      let end = (start + block).min(bytes.length())
      actual.append(stream.push(bytes[start:end].to_owned()))
      start = end
    }
    if stream.finish() is Some(tail) { actual.push(tail) }
    assert_eq(actual, whole)
    assert_eq(stream.finish(), None)
  }
  assert_eq(whole.fold(init=0, fn(n,b) { n + b.length() }), bytes.length())
}

///|
test "chunk bounds zero and repetitive data" {
  let cfg : ChunkConfig = { min_size: 64, average_size: 128, max_size: 512 }
  assert_eq(chunk(b"", config=cfg).length(), 0)
  for n in [1, 63, 64, 511, 512, 513, 10000] {
    let data = Bytes::from_array(Array::make(n, b'\x00'))
    let parts = chunk(data, config=cfg)
    for i = 0; i < parts.length(); i = i + 1 {
      assert_true(parts[i].length() <= cfg.max_size)
      if i != parts.length() - 1 { assert_true(parts[i].length() >= cfg.min_size) }
    }
    assert_eq(parts.fold(init=0, fn(sum,p) { sum + p.length() }), n)
  }
}

///|
test "configuration validation rejects bad and unbounded sizes" {
  for cfg in [
    { min_size: 0, average_size: 128, max_size: 512 },
    { min_size: 256, average_size: 128, max_size: 512 },
    { min_size: 64, average_size: 129, max_size: 512 },
    { min_size: 64, average_size: 128, max_size: 1048577 },
  ] {
    expect_error(fn() raise { cfg.validate() })
  }
}

///|
test "portable path validation" {
  for path in ["资料/论文.md", "code/main.mbt", ".gitignore", "a/b/c", "COM10.txt"] {
    validate_path(path)
  }
  for path in ["", "/etc/passwd", "../a", "a/../b", "a//b", "a\\b", "C:/a",
    "a:b", "CON", "NUL.txt", "com1.TXT", "LPT9", "a.", "a ", "a\n", "a/?"] {
    expect_error(fn() raise { validate_path(path) })
  }
}

///|
fn sample() -> Snapshot {
  { format: 1, created: "2026-10-09T00:00:00Z", label: "sample",
    config: ChunkConfig::default(), entries: [
      { path: "data", kind: "dir", size: 0L, hash: "", chunks: [] },
      { path: "data/hello.txt", kind: "file", size: 3L, hash: digest(b"abc"),
        chunks: [{id: digest(b"abc"), size: 3}] },
      { path: "empty", kind: "file", size: 0L, hash: digest(b""), chunks: [] },
    ] }
}

///|
test "manifest roundtrip and SHA tamper rejection" {
  let text = sample().encode()
  assert_eq(decode_snapshot(text, text_digest(text)), sample())
  expect_error(fn() raise { decode_snapshot(text + " ", text_digest(text)) })
  expect_error(fn() raise { decode_snapshot(text, "../bad") })
  expect_error(fn() raise { decode_snapshot("not json", text_digest("not json")) })
}

///|
test "manifest rejects duplicates case collisions and missing parent" {
  let s = sample()
  for entry in [s.entries[0], {..s.entries[0], path: "DATA"},
    {..s.entries[1], path: "missing/hello.txt"},
    {..s.entries[1], path: "empty/hello.txt"},
    {..s.entries[1], path: "../hello"}] {
    let entries = s.entries.copy()
    entries.push(entry)
    expect_error(fn() raise { Snapshot::{..s, entries}.validate() })
  }
}

///|
test "manifest rejects hashes sizes kinds formats and limits" {
  let s = sample()
  expect_error(fn() raise { Snapshot::{..s, format: 2}.validate() })
  for e in [{..s.entries[1], size: -1L}, {..s.entries[1], size: 4L},
    {..s.entries[1], hash: "bad"}, {..s.entries[1], kind: "link"},
    {..s.entries[0], size: 1L}, {..s.entries[2], hash: digest(b"a")},
    {..s.entries[1], chunks: [{id: digest(b"abc"), size: 0}]}] {
    expect_error(fn() raise { Snapshot::{..s, entries: [s.entries[0], e]}.validate() })
  }
  expect_error(fn() raise { s.validate(limits={..Limits::default(), max_files: 1}) })
  expect_error(fn() raise { s.validate(limits={..Limits::default(), max_total_bytes: 2L}) })
  expect_error(fn() raise { s.validate(limits={..Limits::default(), max_chunks: 0}) })
}

///|
test "object corruption wrong size and empty" {
  let part : ChunkRef = {id: digest(b"abc"), size: 3}
  verify_chunk(part, b"abc")
  expect_error(fn() raise { verify_chunk(part, b"abd") })
  expect_error(fn() raise { verify_chunk(part, b"ab") })
  expect_error(fn() raise { verify_chunk(part, b"") })
}

///|
test "snapshot diff deterministic and complete" {
  let before = sample()
  let after : Snapshot = {..before, entries: [before.entries[0],
    {..before.entries[1], hash: digest(b"xyz"), chunks: [{id: digest(b"xyz"), size: 3}]},
    {..before.entries[2], path: "new.txt"}]}
  assert_eq(diff(before, after), [
    {path: "data/hello.txt", change: "modified"},
    {path: "empty", change: "removed"},
    {path: "new.txt", change: "added"},
  ])
  assert_eq(diff(before, before), [])
}

///|
fn[X] expect_error(run : () -> X raise) -> Unit raise {
  try run() catch { _ => () } noraise { _ => fail("expected rejection") }
}

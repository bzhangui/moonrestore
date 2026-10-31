///|
/// Platform-independent use of the backup model and integrity API.
fn main {
  try {
    let bytes = b"Hello MoonRestore!"
    let pieces = @backup.chunk(bytes)
    let references : Array[@backup.ChunkRef] = pieces.map(fn(part) {
      { id: @backup.digest(part), size: part.length(), }
    })
    for i = 0; i < pieces.length(); i = i + 1 {
      @backup.verify_chunk(references[i], pieces[i])
    }
    let snapshot : @backup.Snapshot = {
      format: 1,
      created: "2026-10-09T00:00:00Z",
      label: "portable-example",
      config: @backup.ChunkConfig::default(),
      entries: [
        {
          path: "hello.txt",
          kind: "file",
          size: bytes.length().to_int64(),
          hash: @backup.digest(bytes),
          chunks: references,
        },
      ],
    }
    let text = snapshot.encode()
    let id = @backup.text_digest(text)
    ignore(@backup.decode_snapshot(text, id))
    // New 0.6 source-only APIs: observed evidence is snapshot-bound and a
    // discontinuous clock never grants an automatic retry or cleanup window.
    assert_eq(@backup.evidence_state(id, id, 100L, 110L, 20L), 1)
    assert_eq(@backup.evidence_state(id, "other", 100L, 110L, 20L), 3)
    assert_true(@backup.schedule_due(true, false, 0, 3, 100L, 110L, 105L, 20L))
    assert_false(@backup.schedule_due(true, false, 0, 3, 100L, 99L, 105L, 20L))
    // 0.11 recovery plans verify an uncheckpointed crash-ahead prefix.
    let writer = @backup.RestoreWriter::new(8L, 3L, 2L, false, false, None)
    let first = writer.chunk(4)
    assert_eq(first.verify, 3)
    assert_eq(first.writes[0].start, 3L)
    ignore(writer.chunk(4))
    writer.finish()
    // 0.12 owns page boundaries and acknowledged page-chain progress.
    let pages = @backup.PagedWriter::new()
    assert_false(pages.needs_page(100))
    pages.record(
      { kind: "file", path: "sample", id: "", size: 18L, pack: "", offset: 0, },
      100,
    )
    pages.seal_page(@backup.text_digest("page"))
    assert_eq(pages.summary().pages, 1)
    let gc = @backup.GCPlanner::new(1, 2, 1)
    assert_true(gc.select(100L))
    assert_false(gc.select(200L))
    assert_eq(gc.finish().selected, 1)
    println("snapshot=\{id}; chunks=\{pieces.length()}; verified=true")
  } catch {
    e => abort("example failed: \{e}")
  }
}

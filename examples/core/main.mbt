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
    println("snapshot=\{id}; chunks=\{pieces.length()}; verified=true")
  } catch {
    e => abort("example failed: \{e}")
  }
}

///|
extern "js" fn report_error(message : String) -> Unit =
  #| message => { console.error(JSON.stringify({ok: false, error: message, staging: globalThis.__moonrestore_host.restore?.stage ?? null})); process.exitCode = 1; }

///|
fn main {
  @app.run(@env.args().iter().drop(2).collect()) catch {
    e => report_error(e.to_string())
  }
}

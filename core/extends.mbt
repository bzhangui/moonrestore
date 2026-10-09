///|
pub extend BackupError with Eq::{equal, not_equal}

///|
pub extend Limits with Eq::{equal, not_equal}

///|
pub extend Limits with ToJson::{to_json}

///|
pub extend Limits with @json.FromJson::{from_json}

///|
pub extend ChunkConfig with Eq::{equal, not_equal}

///|
pub extend ChunkConfig with ToJson::{to_json}

///|
pub extend ChunkConfig with @json.FromJson::{from_json}

///|
pub extend ChunkRef with Eq::{equal, not_equal}

///|
pub extend ChunkRef with ToJson::{to_json}

///|
pub extend ChunkRef with @json.FromJson::{from_json}

///|
pub extend Entry with Eq::{equal, not_equal}

///|
pub extend Entry with ToJson::{to_json}

///|
pub extend Entry with @json.FromJson::{from_json}

///|
pub extend Snapshot with Eq::{equal, not_equal}

///|
pub extend Snapshot with ToJson::{to_json}

///|
pub extend Snapshot with @json.FromJson::{from_json}

///|
pub extend Change with Eq::{equal, not_equal}

///|
pub extend Change with ToJson::{to_json}

///|
pub extend BackupError with @debug.Debug::{to_repr}

///|
pub extend Limits with @debug.Debug::{to_repr}

///|
pub extend ChunkConfig with @debug.Debug::{to_repr}

///|
pub extend ChunkRef with @debug.Debug::{to_repr}

///|
pub extend Entry with @debug.Debug::{to_repr}

///|
pub extend Snapshot with @debug.Debug::{to_repr}

///|
pub extend Change with @debug.Debug::{to_repr}

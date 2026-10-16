///|
pub(all) struct RetentionRecord {
  id : String
  created : String
}

///|
fn decimal(text : String) -> Int32 raise BackupError {
  let mut value = 0
  guard text.length() > 0 && text.length() <= 4 else {
    raise Invalid("invalid calendar number")
  }
  for c in text {
    guard c >= '0' && c <= '9' else { raise Invalid("invalid calendar number") }
    value = value * 10 + c.to_int() - '0'.to_int()
  }
  value
}

///|
fn calendar_day(created : String) -> Int32 raise BackupError {
  guard created.length() == 24 &&
    created[4] == '-' &&
    created[7] == '-' &&
    created[10] == 'T' &&
    created[13] == ':' &&
    created[16] == ':' &&
    created[19] == '.' &&
    created[23] == 'Z' else {
    raise Invalid("canonical UTC creation time required")
  }
  let year = decimal(created[0:4].to_owned())
  let month = decimal(created[5:7].to_owned())
  let day = decimal(created[8:10].to_owned())
  guard year >= 1970 &&
    month >= 1 &&
    month <= 12 &&
    decimal(created[11:13].to_owned()) < 24 &&
    decimal(created[14:16].to_owned()) < 60 &&
    decimal(created[17:19].to_owned()) < 60 else {
    raise Invalid("invalid UTC date")
  }
  ignore(decimal(created[20:23].to_owned()))
  let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
  let months = [
    31,
    if leap {
      29
    } else {
      28
    },
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  guard day >= 1 && day <= months[month - 1] else {
    raise Invalid("invalid UTC day")
  }
  let previous = year - 1
  let mut ordinal = previous * 365 +
    previous / 4 -
    previous / 100 +
    previous / 400
  for i = 0; i < month - 1; i = i + 1 {
    ordinal += months[i]
  }
  ordinal + day
}

///|
/// Pure policy: latest N distinct occupied day/week/month buckets, unioned with
/// latest snapshots and protected IDs. No filesystem writes or deletion here.
pub fn retention_keep(
  records : Array[RetentionRecord],
  keep_last : Int32,
  daily : Int32,
  weekly : Int32,
  monthly : Int32,
  protected_ids : Array[String],
) -> Array[String] raise BackupError {
  guard records.length() <= 100000 &&
    keep_last >= 1 &&
    keep_last <= 100000 &&
    daily >= 0 &&
    daily <= 36500 &&
    weekly >= 0 &&
    weekly <= 5200 &&
    monthly >= 0 &&
    monthly <= 1200 else {
    raise Invalid("invalid retention policy")
  }
  let seen : Map[String, Bool] = Map([])
  for record in records {
    guard valid_id(record.id) && !seen.contains(record.id) else {
      raise Invalid("invalid/duplicate retention ID")
    }
    ignore(calendar_day(record.created))
    seen[record.id] = true
  }
  for id in protected_ids {
    guard seen.contains(id) else {
      raise Invalid("protected snapshot not found")
    }
  }
  let ordered = records.map(fn(record) { record })
  ordered.sort_by(fn(a, b) {
    let order = a.created.compare(b.created)
    if order == 0 {
      b.id.compare(a.id)
    } else {
      0 - order
    }
  })
  let days : Map[Int32, Bool] = Map([])
  let weeks : Map[Int32, Bool] = Map([])
  let months : Map[String, Bool] = Map([])
  let kept : Array[String] = []
  for index, record in ordered {
    let ordinal = calendar_day(record.created)
    let week = (ordinal - 1) / 7 // Gregorian day 1 was Monday.
    let month = record.created[0:7].to_owned()
    let mut retain = index < keep_last || protected_ids.contains(record.id)
    if !days.contains(ordinal) && days.length() < daily {
      days[ordinal] = true
      retain = true
    }
    if !weeks.contains(week) && weeks.length() < weekly {
      weeks[week] = true
      retain = true
    }
    if !months.contains(month) && months.length() < monthly {
      months[month] = true
      retain = true
    }
    if retain {
      kept.push(record.id)
    }
  }
  kept
}

///|
/// 0 sufficient, 1 insufficient, 2 crosses configured free-space reserve.
pub fn capacity_state(
  required : Int64,
  available : Int64,
  reserve : Int64,
) -> Int32 raise BackupError {
  guard required >= 0L && available >= 0L && reserve >= 0L else {
    raise Invalid("negative capacity")
  }
  if required > available {
    1
  } else if available - required < reserve {
    2
  } else {
    0
  }
}

///|
/// 0 accepted, 1 unexpected empty source, 2 source entry drop beyond policy.
pub fn source_change_state(
  current : Int32,
  previous : Int32,
  allow_empty : Bool,
  max_drop_percent : Int32,
) -> Int32 raise BackupError {
  guard current >= 0 &&
    previous >= 0 &&
    max_drop_percent >= 1 &&
    max_drop_percent <= 100 else {
    raise Invalid("invalid source change budget")
  }
  if current == 0 && !allow_empty {
    1
  } else if previous > 0 &&
    current.to_int64() * 100L <
    previous.to_int64() * (100 - max_drop_percent).to_int64() {
    2
  } else {
    0
  }
}

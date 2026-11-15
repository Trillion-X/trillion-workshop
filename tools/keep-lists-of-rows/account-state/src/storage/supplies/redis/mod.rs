// src/storage/supplies/redis/mod.rs
//
// Purpose: The Redis-protocol `Backend` for the shared key-value supply. One implementation serves every server that
// speaks the Redis protocol with Lua scripting: Redis, Valkey, Dragonfly and Upstash.
//
// Non-Negotiable Invariants:
// - The keyspace is two keys of the store name: a hash (key to value) and a sorted set whose members are the keys, all
//   with score 0, so the server's lexicographic range is byte order. A range and its values, and a guarded batch, are
//   each one script, therefore one round trip and one atomic step on the server.
// - A batch is atomic for every reader: scripts run to completion before any other command.
// - The two keys carry the store name in a hash tag (`{ns}`), so both live in one slot on a clustered server.
//
// Key Concepts:
// - `Redis::connect(url, store_name)`: connects, loads the two scripts once.
//
// Security Considerations:
// - Credentials, if any, are part of the caller's URL and are never logged or returned by `place`.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::kv::{Ask, Atomicity, Backend, Entries, Fetched, Limits, Outcome, Write};
use local_engine::storage::{Error, Result};
use redis::{Client, Connection, Script};
use std::{cell::Cell, cell::RefCell};

/// Keys and ranges in one atomic step: ARGV is the number of keys, the keys, the number of ranges, then per range its
/// lower end, whether it has an upper end, the upper end, whether it walks in reverse, its limit and whether it
/// returns values. The answer is the keys' values (false: absent) followed by one flat name/value list per range.
const READ: &str = r#"
local out = {}
local values = {}
local n = tonumber(ARGV[1])
for i = 1, n do values[i] = redis.call('HGET', KEYS[1], ARGV[1 + i]) end
out[1] = values
local at = 3 + n
for _ = 1, tonumber(ARGV[2 + n]) do
  local lo = '[' .. ARGV[at]
  local hi = '+'
  if ARGV[at + 1] == '1' then hi = '(' .. ARGV[at + 2] end
  local names
  if ARGV[at + 3] == '1' then
    names = redis.call('ZRANGE', KEYS[2], hi, lo, 'BYLEX', 'REV', 'LIMIT', 0, ARGV[at + 4])
  else
    names = redis.call('ZRANGE', KEYS[2], lo, hi, 'BYLEX', 'LIMIT', 0, ARGV[at + 4])
  end
  local flat = {}
  for _, name in ipairs(names) do
    flat[#flat + 1] = name
    if ARGV[at + 5] == '1' then flat[#flat + 1] = redis.call('HGET', KEYS[1], name) else flat[#flat + 1] = '' end
  end
  out[#out + 1] = flat
  at = at + 6
end
return out
"#;

const APPLY: &str = r#"
local current = redis.call('HGET', KEYS[1], ARGV[1])
if ARGV[2] == '1' then
  if current ~= ARGV[3] then return 0 end
elseif current then
  return 0
end
for i = 4, #ARGV, 3 do
  if ARGV[i] == 'S' then
    redis.call('HSET', KEYS[1], ARGV[i + 1], ARGV[i + 2])
    redis.call('ZADD', KEYS[2], 0, ARGV[i + 1])
  else
    redis.call('HDEL', KEYS[1], ARGV[i + 1])
    redis.call('ZREM', KEYS[2], ARGV[i + 1])
  end
end
return 1
"#;

pub struct Redis {
    conn: RefCell<Connection>,
    hash: String,
    ordered: String,
    read: Script,
    apply: Script,
    rounds: Cell<u64>,
    place: String,
}

#[track_caller]
fn failure(_: redis::RedisError) -> Error {
    local_engine::cause!(caller: Error::Unavailable)
}

impl Redis {
    /// Connect to `url` (`redis://host:port`) and use the keys of `store_name`.
    pub fn connect(url: &str, store_name: &str) -> Result<Self> {
        let client = Client::open(url).map_err(|_| local_engine::cause!(Error::Invalid))?;
        let mut conn = client.get_connection().map_err(|error| failure(error))?;
        let read = Script::new(READ);
        let apply = Script::new(APPLY);
        read.prepare_invoke().load(&mut conn).map_err(|error| failure(error))?;
        apply.prepare_invoke().load(&mut conn).map_err(|error| failure(error))?;
        let host = url.rsplit('@').next().unwrap_or(url).to_owned();
        Ok(Self {
            conn: RefCell::new(conn),
            hash: format!("d:{{{store_name}}}"),
            ordered: format!("z:{{{store_name}}}"),
            read,
            apply,
            rounds: Cell::new(3),
            place: format!("{host} store_name={store_name}"),
        })
    }

    fn round(&self) {
        self.rounds.set(self.rounds.get() + 1);
    }
}

impl Backend for Redis {
    fn atomicity(&self) -> Atomicity {
        Atomicity::Full
    }

    fn limits(&self) -> Limits {
        Limits { max_key: 64 * 1024, max_value: 512 * 1024 * 1024, max_writes: usize::MAX / 2 }
    }

    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.round();
        redis::cmd("HGET").arg(&self.hash).arg(key).query(&mut *self.conn.borrow_mut()).map_err(|error| failure(error))
    }

    fn get_many(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        self.round();
        let mut command = redis::cmd("HMGET");
        command.arg(&self.hash);
        for key in keys {
            command.arg(key.as_slice());
        }
        command.query(&mut *self.conn.borrow_mut()).map_err(|error| failure(error))
    }

    fn range(&self, lo: &[u8], hi: Option<&[u8]>, reverse: bool, limit: usize, values: bool) -> Result<Entries> {
        let ask = Ask { lo: lo.to_vec(), hi: hi.map(<[u8]>::to_vec), reverse, limit, values };
        self.read_many(&[], std::slice::from_ref(&ask))?.1.pop().ok_or(local_engine::cause!(Error::Unavailable))
    }

    /// The keys and every range in one script, so in one round trip and one atomic step.
    fn read_many(&self, keys: &[Vec<u8>], asks: &[Ask]) -> Result<Fetched> {
        self.round();
        let mut call = self.read.key(&self.hash);
        call.key(&self.ordered).arg(keys.len());
        for key in keys {
            call.arg(key.as_slice());
        }
        call.arg(asks.len());
        for ask in asks {
            call.arg(ask.lo.as_slice())
                .arg(if ask.hi.is_some() { "1" } else { "0" })
                .arg(ask.hi.as_deref().unwrap_or(&[]))
                .arg(if ask.reverse { "1" } else { "0" })
                .arg(ask.limit.min(i64::MAX as usize))
                .arg(if ask.values { "1" } else { "0" });
        }
        let mut answered: Vec<Vec<Option<Vec<u8>>>> = call.invoke(&mut *self.conn.borrow_mut()).map_err(|error| failure(error))?;
        if answered.len() != asks.len() + 1 {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        let ranges = answered.split_off(1).into_iter().map(|flat| {
            let mut flat = flat.into_iter();
            let mut entries = Vec::new();
            while let (Some(Some(key)), Some(value)) = (flat.next(), flat.next()) {
                entries.push((key, value.unwrap_or_default()));
            }
            entries
        });
        Ok((answered.pop().unwrap_or_default(), ranges.collect()))
    }

    fn apply(&self, guard: (&[u8], Option<&[u8]>), writes: &[Write]) -> Result<Outcome> {
        self.round();
        let mut call = self.apply.key(&self.hash);
        call.key(&self.ordered).arg(guard.0).arg(if guard.1.is_some() { "1" } else { "0" }).arg(guard.1.unwrap_or(&[]));
        for write in writes {
            match write {
                Write::Set(key, value) => call.arg("S").arg(key.as_slice()).arg(value.as_slice()),
                Write::Delete(key) => call.arg("D").arg(key.as_slice()).arg(""),
            };
        }
        let applied: i64 = call.invoke(&mut *self.conn.borrow_mut()).map_err(|error| failure(error))?;
        Ok(if applied == 1 { Outcome::Applied } else { Outcome::Refused })
    }

    fn reclaim(&self) -> Result<()> {
        let mut conn = self.conn.borrow_mut();
        self.round();
        let _: String = redis::cmd("BGREWRITEAOF").query(&mut *conn).map_err(|error| failure(error))?;
        for _ in 0..600 {
            self.round();
            let info: String = redis::cmd("INFO").arg("persistence").query(&mut *conn).map_err(|error| failure(error))?;
            if info.contains("aof_rewrite_in_progress:0") {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err(local_engine::cause!(Error::Interrupted))
    }

    fn rounds(&self) -> u64 {
        self.rounds.get()
    }

    fn place(&self) -> String {
        self.place.clone()
    }
}
